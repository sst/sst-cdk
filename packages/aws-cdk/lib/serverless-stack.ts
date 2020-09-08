import * as colors from 'colors/safe';
import { SdkProvider } from './api/aws-auth';
import { CloudFormationDeployments } from './api/cloudformation-deployments';
import { CloudExecutable } from './api/cxapp/cloud-executable';
import { execProgram } from './api/cxapp/exec';
import { ToolkitInfo } from './api/toolkit-info';
import { CdkToolkit, StackState, ProgressState } from './cdk-toolkit';
import { RequireApproval } from './diff';
import { setLogLevel, print } from './logging';
import { Configuration } from './settings';
//import { RewritableBlock } from './api/util/display';

interface CliOption {
  readonly app?: string;
  readonly output?: string;
  readonly verbose?: number;
  readonly noColor?: boolean;
  readonly stackName?: string;
}

/**
 * Get default environment.
 *
 * Used by sst cli.
 *
 * @param options CLI options
 *
 * @returns {
 *    environment: { account, region }
 *  }
 */
export async function sstEnv(options: CliOption = { }) {
  const { cli } = await initCommandLine(options);
  return await cli.env();
}

/**
 * Bootstrap and returns the boostrapped environment. Only returns 1 environment.
 *
 * Used by sst cli.
 *
 * @param options CLI options
 *
 * @returns {
 *    environment: { account, region }
 *  }
 */
export async function sstBootstrap(options: CliOption = { }) {
  const { cli } = await initCommandLine(options);
  const environmentSpecs:string[] = [];
  const toolkitStackName = undefined;
  const roleArn = undefined;
  const useNewBootstrapping = false;
  const force = true;
  const sst = true;
  return await cli.bootstrap(
    environmentSpecs,
    toolkitStackName,
    roleArn,
    useNewBootstrapping,
    force,
    { },
    sst,
  );
}

/**
 * List all stacks with dependencies.
 *
 * Used by deploy workflow.
 *
 * @param sstCdkOutputPath the path to cdk.out folder.
 *
 * @returns { stacks: [{ id, name, dependencies }] }
 */
export async function sstList(sstCdkOutputPath: string) {
  const { cli } = await initCommandLine();
  return await cli.list([], {
    sst: true,
    sstCdkOutputPath,
  });
}

/**
 * Synth all stacks, and returns synthesized stacks.
 *
 * Used by sst cli.
 *
 * @param options CLI options
 *
 * @returns { stacks: [{ id, name }] }
 */
export async function sstSynth(options: CliOption = { }) {
  const { cli } = await initCommandLine(options);
  return await cli.synth([], false, {
    sst: true,
  });
}

/**
 * Deploy a single stack exclusively or deploy all stacks, and returns deployed stacks.
 *
 * Used by sst cli.
 *
 * @param options CLI options
 *
 * @returns { stacks: [{ id, name }] }
 */
