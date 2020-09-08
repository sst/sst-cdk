#!/usr/bin/env node
const { execSync } = require('child_process');
const { readFileSync } = require('fs');

// Validate publish name
const package = process.argv[2];
if ( ! package || ! [ 'sst-cdk', 'test-cdk' ].includes(package)) {
  console.log('Usages:');
  console.log('  ./publish-sst.sh sst-cdk');
  console.log('  ./publish-sst.sh test-cdk');
  return;
}

// Generate new version
const cdkVersion = JSON.parse(readFileSync('lerna.json')).version;

const prevForkVersion = execSync(`npm show ${package} version`).toString().trim();
const prevCdkVersion = prevForkVersion.split('-')[0];
const prevRevision = prevForkVersion.split('.').pop();
const revision = prevCdkVersion === cdkVersion
  ? parseInt(prevRevision) + 1
  : 1;

const forkVersion = `${cdkVersion}-rc.${revision}`;

// Tag
if (package === 'sst-cdk') {
  execSync(`git tag v${forkVersion} && git push --tags`);
}

// Publish
execSync(`scripts/align-version.sh`);
execSync(`cd packages/aws-cdk && sed -i '' "s/\\"name\\": \\"aws-cdk\\"/\\"name\\": \\"${package}\\"/g" package.json`);
execSync(`cd packages/aws-cdk && sed -i '' "s/github.com\\/aws\\/aws-cdk/github.com\\/serverless-stack\\/${package}/g" package.json`);
execSync(`cd packages/aws-cdk && sed -i '' "s/\\"version\\": \\"${cdkVersion}\\"/\\"version\\": \\"${forkVersion}\\"/g" package.json`);
execSync(`cd packages/aws-cdk && npm publish --access public`);
execSync(`git reset --hard`);
