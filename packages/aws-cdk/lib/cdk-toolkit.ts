import * as path from 'path';
import { format } from 'util';
import * as cxschema from '@aws-cdk/cloud-assembly-schema';
import * as cxapi from '@aws-cdk/cx-api';
import * as colors from 'colors/safe';
import * as fs from 'fs-extra';
import * as promptly from 'promptly';
import { environmentsFromDescriptors, globEnvironmentsFromStacks, looksLikeGlob } from '../lib/api/cxapp/environments';
import { bootstrapEnvironment } from './api';
import { SdkProvider } from './api/aws-auth';
import { bootstrapEnvironment2, BootstrappingParameters } from './api/bootstrap';
import { CloudFormationDeployments } from './api/cloudformation-deployments';
import { CloudAssembly, DefaultSelection, ExtendedStackSelection, StackCollection } from './api/cxapp/cloud-assembly';
import { CloudExecutable } from './api/cxapp/cloud-executable';
import { printSecurityDiff, printStackDiff, RequireApproval } from './diff';
import { data, error, highlight, print, success, warning, debug } from './logging';
import { serializeStructure, deserializeStructure } from './serialize';
import { Configuration } from './settings';
import { partition } from './util';

export interface CdkToolkitProps {

  /**
   * The Cloud Executable
   */
  cloudExecutable: CloudExecutable;

  /**
   * The provisioning engine used to apply changes to the cloud
   */
  cloudFormation: CloudFormationDeployments;

  /**
   * Whether to be verbose
   *
   * @default false
   */
  verbose?: boolean;

  /**
   * Don't stop on error metadata
   *
   * @default false
   */
  ignoreErrors?: boolean;

  /**
   * Treat warnings in metadata as errors
   *
   * @default false
   */
  strict?: boolean;

  /**
   * Application configuration (settings and context)
   */
  configuration: Configuration;

  /**
   * AWS object (used by synthesizer and contextprovider)
   */
  sdkProvider: SdkProvider;
}

/**
 * Toolkit logic
 *
 * The toolkit runs the `cloudExecutable` to obtain a cloud assembly and
 * deploys applies them to `cloudFormation`.
 */
export class CdkToolkit {
  constructor(private readonly props: CdkToolkitProps) {
  }

  public async metadata(stackName: string) {
    const stacks = await this.selectSingleStackByName(stackName);
    return stacks.firstStack.manifest.metadata ?? {};
  }

  public async env() {
    return {
      environment: {
        account: (await this.props.sdkProvider.defaultAccount())?.accountId,
        region: this.props.sdkProvider.defaultRegion,
      },
    };
  }

  public async diff(options: DiffOptions): Promise<number> {
    const stacks = await this.selectStacksForDiff(options.stackNames, options.exclusively);

    const strict = !!options.strict;
    const contextLines = options.contextLines || 3;
    const stream = options.stream || process.stderr;

    let diffs = 0;
    if (options.templatePath !== undefined) {
      // Compare single stack against fixed template
      if (stacks.stackCount !== 1) {
        throw new Error('Can only select one stack when comparing to fixed template. Use --exclusively to avoid selecting multiple stacks.');
      }

      if (!await fs.pathExists(options.templatePath)) {
        throw new Error(`There is no file at ${options.templatePath}`);
      }
      const template = deserializeStructure(await fs.readFile(options.templatePath, { encoding: 'UTF-8' }));
      diffs = printStackDiff(template, stacks.firstStack, strict, contextLines, stream);
    } else {
      // Compare N stacks against deployed templates
      for (const stack of stacks.stackArtifacts) {
        stream.write(format('Stack %s\n', colors.bold(stack.displayName)));
        const currentTemplate = await this.props.cloudFormation.readCurrentTemplate(stack);
        diffs += printStackDiff(currentTemplate, stack, strict, contextLines, stream);
      }
    }

    return diffs && options.fail ? 1 : 0;
  }

