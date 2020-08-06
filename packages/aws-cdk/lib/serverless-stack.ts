import { ToolkitInfo } from './api/toolkit-info';
import { SdkProvider } from './api/aws-auth';
import { CloudFormationDeployments } from './api/cloudformation-deployments';
import { CloudExecutable } from './api/cxapp/cloud-executable';
import { execProgram } from './api/cxapp/exec';
import { CdkToolkit } from './cdk-toolkit';
import { Configuration } from './settings';
import { RequireApproval } from './diff';

export async function sstEnv() {
  const { cli } = await initCommandLine();
  return await cli.env();
}

/**
 * Bootstrap and returns the boostrapped environment. Only returns 1 environment.
 *
 * Used by sst cli.
 *
 * @returns {
 *    environment: { account, region }
 *  }
 */
export async function sstBootstrap() {
  const { cli } = await initCommandLine();
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
    sst
  );
}

/**
 * List all stacks with dependencies.
 *
 * Used by deploy workflow.
 *
 * @returns { stacks: [{ id, name, dependencies }] }
 */
export async function sstList(outputPath: string) {
  const { cli } = await initCommandLine();
  return await cli.list([], {
    outputPath,
    sst: true,
  });
}

/**
 * Synth all stacks, and returns synthesized stacks.
 *
 * Used by sst cli.
 *
 * @returns { stacks: [{ id, name }] }
 */
export async function sstSynth() {
  const { cli } = await initCommandLine();
  return await cli.synth([], false, {
    sst: true,
  });
}

/**
 * Deploy a single stack exclusively or deploy all stacks, and returns deployed stacks.
 *
 * Used by sst cli.
 *
 * @param stackName the stack to be deploy. All stacks are deployed if not specified.
 *
 * @returns { stacks: [{ id, name }] }
 */
export async function sstDeploy(stackName?: string) {
  const { cli, toolkitStackName } = await initCommandLine();
  return await cli.deploy({
    stackNames: stackName ? [ stackName ] : [],
    exclusively: true,
    requireApproval: RequireApproval.Never,
    toolkitStackName,
    sst: true,
  });
}

/**
 * Destroy a single stack exclusively or destroy all stacks, and returns destroyed stacks.
 *
 * Used by sst cli.
 *
 * @param stackName the stack to be destroyed. All stacks are destroyed if not specified.
 *
 * @returns { stacks: [{ id, name }] }
 */
export async function sstDestroy(stackName?: string) {
  const { cli } = await initCommandLine();
  return await cli.destroy({
    stackNames: stackName ? [ stackName ] : [],
    exclusively: true,
    force: true,
    sst: true,
  });
}

/**
 * Deploy a single stack asynchronously, and returns the environment deployed to and deploy status.
 *
 * Used by deploy workflow.
 *
 * @param outputPath the path to cdk.out folder.
 * @param stackName the stack to be deploy.
 * @param force always deploy stack even if templates are identical.
 *
 * @returns { account, region, status: 'no_resources' | 'unchanged' | 'deploying'  }
 */
export async function sstDeployAsync(outputPath: string, stackName: string, force: boolean) {
  const { cli, toolkitStackName } = await initCommandLine();
  return await cli.deploy({
    stackNames: [ stackName ],
    exclusively: true,
    requireApproval: RequireApproval.Never,
    toolkitStackName,
    force,
    outputPath,
    async: true,
    sst: true,
  });
}

/**
 * Get asynchronous deploy status.
 *
 * Used by deploy workflow.
 *
 * @param outputPath the path to cdk.out folder.
 * @param stackName the stack to be deploy.
 *
 * @returns { status: 'deploying' | 'deployed'  }
 */
export async function sstDeployStatus(outputPath: string, stackName: string) {
  const { cli, toolkitStackName } = await initCommandLine();

  return await cli.deployStatus(outputPath, {
    stackNames: [ stackName ],
    toolkitStackName,
  });
}

/**
 * Destroy a single stack asynchronously, and returns destroy status.
 *
 * Used by deploy workflow.
 *
 * @param outputPath the path to cdk.out folder.
 * @param stackName the stack to be destroy.
 *
 * @returns { account, region, status: 'destroying' | 'destroyed'  }
 */
export async function sstDestroyAsync(outputPath: string, stackName: string) {
  const { cli } = await initCommandLine();
  return await cli.destroy({
    stackNames: [ stackName ],
    exclusively: true,
    force: true,
    outputPath,
    async: true,
    sst: true,
  });
}

/**
 * Get asynchronous destroy status.
 *
 * Used by deploy workflow.
 *
 * @param outputPath the path to cdk.out folder.
 * @param stackName the stack to be destroyed.
 *
 * @returns { status: 'destroying' | 'destroyed'  }
 */
export async function sstDestroyStatus(outputPath: string, stackName: string) {
  const { cli, toolkitStackName } = await initCommandLine();

  return await cli.destroyStatus(outputPath, {
    stackNames: [ stackName ],
    toolkitStackName,
  });
}

async function initCommandLine() {
  const configuration = new Configuration();
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
    configuration,
    sdkProvider,
  });

  const toolkitStackName: string = ToolkitInfo.determineName(configuration.settings.get(['toolkitStackName']));

  return { cli, toolkitStackName };
}