export async function sstDeploy(options: CliOption = { }) {
  process.env.ASYNC_INVOCATION = 'true';

  // create rewritable block
  //const isWindows = process.platform === 'win32';
  //const stream = process.stderr;
  //const fancyOutputAvailable = !isWindows && stream.isTTY && !options.ci;
  //const block = new RewritableBlock(stream);

  const { cli, toolkitStackName } = await initCommandLine(options);

  let stackStates: StackState[] | undefined = undefined;
  while (true) {
    const response: ProgressState = await cli.parallelDeploy({
      stackNames: [],
      exclusively: true,
      requireApproval: RequireApproval.Never,
      toolkitStackName,
      sst: true,
      sstAsyncDeploy: true,
      sstSkipChangeset: true,
    }, stackStates);
    stackStates = response.stackStates;

    // Print progress
    //const printProgress = () => {
    //  block.displayLines(['!!! CURRENT TIME !!!', colors.cyan(`${Date.now()}`)]);
    //  stackLogs.push(stacks.length === 1
    //    ? `INFO: Deploying 1 stack...\n`
    //    : `INFO: Deploying ${stacks.length} stacks...\n`);
    //  return stackStates.map(stackState =>
    //    serializeStructure({ ...stackState, stack: undefined }, false)
    //  ).join('\n');
    //}

    if ( response && response.isCompleted) { break; }

    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  // Print output
  stackStates.forEach(stackState => {
    print('\nStack %s', stackState.name);
    if (stackState.status === 'succeeded') {
      print('  Status: deployed');
    }
    else if (stackState.status === 'unchanged') {
      print('  Status: no changes');
    }
    else if (stackState.status === 'failed') {
      print('  Status: failed');
      print('  Error: %s', stackState.errorMessage);
    }
    else if (stackState.status === 'skipped') {
      print('  Status: not deployed');
    }

    if (stackState.outputs && Object.keys(stackState.outputs).length > 0) {
      print('  Outputs:');
      for (const name of Object.keys(stackState.outputs)) {
        const value = stackState.outputs[name];
        print('  - %s: %s', name, value);
      }
    }
  });

  return stackStates && stackStates.map(stackState => ({
    name: stackState.name,
    status: stackState.status,
  }));
}

/**
 * Deploy all stacks in parallel asynchronously, and returns the environment deployed to and progress state.
 *
 * Used by deploy workflow.
 *
 * @param sstCdkOutputPath the path to cdk.out folder.
 * @param force always deploy stack even if templates are identical.
 * @param stackStates stackStates from the previous call.
 *
 * @returns { account, region, status: 'no_resources' | 'unchanged' | 'deploying'  }
 */
export async function sstDeployAsync(sstCdkOutputPath: string, force: boolean, stackStates?: StackState[]) {
  process.env.ASYNC_INVOCATION = 'true';

  const { cli, toolkitStackName } = await initCommandLine({ verbose: 4 });
  return await cli.parallelDeploy({
    stackNames: [],
    exclusively: true,
    requireApproval: RequireApproval.Never,
    toolkitStackName,
    force,
    sst: true,
    sstCdkOutputPath,
    sstAsyncDeploy: true,
    sstSkipChangeset: true,
  }, stackStates);
}

/**
 * Destroy a single stack exclusively or destroy all stacks, and returns destroyed stacks.
 *
 * Used by sst cli.
 *
 * @param options CLI options
 *
 * @returns { stacks: [{ id, name }] }
 */
export async function sstDestroy(options: CliOption = { }) {
  const { cli } = await initCommandLine(options);
  return await cli.destroy({
    stackNames: options.stackName ? [options.stackName] : [],
    exclusively: true,
    force: true,
    sst: true,
  });
}

/**
 * Destroy a single stack asynchronously, and returns destroy status.
 *
 * Used by deploy workflow.
 *
 * @param sstCdkOutputPath the path to cdk.out folder.
 * @param stackName the stack to be destroy.
 *
 * @returns { account, region, status: 'destroying' | 'destroyed'  }
 */
export async function sstDestroyAsync(sstCdkOutputPath: string, stackName: string) {
  process.env.ASYNC_INVOCATION = 'true';

  const { cli } = await initCommandLine();
  return await cli.destroy({
    stackNames: [stackName],
    exclusively: true,
    force: true,
    sst: true,
    sstCdkOutputPath,
    sstAsyncDestroy: true,
  });
}

/**
 * Get asynchronous destroy status.
 *
 * Used by deploy workflow.
 *
 * @param sstCdkOutputPath the path to cdk.out folder.
 * @param stackName the stack to be destroyed.
 *
 * @returns { status: 'destroying' | 'destroyed'  }
 */
export async function sstDestroyStatus(sstCdkOutputPath: string, stackName: string) {
  process.env.ASYNC_INVOCATION = 'true';

  const { cli, toolkitStackName } = await initCommandLine();
  return await cli.destroyStatus(sstCdkOutputPath, {
    stackNames: [stackName],
    toolkitStackName,
  });
}

async function initCommandLine(options: CliOption = { }) {
  // set log level
  if (options.verbose) {
    setLogLevel(options.verbose);
  }

  // set no color
  if (options.noColor) {
    colors.disable();
  }

  const configuration = new Configuration({
    app: options.app,
    output: options.output,
  });
  await configuration.load();

  const sdkProvider = await SdkProvider.withAwsCliCompatibleDefaults({
    profile: configuration.settings.get(['profile']),
  });

  const cloudFormation = new CloudFormationDeployments({ sdkProvider });

  const cloudExecutable = new CloudExecutable({
    configuration,
    sdkProvider,
    synthesizer: execProgram,
  });

  const cli = new CdkToolkit({
    cloudExecutable,
    cloudFormation,
    verbose: options.verbose ? options.verbose > 0 : false,
    configuration,
    sdkProvider,
  });

  const toolkitStackName: string = ToolkitInfo.determineName(configuration.settings.get(['toolkitStackName']));

  return { cli, toolkitStackName };
}