  public async deploy(options: DeployOptions): Promise<any> {
    let stacks;
    if (options.sstCdkOutputPath) {
      const cxapiAssembly = new cxapi.CloudAssembly(options.sstCdkOutputPath);
      const assembly = new CloudAssembly(cxapiAssembly);
      stacks = await assembly.selectStacks([options.stackNames[0]], {
        extend: ExtendedStackSelection.None,
        defaultBehavior: DefaultSelection.None,
      });
    } else {
      stacks = await this.selectStacksForDeploy(options.stackNames, options.exclusively);
    }

    const requireApproval = options.requireApproval !== undefined ? options.requireApproval : RequireApproval.Broadening;

    const parameterMap: { [name: string]: { [name: string]: string | undefined } } = { '*': {} };
    for (const key in options.parameters) {
      if (options.parameters.hasOwnProperty(key)) {
        const [stack, parameter] = key.split(':', 2);
        if (!parameter) {
          parameterMap['*'][stack] = options.parameters[key];
        } else {
          if (!parameterMap[stack]) {
            parameterMap[stack] = {};
          }
          parameterMap[stack][parameter] = options.parameters[key];
        }
      }
    }

    const stackOutputs: { [key: string]: any } = { };
    const outputsFile = options.outputsFile;
    let asyncResult;

    for (const stack of stacks.stackArtifacts) {
      if (stacks.stackCount !== 1) { highlight(stack.displayName); }
      if (!stack.environment) {
        // eslint-disable-next-line max-len
        throw new Error(`Stack ${stack.displayName} does not define an environment, and AWS credentials could not be obtained from standard locations or no region was configured.`);
      }

      if (Object.keys(stack.template.Resources || {}).length === 0) { // The generated stack has no resources
        if (!await this.props.cloudFormation.stackExists({ stack })) {
          warning('%s: stack has no resources, skipping deployment.', colors.bold(stack.displayName));
        } else {
          warning('%s: stack has no resources, deleting existing stack.', colors.bold(stack.displayName));
          await this.destroy({
            stackNames: [stack.stackName],
            exclusively: true,
            force: true,
            roleArn: options.roleArn,
            fromDeploy: true,
          });
        }
        if (options.sstAsyncDeploy) {
          asyncResult = { status: 'no_resources' };
        }
        continue;
      }

      if (requireApproval !== RequireApproval.Never) {
        const currentTemplate = await this.props.cloudFormation.readCurrentTemplate(stack);
        if (printSecurityDiff(currentTemplate, stack, requireApproval)) {

          // only talk to user if STDIN is a terminal (otherwise, fail)
          if (!process.stdin.isTTY) {
            throw new Error(
              '"--require-approval" is enabled and stack includes security-sensitive updates, ' +
              'but terminal (TTY) is not attached so we are unable to get a confirmation from the user');
          }

          const confirmed = await promptly.confirm('Do you wish to deploy these changes (y/n)?');
          if (!confirmed) { throw new Error('Aborted by user'); }
        }
      }

      print('%s: deploying...', colors.bold(stack.displayName));

      let tags = options.tags;
      if (!tags || tags.length === 0) {
        tags = tagsForStack(stack);
      }

      try {
        const result = await this.props.cloudFormation.deployStack({
          stack,
          deployName: stack.stackName,
          roleArn: options.roleArn,
          toolkitStackName: options.toolkitStackName,
          reuseAssets: options.reuseAssets,
          notificationArns: options.notificationArns,
          tags,
          execute: options.execute,
          force: options.force,
          parameters: Object.assign({}, parameterMap['*'], parameterMap[stack.stackName]),
          usePreviousParameters: options.usePreviousParameters,
          ci: options.ci,
          sstAsyncDeploy: options.sstAsyncDeploy,
          sstSkipChangeset: options.sstSkipChangeset,
        });

        if (options.sstAsyncDeploy) {
          asyncResult = {
            account: (await this.props.sdkProvider.defaultAccount())?.accountId,
            region: this.props.sdkProvider.defaultRegion,
            status: result.noOp ? 'unchanged' : 'deploying',
            outputs: result.outputs,
          };
          continue;
        }

        const message = result.noOp
          ? ' ✅  %s (no changes)'
          : ' ✅  %s';

        success('\n' + message, stack.displayName);

        if (Object.keys(result.outputs).length > 0) {
          print('\nOutputs:');

          stackOutputs[stack.stackName] = result.outputs;
        }

        for (const name of Object.keys(result.outputs)) {
          const value = result.outputs[name];
          print('%s.%s = %s', colors.cyan(stack.id), colors.cyan(name), colors.underline(colors.cyan(value)));
        }

        print('\nStack ARN:');

        data(result.stackArn ?? 'Changeset not generated');
      } catch (e) {
        error('\n ❌  %s failed: %s', colors.bold(stack.displayName), e);
        throw e;
      } finally {
        // If an outputs file has been specified, create the file path and write stack outputs to it once.
        // Outputs are written after all stacks have been deployed. If a stack deployment fails,
        // all of the outputs from successfully deployed stacks before the failure will still be written.
        if (outputsFile) {
          fs.ensureFileSync(outputsFile);
          await fs.writeJson(outputsFile, stackOutputs, {
            spaces: 2,
            encoding: 'utf8',
          });
        }
      }
    }

    if (options.sstAsyncDeploy) {
      return asyncResult;
    }
  }

