'use strict';

// npm test (repository root): runs tests/**/*.test.js with Node's test runner.
// The product lives in package/ and its dependencies are installed there (cd package; npm ci): they are made
// resolvable from tests/ through NODE_PATH, so the tests need no second copy of them.
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const modules = path.join(root, 'package', 'node_modules');
if (!fs.existsSync(path.join(modules, 'webpack'))) {
  console.error('package/node_modules is missing: run "npm ci" in the package folder first.');
  process.exit(1);
}

const files = fs.readdirSync(path.join(root, 'tests'))
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join('tests', name));
const env = Object.assign({}, process.env, {
  NODE_PATH: [modules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
});
const run = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, env, stdio: 'inherit' });
process.exit(run.status === null ? 1 : run.status);
