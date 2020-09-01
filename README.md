# sst-cdk [![npm](https://img.shields.io/npm/v/sst-cdk)](https://www.npmjs.com/package/sst-cdk)

sst-cdk is a forked version of [AWS CDK](https://aws.amazon.com/cdk/) adapted to support concurrent asynchronous deploys. It's used internally in [SST](https://github.com/serverless-stack/serverless-stack).

- It deploys all the CloudFormation stacks in your CDK app concurrently.
- It returns right after starting the deployment. So you can use a separate process to monitor the progress of the deployed CloudFormation stacks. And not waste CI build minutes just waiting.
- Meant to be used programmatically, not as a CLI.

## Versioning

Versions are kept in sync with AWS CDK releases. With additional updates released as release candidates. For example, `1.61.0-rc.4` is the 4th internal release after merging with AWS CDK `1.61.0`.