  public async parallelDeploy(options: DeployOptions, prevStackStates?: StackState[]): Promise<ProgressState> {
    const STACK_DEPLOY_STATUS_PENDING = 'pending';
    const STACK_DEPLOY_STATUS_DEPLOYING = 'deploying';
    const STACK_DEPLOY_STATUS_SUCCEEDED = 'succeeded';
    const STACK_DEPLOY_STATUS_UNCHANGED = 'unchanged';
    const STACK_DEPLOY_STATUS_FAILED = 'failed';
    const STACK_DEPLOY_STATUS_SKIPPED = 'skipped';

    const getStackArtifacts = async (): Promise<cxapi.CloudFormationStackArtifact[]> => {
      let stacks;

      // Get stacks from provided cdk.out
      if (options.sstCdkOutputPath) {
        const cxapiAssembly = new cxapi.CloudAssembly(options.sstCdkOutputPath);
        const assembly = new CloudAssembly(cxapiAssembly);
        stacks = await assembly.selectStacks([], { defaultBehavior: DefaultSelection.AllStacks });
      }
      // Get stacks from default cdk.out
      else {
        stacks = await this.selectStacksForDeployAll();
      }

      return stacks.stackArtifacts;
    };

    const deployStacks = async () => {
      let hasSucceededStack = false;

      const statusesByStackName: { [key: string]: string } = { };
      stackStates.forEach(({ name, status }) => {
        statusesByStackName[name] = status;
      });

      await Promise.all(
        stackStates
          .filter(stackState => stackState.status === STACK_DEPLOY_STATUS_PENDING)
          .filter(stackState => stackState.dependencies.every(dep => ! [
            STACK_DEPLOY_STATUS_PENDING,
            STACK_DEPLOY_STATUS_DEPLOYING,
          ].includes(statusesByStackName[dep])))
          .map(async stackState => {
            try {
              debug('Deploying stack %s', stackState.name);
              options.stackNames = [stackState.name];
              const { status, account, region, outputs } = await this.deploy(options);
              stackState.startedAt = Date.now();
              stackState.account = account;
              stackState.region = region;
              stackState.outputs = outputs;
              debug('Deploying stack %s status: %s', stackState.name, status);

              if (status === 'unchanged') {
                stackState.status = STACK_DEPLOY_STATUS_UNCHANGED;
                stackState.endedAt = stackState.startedAt;
                hasSucceededStack = true;
                success('\n ✅  %s (no changes)\n', stackState.name);
              } else if (status === 'no_resources') {
                stackState.status = STACK_DEPLOY_STATUS_FAILED;
                stackState.endedAt = stackState.startedAt;
                stackState.errorMessage = `The ${stackState.name} stack contains no resources.`;
                skipUndeployedStacks();
                error('\n ❌  %s failed: %s\n', colors.bold(stackState.name), stackState.errorMessage);
              } else if (status === 'deploying') {
                stackState.status = STACK_DEPLOY_STATUS_DEPLOYING;
              } else {
                stackState.status = STACK_DEPLOY_STATUS_FAILED;
                stackState.endedAt = stackState.startedAt;
                stackState.errorMessage = `The ${stackState.name} stack failed to deploy.`;
                skipUndeployedStacks();
                error('\n ❌  %s failed: %s\n', colors.bold(stackState.name), stackState.errorMessage);
              }

            } catch (deployEx) {
              debug('Deploy stack %s exception %s', stackState.name, deployEx);
              if (isRetryableException(deployEx)) { // retry
              } else if (isBootstrapException(deployEx)) {
                try {
                  debug('Bootstraping stack %s', stackState.name);
                  const environmentSpecs:string[] = [];
                  const toolkitStackName = undefined;
                  const roleArn = undefined;
                  const useNewBootstrapping = false;
                  const force = true;
                  const sst = true;
                  await this.bootstrap(
                    environmentSpecs,
                    toolkitStackName,
                    roleArn,
                    useNewBootstrapping,
                    force,
                    { },
                    sst,
                  );
                  debug('Bootstraped stack %s', stackState.name);
                } catch (bootstrapEx) {
                  debug('Bootstrap stack %s exception %s', stackState.name, bootstrapEx);
                  if (isRetryableException(bootstrapEx)) { // retry
                  } else {
                    stackState.status = STACK_DEPLOY_STATUS_FAILED;
                    stackState.startedAt = Date.now();
                    stackState.endedAt = stackState.startedAt;
                    stackState.errorMessage = bootstrapEx.message;
                    skipUndeployedStacks();
                    error('\n ❌  %s failed: %s\n', colors.bold(stackState.name), bootstrapEx);
                  }
                }

              } else {
                stackState.status = STACK_DEPLOY_STATUS_FAILED;
                stackState.startedAt = Date.now();
                stackState.endedAt = stackState.startedAt;
                stackState.errorMessage = deployEx.message;
                skipUndeployedStacks();
                error('\n ❌  %s failed: %s\n', colors.bold(stackState.name), deployEx);
              }
            }
          }),
      );

      if (hasSucceededStack) {
        debug('At least 1 stack successfully deployed, call deployStacks() again');
        await deployStacks();
      }
    };

    const updateDeployStatuses = async () => {
      await Promise.all(
        stackStates
          .filter(stackState => stackState.status === STACK_DEPLOY_STATUS_DEPLOYING)
          .map(async stackState => {
            // Get stack events
            try {
              debug('Fetching stack events %s', stackState.name);
              await getStackEvents(stackState);
            } catch (e) {
              debug('%s', e);
              if (isRetryableException(e)) { // retry
                return;
              }
              // ignore error
            }

            // Get stack status
            try {
              debug('Checking stack status %s', stackState.name);
              const result = await getDeployStatus(stackState);
              stackState.outputs = result.outputs;

              if ( ! result.noOp) {
                stackState.status = STACK_DEPLOY_STATUS_SUCCEEDED;
                stackState.endedAt = Date.now();
                success('\n ✅  %s\n', stackState.name);
              }
            } catch (statusEx) {
              debug('%s', statusEx);
              if (isRetryableException(statusEx)) { // retry
              } else {
                stackState.status = STACK_DEPLOY_STATUS_FAILED;
                stackState.endedAt = Date.now();
                stackState.errorMessage = stackState.eventsLatestErrorMessage || statusEx.message;
                skipUndeployedStacks();
                error('\n ❌  %s failed: %s\n', colors.bold(stackState.name), stackState.errorMessage);
              }
            }
          }),
      );
    };

    const skipUndeployedStacks = () => {
      stackStates
        .filter(stackState => stackState.status === STACK_DEPLOY_STATUS_PENDING)
        .forEach(stackState => { stackState.status = STACK_DEPLOY_STATUS_SKIPPED; });
    };

    const getDeployStatus = async (stackState: StackState): Promise<any> => {
      const parameterMap: { [name: string]: { [name: string]: string | undefined } } = { '*': {} };
      const tags = options.tags;
      return await this.props.cloudFormation.deployStatus({
        stack: stackState.stack,
        deployName: stackState.name,
        roleArn: options.roleArn,
        toolkitStackName: options.toolkitStackName,
        reuseAssets: options.reuseAssets,
        notificationArns: options.notificationArns,
        tags,
        execute: options.execute,
        force: options.force,
        parameters: Object.assign({}, parameterMap['*'], parameterMap[stackState.name]),
        usePreviousParameters: options.usePreviousParameters,
      });
    };

    const getStackEvents = async (stackState: StackState) => {
      // Note: should probably switch to use CDK's built in StackActivity class at some point

      // Stack state props will be modified:
      // - stackState.events
      // - stackState.eventsLatestErrorMessage
      // - stackState.eventsFirstEventAt

      // Get events
      const stackEvents = await this.props.cloudFormation.describeStackEvents(stackState.stack, stackState.name) || [];

      // look through all the stack events and find the first relevant
      // event which is a "Stack" event and has a CREATE, UPDATE or DELETE status
      const firstRelevantEvent = stackEvents.find(event => {
        const isStack = 'AWS::CloudFormation::Stack';
        const updateIsInProgress = 'UPDATE_IN_PROGRESS';
        const createIsInProgress = 'CREATE_IN_PROGRESS';
        const deleteIsInProgress = 'DELETE_IN_PROGRESS';

        return (
          event.ResourceType === isStack &&
          (event.ResourceStatus === updateIsInProgress ||
            event.ResourceStatus === createIsInProgress ||
            event.ResourceStatus === deleteIsInProgress)
        );
      });

      // set the date some time before the first found
      // stack event of recently issued stack modification
      if (firstRelevantEvent) {
        const eventDate = new Date(firstRelevantEvent.Timestamp);
        const updatedDate = eventDate.setSeconds(eventDate.getSeconds() - 5);
        stackState.eventsFirstEventAt = new Date(updatedDate);
      }

      // Loop through stack events
      const events = stackState.events || [];
      stackEvents.reverse().forEach(event => {
        const eventInRange = stackState.eventsFirstEventAt && stackState.eventsFirstEventAt <= event.Timestamp;
        const eventNotLogged = events.every(loggedEvent =>
          loggedEvent.eventId !== event.EventId,
        );
        let eventStatus = event.ResourceStatus;
        if (eventInRange && eventNotLogged) {
          let isFirstError = false;
          // Keep track of first failed event
          if (eventStatus
            && (eventStatus.endsWith('FAILED') || eventStatus.endsWith('ROLLBACK_IN_PROGRESS'))
            && ! stackState.eventsLatestErrorMessage) {
            stackState.eventsLatestErrorMessage = event.ResourceStatusReason;
            isFirstError = true;
          }
          // Print new events
          const color = colorFromStatusResult(event.ResourceStatus);
          print('%s | %s | %s | %s %s',
            stackState.name,
            color(event.ResourceStatus || ''),
            event.ResourceType,
            color(colors.bold(event.LogicalResourceId || '')),
            isFirstError ? colors.red(event.ResourceStatusReason || '') : ''
          );
          // Prepare for next monitoring action
          events.push({
            eventId: event.EventId,
            timestamp: event.Timestamp,
            resourceType: event.ResourceType,
            resourceStatus: event.ResourceStatus,
            resourceStatusReason: event.ResourceStatusReason,
            logicalResourceId: event.LogicalResourceId,
          });
        }
      });
      stackState.events = events;
    };

    const colorFromStatusResult = (status?: string) => {
      if (!status) {
        return colors.reset;
      }

      if (status.indexOf('FAILED') !== -1) {
        return colors.red;
      }
      if (status.indexOf('ROLLBACK') !== -1) {
        return colors.yellow;
      }
      if (status.indexOf('COMPLETE') !== -1) {
        return colors.green;
      }

      return colors.reset;
    }

    const serializeStackStates = () => {
      return stackStates.map(stackState =>
        serializeStructure({ ...stackState, stack: undefined }, false)
      ).join('\n');
    };

    // Initialize stack states
    let stackStates: StackState[];
    // Case: initial call
    if ( ! prevStackStates) {
      const stacks = await getStackArtifacts();
      stackStates = stacks.map(stack => ({
        stack: stack,
        name: stack.stackName,
        status: STACK_DEPLOY_STATUS_PENDING,
        dependencies: stack.dependencies.map(d => d.id),
      }));
    }
    // Case: subsequent call from sstDeploy
    // - prevStackStates is passed in; and
    // - prevStackStates contains 'stack' object
    else if (prevStackStates && prevStackStates.every(stackState => stackState.stack)) {
      stackStates = prevStackStates;
    }
    // Case: subsequent call from sstDeployAsync
    // - prevStackStates is passed in; and
    // - prevStackStates does NOT contain 'stack' object
    else {
      const stacks = await getStackArtifacts();
      stackStates = prevStackStates.map(stackState => {
        const stack = stacks.find(stack => stack.name === stackState.name);
        if (stack) {
          stackState.stack = stack;
        }
        return stackState;
      });
    }

    debug('Initial stack states: %s', serializeStackStates());
    await updateDeployStatuses();
    debug('After update deploy statuses: %s', serializeStackStates());
    await deployStacks();
    debug('After deploy stacks: %s', serializeStackStates());

    const isCompleted = stackStates.every(stackState => ! [
      STACK_DEPLOY_STATUS_PENDING,
      STACK_DEPLOY_STATUS_DEPLOYING,
    ].includes(stackState.status));

    return { stackStates, isCompleted };
  }

