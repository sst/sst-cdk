#!/bin/bash

if [ "$#" -ne 1 ]; then
    echo "Usage: ./publish-st.sh REVISION_NUMBER"
    exit 0
fi

revision=$1
version=$(node -p "JSON.parse(fs.readFileSync('lerna.json')).version");

# Tag
git tag v$version-st-$revision && git push --tags

# Publish
scripts/align-version.sh
cd packages/aws-cdk
sed -i '' "s/\"name\": \"aws-cdk\"/\"name\": \"@serverless-stack\/aws-cdk\"/g" package.json
sed -i '' "s/\"version\": \"0.0.0\"/\"version\": \"$version-st-$revision\"/g" package.json
npm publish --access public
cd ../..
git reset --hard
