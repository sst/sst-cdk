import { ToolkitInfo } from '../lib';
import { SdkProvider } from '../lib/api/aws-auth';
import { CloudFormationDeployments } from '../lib/api/cloudformation-deployments';
import { CloudExecutable } from '../lib/api/cxapp/cloud-executable';
import { execProgram } from '../lib/api/cxapp/exec';
import { CdkToolkit } from '../lib/cdk-toolkit';
import { Configuration } from '../lib/settings';

export async function stListStackDependencies(outputPath: string) {
  const { cli } = await initCommandLine();

  return await cli.listStackDependencies(outputPath);
}

export async function stDeployAsync(outputPath: string, stackName: string, force: boolean) {
  const { cli, toolkitStackName } = await initCommandLine();

  return await cli.deployAsync(outputPath, {
    stackNames: [ stackName ],
    force,
    toolkitStackName,
  });
}

export async function stDeployStatus(outputPath: string, stackName: string) {
  const { cli, toolkitStackName } = await initCommandLine();

  return await cli.deployStatus(outputPath, {
    stackNames: [ stackName ],
    toolkitStackName,
  });
}

export async function stDestroyAsync(outputPath: string, stackName: string) {
  const { cli, toolkitStackName } = await initCommandLine();

  return await cli.destroyAsync(outputPath, {
    stackNames: [ stackName ],
    toolkitStackName,
  });
}

export async function stDestroyStatus(outputPath: string, stackName: string) {
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