  public async destroy(options: DestroyOptions): Promise<any> {
    let stacks;
    if (options.sst && options.sstAsyncDestroy && options.sstCdkOutputPath) {
      const cxapiAssembly = new cxapi.CloudAssembly(options.sstCdkOutputPath);
      const assembly = new CloudAssembly(cxapiAssembly);
      stacks = await assembly.selectStacks([options.stackNames[0]], {
        extend: ExtendedStackSelection.None,
        defaultBehavior: DefaultSelection.None,
      });
    } else if (options.sst && options.stackNames.length === 0) {
      stacks = await this.selectStacksForDestroyAll();
    } else {
      stacks = await this.selectStacksForDestroy(options.stackNames, options.exclusively);
    }

    // The stacks will have been ordered for deployment, so reverse them for deletion.
    stacks = stacks.reversed();

    if (!options.force) {
      // eslint-disable-next-line max-len
      const confirmed = await promptly.confirm(`Are you sure you want to delete: ${colors.blue(stacks.stackArtifacts.map(s => s.id).join(', '))} (y/n)?`);
      if (!confirmed) {
        return;
      }
    }

    const action = options.fromDeploy ? 'deploy' : 'destroy';
    let asyncResult;

    for (const stack of stacks.stackArtifacts) {
      success('%s: destroying...', colors.blue(stack.displayName));
      try {
        const result = await this.props.cloudFormation.destroyStack({
          stack,
          deployName: stack.stackName,
          roleArn: options.roleArn,
          sstAsyncDestroy: options.sstAsyncDestroy,
        });

        if (options.sst && options.sstAsyncDestroy) {
          asyncResult = { status: result.status };
          continue;
        }

        success(`\n ✅  %s: ${action}ed\n`, colors.blue(stack.displayName));
      } catch (e) {
        error(`\n ❌  %s: ${action} failed\n`, colors.blue(stack.displayName), e);
        throw e;
      }
    }

    if (options.sst) {
      if (options.sstAsyncDestroy) {
        return asyncResult;
      } else {
        return {
          stacks: stacks.stackArtifacts.map(stack => ({
            id: stack.id,
            name: stack.stackName,
          })),
        };
      }
    }
  }

