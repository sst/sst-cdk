/*
export async function bootstrap() {
}
*/

import * as colors from 'colors/safe';
import { ToolkitInfo, BootstrapSource, Bootstrapper } from '../lib';
import { SdkProvider } from './api/aws-auth';
import { CloudFormationDeployments } from './api/cloudformation-deployments';
import { CloudExecutable } from './api/cxapp/cloud-executable';
import { execProgram } from './api/cxapp/exec';
import { CdkToolkit } from './cdk-toolkit';
import { RequireApproval } from './diff';
import { setLogLevel } from './logging';
import { Command, Configuration } from './settings';

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
  const nonCli = true;
  const source: BootstrapSource = { source: 'default' };
  const bootstrapper = new Bootstrapper(source);
  const bootstrapOptions = {
    toolkitStackName: undefined,
    roleArn: undefined,
    force: true,
  };
  return await cli.bootstrap(
    environmentSpecs,
    bootstrapper,
    bootstrapOptions,
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
 * Deploy all stacks synchronously, used to deploy standard CDK app.
 *
 * @param options CDK options
 *
 * @returns { account, region, status: 'no_resources' | 'unchanged' | 'deployed'  }
 */
export async function deploy(options: Options = {}) {
  const { cli, toolkitStackName } = await initCommandLine(options);
  return await cli.deploy({
    stackNames: options.stackName ? [options.stackName] : [],
    exclusively: true,
    requireApproval: RequireApproval.Never,
    toolkitStackName,
    nonCli: true,
    asyncDeploy: false,
    skipChangeset: false,
  });
}

/**
 * Deploy all stacks in parallel asynchronously, and returns the environment deployed to and progress state.
 *
 * @param options CDK options
 *
 * @returns { account, region, status: 'no_resources' | 'unchanged' | 'deploying'  }
 */
export async function deployAsync(options: Options = {}) {
  process.env.CFN_QUICK_RETRY = 'true';

  const { cli, toolkitStackName } = await initCommandLine(options);
  return await cli.deploy({
    stackNames: options.stackName ? [options.stackName] : [],
    exclusively: true,
    requireApproval: RequireApproval.Never,
    toolkitStackName,
    force: options.force,
    nonCli: true,
    asyncDeploy: true,
    skipChangeset: true,
    cdkOutputPath: options.cdkOutputPath,
  });
}

/**
 * Destroy a single stack exclusively or destroy all stacks synchronously, used to destroy standard CDK app.
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
    nonCli: true,
    asyncDestroy: false,
  });
}

/**
 * Destroy a single stack exclusively or destroy all stacks, and returns destroyed stacks.
 *
 * @param options CDK options
 *
 * @returns { stacks: [{ id, name }] }
 */
export async function destroyAsync(options: Options = { }) {
  process.env.CFN_QUICK_RETRY = 'true';

  const { cli } = await initCommandLine(options);
  return await cli.destroy({
    stackNames: options.stackName ? [options.stackName] : [],
    exclusively: true,
    force: true,
    nonCli: true,
    asyncDestroy: true,
    cdkOutputPath: options.cdkOutputPath,
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

  const argv = {
    app: options.app,
    output: options.output,
    _: [ 'list' ],
  };
  const configuration = new Configuration({
    ...argv,
    _: argv._ as [Command, ...string[]], // TypeScript at its best
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

