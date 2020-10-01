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
  readonly cdkOutputPath?: string;
}

/**
 * Bootstrap and returns the boostrapped environment. Only returns 1 environment.
 *
 * @param options CDK options
 *
 * @returns {
 *    environment: { account, region }
 *  }
 */
export async function bootstrap(options: Options = { }) {
  const { cli } = await initCommandLine(options);
  const environmentSpecs:string[] = [];
  const toolkitStackName = undefined;
  const roleArn = undefined;
  const useNewBootstrapping = false;
  const force = true;
  const nonCli = true;
  return await cli.bootstrap(
    environmentSpecs,
    toolkitStackName,
    roleArn,
    useNewBootstrapping,
    force,
    { },
    nonCli,
    options.cdkOutputPath,
  );
}

/**
 * List all stacks with dependencies.
 *
 * @param options CDK options
 *
 * @returns { stacks: [{ id, name, dependencies }] }
 */
export async function list(options: Options = { }) {
  const { cli } = await initCommandLine(options);
  return await cli.list([], {
    nonCli: true,
    cdkOutputPath: options.cdkOutputPath,
  });
}

/**
 * Synth all stacks, and returns synthesized stacks.
 *
 * @param options CDK options
 *
 * @returns { stacks: [{ id, name }] }
 */
export async function synth(options: Options = { }) {
  const { cli } = await initCommandLine(options);
  return await cli.synth([], false, {
    nonCli: true,
  });
}

/**
 * Deploy all stacks in parallel asynchronously, and returns the environment deployed to and progress state.
 *
 * @param options CDK options
 *
 * @returns { account, region, status: 'no_resources' | 'unchanged' | 'deploying'  }
 */
export async function deploy(options: Options = {}) {
  process.env.CFN_QUICK_RETRY = 'true';

  const { cli, toolkitStackName } = await initCommandLine(options);
  return await cli.deploy({
    stackNames: options.stackName ? [options.stackName] : [],
    exclusively: true,
    requireApproval: RequireApproval.Never,
    toolkitStackName,
    force: options.force,
    cdkOutputPath: options.cdkOutputPath,
    asyncDeploy: true,
    skipChangeset: true,
  });
}

/**
 * Destroy a single stack exclusively or destroy all stacks, and returns destroyed stacks.
 *
 * @param options CDK options
 *
 * @returns { stacks: [{ id, name }] }
 */
export async function destroy(options: Options = { }) {
  process.env.CFN_QUICK_RETRY = 'true';

  const { cli } = await initCommandLine(options);
  return await cli.destroy({
    stackNames: options.stackName ? [options.stackName] : [],
    exclusively: true,
    force: true,
    cdkOutputPath: options.cdkOutputPath,
    asyncDestroy: true,
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