  public async list(selectors: string[], options: { long?: boolean, sst?: boolean, sstCdkOutputPath?: string } = { }) {
    let stacks;
    if (options.sstCdkOutputPath) {
      const cxapiAssembly = new cxapi.CloudAssembly(options.sstCdkOutputPath);
      const assembly = new CloudAssembly(cxapiAssembly);
      stacks = await assembly.selectStacks(selectors, { defaultBehavior: DefaultSelection.AllStacks });
    } else {
      stacks = await this.selectStacksForList(selectors);
    }

    // if we are in "long" mode, emit the array as-is (JSON/YAML)
    if (options.long) {
      const long = [];
      for (const stack of stacks.stackArtifacts) {
        long.push({
          id: stack.id,
          name: stack.stackName,
          environment: stack.environment,
        });
      }
      return long; // will be YAML formatted output
    }

    // if we are in "sst" mode, emit the array as-is (JSON/YAML)
    if (options.sst) {
      return {
        stacks: stacks.stackArtifacts.map(stack => ({
          id: stack.id,
          name: stack.stackName,
          dependencies: stack.dependencies.map(d => d.id),
        })),
      };
    }

    // just print stack IDs
    for (const stack of stacks.stackArtifacts) {
      data(stack.id);
    }

    return 0; // exit-code
  }

