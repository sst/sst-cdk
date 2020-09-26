import * as colors from 'colors/safe';
import { SdkProvider } from './api/aws-auth';
import { CloudFormationDeployments } from './api/cloudformation-deployments';
import { CloudExecutable } from './api/cxapp/cloud-executable';
import { execProgram } from './api/cxapp/exec';
import { ToolkitInfo } from './api/toolkit-info';
import { CdkToolkit } from './cdk-toolkit';
import { RequireApproval } from './diff';
import { setLogLevel } from './logging';
import { Configuration } from './settings';

interface Options {
  // Generic config
  readonly app?: string;
  readonly output?: string;
  readonly verbose?: number;
  readonly noColor?: boolean;
  // Command specific config
  readonly force?: boolean;
  readonly stackName?: string;
  readonly sstCdkOutputPath?: string;
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
export async function sstBootstrap(options: Options = { }) {
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
 * @param options CLI options
 *
 * @returns { stacks: [{ id, name, dependencies }] }
 */
export async function sstList(options: Options = { }) {
  const { cli } = await initCommandLine(options);
  return await cli.list([], {
    nonCli: true,
    sstCdkOutputPath: options.sstCdkOutputPath,
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
export async function sstSynth(options: Options = { }) {
  const { cli } = await initCommandLine(options);
  return await cli.synth([], false, {
    sst: true,
  });
}

/**
 * Deploy all stacks in parallel asynchronously, and returns the environment deployed to and progress state.
 *
 * Used by deploy workflow.
 *
 * @param options CLI options
 *
 * @returns { account, region, status: 'no_resources' | 'unchanged' | 'deploying'  }
 */
export async function sstDeploy(options: Options = {}) {
  process.env.CFN_QUICK_RETRY = 'true';

  const { cli, toolkitStackName } = await initCommandLine({ ...options, verbose: 4 });
  return await cli.deploy({
    stackNames: options.stackName ? [options.stackName] : [],
    exclusively: true,
    requireApproval: RequireApproval.Never,
    toolkitStackName,
    force: options.force,
    sstCdkOutputPath: options.sstCdkOutputPath,
    sstAsyncDeploy: true,
    sstSkipChangeset: true,
  });
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
export async function sstDestroy(options: Options = { }) {
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
  process.env.CFN_QUICK_RETRY = 'true';

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
  process.env.CFN_QUICK_RETRY = 'true';

  const { cli, toolkitStackName } = await initCommandLine();
  return await cli.destroyStatus(sstCdkOutputPath, {
    stackNames: [stackName],
    toolkitStackName,
  });
}

async function initCommandLine(options: Options = { }) {
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