  public async destroyStatus(sstCdkOutputPath: string, options: DeployOptions) {
    const cxapiAssembly = new cxapi.CloudAssembly(sstCdkOutputPath);
    const assembly = new CloudAssembly(cxapiAssembly);
    const stacks = await assembly.selectStacks([options.stackNames[0]], {
      extend: ExtendedStackSelection.None,
      defaultBehavior: DefaultSelection.None,
    });
    const stack = stacks.firstStack;

    print('%s: checking status...', colors.bold(stack.displayName));

    try {
      const { status } = await this.props.cloudFormation.destroyStatus({
        stack,
        deployName: stack.stackName,
        roleArn: options.roleArn,
      });
      return { status };
    } catch (e) {
      error('\n ❌  %s failed: %s', colors.bold(stack.displayName), e);
      throw e;
    }
  }

  /**
   * Synthesize the given set of stacks (called when the user runs 'cdk synth')
   *
   * INPUT: Stack names can be supplied using a glob filter. If no stacks are
   * given, all stacks from the application are implictly selected.
   *
   * OUTPUT: If more than one stack ends up being selected, an output directory
   * should be supplied, where the templates will be written.
   */
  public async synth(stackNames: string[], exclusively: boolean, options: { sst?: boolean } = { }): Promise<any> {
    const stacks = await this.selectStacksForDiff(stackNames, exclusively);

    // If calling from SST, print status
    if (options.sst) {
      return {
        stacks: stacks.stackArtifacts.map(stack => ({
          id: stack.id,
          name: stack.stackName,
        })),
      };
    }

    // if we have a single stack, print it to STDOUT
    if (stacks.stackCount === 1) {
      return stacks.firstStack.template;
    }

    // This is a slight hack; in integ mode we allow multiple stacks to be synthesized to stdout sequentially.
    // This is to make it so that we can support multi-stack integ test expectations, without so drastically
    // having to change the synthesis format that we have to rerun all integ tests.
    //
    // Because this feature is not useful to consumers (the output is missing
    // the stack names), it's not exposed as a CLI flag. Instead, it's hidden
    // behind an environment variable.
    const isIntegMode = process.env.CDK_INTEG_MODE === '1';
    if (isIntegMode) {
      return stacks.stackArtifacts.map(s => s.template);
    }

    // not outputting template to stdout, let's explain things to the user a little bit...
    success(`Successfully synthesized to ${colors.blue(path.resolve(stacks.assembly.directory))}`);
    print(`Supply a stack id (${stacks.stackArtifacts.map(s => colors.green(s.id)).join(', ')}) to display its template.`);

    return undefined;
  }

  /**
   * Bootstrap the CDK Toolkit stack in the accounts used by the specified stack(s).
   *
   * @param environmentSpecs environment names that need to have toolkit support
   *             provisioned, as a glob filter. If none is provided,
   *             all stacks are implicitly selected.
   * @param toolkitStackName the name to be used for the CDK Toolkit stack.
   */
  public async bootstrap(
    environmentSpecs: string[], toolkitStackName: string | undefined, roleArn: string | undefined,
    useNewBootstrapping: boolean, force: boolean | undefined, props: BootstrappingParameters, sst?: boolean, sstCdkOutputPath?: string): Promise<any> {
    // If there is an '--app' argument and an environment looks like a glob, we
    // select the environments from the app. Otherwise use what the user said.

    // By default glob for everything
    environmentSpecs = environmentSpecs.length > 0 ? environmentSpecs : ['**'];

    // Partition into globs and non-globs (this will mutate environmentSpecs).
    const globSpecs = partition(environmentSpecs, looksLikeGlob);
    if (globSpecs.length > 0 && !this.props.cloudExecutable.hasApp && !sstCdkOutputPath) {
      throw new Error(`'${globSpecs}' is not an environment name. Run in app directory to glob or specify an environment name like \'aws://123456789012/us-east-1\'.`);
    }

    const environments: cxapi.Environment[] = [
      ...environmentsFromDescriptors(environmentSpecs),
    ];

    // If there is an '--app' argument, select the environments from the app.
    if (this.props.cloudExecutable.hasApp) {
      environments.push(...await globEnvironmentsFromStacks(await this.selectStacksForList([]), globSpecs, this.props.sdkProvider));
    }

    // If this is called from Seed workflow
    if (sstCdkOutputPath) {
      const cxapiAssembly = new cxapi.CloudAssembly(sstCdkOutputPath);
      const assembly = new CloudAssembly(cxapiAssembly);
      const stacks = await assembly.selectStacks([], { defaultBehavior: DefaultSelection.AllStacks });
      environments.push(...await globEnvironmentsFromStacks(stacks, globSpecs, this.props.sdkProvider));
    }

    await Promise.all(environments.map(async (environment) => {
      success(' ⏳  Bootstrapping environment %s...', colors.blue(environment.name));
      try {
        const result = await (useNewBootstrapping ? bootstrapEnvironment2 : bootstrapEnvironment)(environment, this.props.sdkProvider, {
          toolkitStackName,
          roleArn,
          force,
          parameters: props,
        });
        const message = result.noOp
          ? ' ✅  Environment %s bootstrapped (no changes).'
          : ' ✅  Environment %s bootstrapped.';
        success(message, colors.blue(environment.name));
      } catch (e) {
        error(' ❌  Environment %s failed bootstrapping: %s', colors.blue(environment.name), e);
        throw e;
      }
    }));

    if (sst) {
      return { environment: environments[0] };
    }
  }

  private async selectStacksForList(selectors: string[]) {
    const assembly = await this.assembly();
    const stacks = await assembly.selectStacks(selectors, { defaultBehavior: DefaultSelection.AllStacks });

    // No validation

    return stacks;
  }

  private async selectStacksForDeploy(stackNames: string[], exclusively?: boolean) {
    const assembly = await this.assembly();
    const stacks = await assembly.selectStacks(stackNames, {
      extend: exclusively ? ExtendedStackSelection.None : ExtendedStackSelection.Upstream,
      defaultBehavior: DefaultSelection.OnlySingle,
    });

    await this.validateStacks(stacks);

    return stacks;
  }

  private async selectStacksForDeployAll() {
    const assembly = await this.assembly();
    const stacks = await assembly.selectStacks([], { defaultBehavior: DefaultSelection.AllStacks });

    await this.validateStacks(stacks);

    return stacks;
  }

  private async selectStacksForDiff(stackNames: string[], exclusively?: boolean) {
    const assembly = await this.assembly();
    const stacks = await assembly.selectStacks(stackNames, {
      extend: exclusively ? ExtendedStackSelection.None : ExtendedStackSelection.Upstream,
      defaultBehavior: DefaultSelection.AllStacks,
    });

    await this.validateStacks(stacks);

    return stacks;
  }

  private async selectStacksForDestroy(stackNames: string[], exclusively?: boolean) {
    const assembly = await this.assembly();
    const stacks = await assembly.selectStacks(stackNames, {
      extend: exclusively ? ExtendedStackSelection.None : ExtendedStackSelection.Downstream,
      defaultBehavior: DefaultSelection.OnlySingle,
    });

    // No validation

    return stacks;
  }

  private async selectStacksForDestroyAll() {
    const assembly = await this.assembly();
    const stacks = await assembly.selectStacks([], { defaultBehavior: DefaultSelection.AllStacks });

    // No validation

    return stacks;
  }

  /**
   * Validate the stacks for errors and warnings according to the CLI's current settings
   */
  private async validateStacks(stacks: StackCollection) {
    stacks.processMetadataMessages({
      ignoreErrors: this.props.ignoreErrors,
      strict: this.props.strict,
      verbose: this.props.verbose,
    });
  }

  /**
   * Select a single stack by its name
   */
  private async selectSingleStackByName(stackName: string) {
    const assembly = await this.assembly();

    const stacks = await assembly.selectStacks([stackName], {
      extend: ExtendedStackSelection.None,
      defaultBehavior: DefaultSelection.None,
    });

    // Could have been a glob so check that we evaluated to exactly one
    if (stacks.stackCount > 1) {
      throw new Error(`This command requires exactly one stack and we matched more than one: ${stacks.stackIds}`);
    }

    return assembly.stackById(stacks.firstStack.id);
  }

  private assembly(): Promise<CloudAssembly> {
    return this.props.cloudExecutable.synthesize();
  }

}

export interface DiffOptions {
  /**
   * Stack names to diff
   */
  stackNames: string[];

  /**
   * Only select the given stack
   *
   * @default false
   */
  exclusively?: boolean;

  /**
   * Used a template from disk instead of from the server
   *
   * @default Use from the server
   */
  templatePath?: string;

  /**
   * Strict diff mode
   *
   * @default false
   */
  strict?: boolean;

  /**
   * How many lines of context to show in the diff
   *
   * @default 3
   */
  contextLines?: number;

  /**
   * Where to write the default
   *
   * @default stderr
   */
  stream?: NodeJS.WritableStream;

  /**
   * Whether to fail with exit code 1 in case of diff
   *
   * @default false
   */
  fail?: boolean;
}

export interface DeployOptions {
  /**
   * Stack names to deploy
   */
  stackNames: string[];

  /**
   * Only select the given stack
   *
   * @default false
   */
  exclusively?: boolean;

  /**
   * Name of the toolkit stack to use/deploy
   *
   * @default CDKToolkit
   */
  toolkitStackName?: string;

  /**
   * Role to pass to CloudFormation for deployment
   */
  roleArn?: string;

  /**
   * ARNs of SNS topics that CloudFormation will notify with stack related events
   */
  notificationArns?: string[];

  /**
   * What kind of security changes require approval
   *
   * @default RequireApproval.Broadening
   */
  requireApproval?: RequireApproval;

  /**
   * Reuse the assets with the given asset IDs
   */
  reuseAssets?: string[];

  /**
   * Tags to pass to CloudFormation for deployment
   */
  tags?: Tag[];

  /**
   * Whether to execute the ChangeSet
   * Not providing `execute` parameter will result in execution of ChangeSet
   * @default true
   */
  execute?: boolean;

  /**
   * Always deploy, even if templates are identical.
   * @default false
   */
  force?: boolean;

  /**
   * Additional parameters for CloudFormation at deploy time
   * @default {}
   */
  parameters?: { [name: string]: string | undefined };

  /**
   * Use previous values for unspecified parameters
   *
   * If not set, all parameters must be specified for every deployment.
   *
   * @default true
   */
  usePreviousParameters?: boolean;

  /**
   * Whether we are on a CI system
   *
   * @default false
   */
  readonly ci?: boolean;

  /**
   * Path to file where stack outputs will be written after a successful deploy as JSON
   * @default - Outputs are not written to any file
   */
  outputsFile?: string;

  /**
   * Whether called from sst cli.
   * @default false
   */
  sst?: boolean;

  /**
   * Path to pre-existing cdk.out
   * @default - cdk.out is auto-generated
   */
  sstCdkOutputPath?: string;

  /**
   * Start deploying and returns right away.
   * @default false
   */
  sstAsyncDeploy?: boolean;

  /**
   * Start deploy without generating and applying changeset.
   * @default false
   */
  sstSkipChangeset?: boolean;
}

export interface DestroyOptions {
  /**
   * The names of the stacks to delete
   */
  stackNames: string[];

  /**
   * Whether to exclude stacks that depend on the stacks to be deleted
   */
  exclusively: boolean;

  /**
   * Whether to skip prompting for confirmation
   */
  force: boolean;

  /**
   * The arn of the IAM role to use
   */
  roleArn?: string;

  /**
   * Whether the destroy request came from a deploy.
   */
  fromDeploy?: boolean

  /**
   * Whether called from sst cli.
   * @default false
   */
  sst?: boolean;

  /**
   * Path to pre-existing cdk.out
   * @default - cdk.out is auto-generated
   */
  sstCdkOutputPath?: string;

  /**
   * Start dpeloying and returns right away.
   * @default false
   */
  sstAsyncDestroy?: boolean;
}

/**
 * @returns an array with the tags available in the stack metadata.
 */
function tagsForStack(stack: cxapi.CloudFormationStackArtifact): Tag[] {
  const tagLists = stack.findMetadataByType(cxschema.ArtifactMetadataEntryType.STACK_TAGS).map(
    // the tags in the cloud assembly are stored differently
    // unfortunately.
    x => toCloudFormationTags(x.data as cxschema.Tag[]));
  return Array.prototype.concat([], ...tagLists);
}

/**
 * Transform tags as they are retrieved from the cloud assembly,
 * to the way that CloudFormation expects them. (Different casing).
 */
function toCloudFormationTags(tags: cxschema.Tag[]): Tag[] {
  return tags.map(t => {
    return { Key: t.key, Value: t.value };
  });
}

export interface Tag {
  readonly Key: string;
  readonly Value: string;
}

function isRetryableException(e: { code?: any, message?: string }) {
  return (e.code === 'ThrottlingException' && e.message === 'Rate exceeded')
    || (e.code === 'Throttling' && e.message === 'Rate exceeded')
    || (e.code === 'TooManyRequestsException' && e.message === 'Too Many Requests')
    || e.code === 'OperationAbortedException'
    || e.code === 'TimeoutError'
    || e.code === 'NetworkingError';
}

function isBootstrapException(e: { message?: string }) {
  return e.message && e.message.startsWith('This stack uses assets, so the toolkit stack must be deployed to the environment');
}

export interface ProgressState {
  isCompleted: boolean;
  stackStates: StackState[];
}

export interface StackState {
  stack: cxapi.CloudFormationStackArtifact;
  name: string;
  status: string;
  dependencies: any[];
  account?: string;
  region?: string;
  startedAt?: number;
  endedAt?: number;
  events?: StackEvent[];
  eventsLatestErrorMessage?: string;
  eventsFirstEventAt?: Date;
  resourceCount?: number;
  resourceDoneCount?: number;
  errorMessage?: string;
  outputs?: Record<string, string>;
}

interface StackEvent {
  eventId: string;
  timestamp: Date;
  resourceType?: string;
  resourceStatus?: string;
  resourceStatusReason?: string;
  logicalResourceId?: string;
}
