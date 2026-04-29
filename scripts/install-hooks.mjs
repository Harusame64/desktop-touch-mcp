#!/usr/bin/env node
import { execSync } from 'node:child_process';

const TARGET = '.githooks';

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

try {
  run('git rev-parse --is-inside-work-tree');
} catch {
  process.exit(0);
}

let current = '';
try {
  current = run('git config --local --get core.hooksPath');
} catch {
  current = '';
}

if (current === TARGET) {
  process.exit(0);
}

execSync(`git config --local core.hooksPath ${TARGET}`, { stdio: 'inherit' });
console.log(`[install-hooks] core.hooksPath set to ${TARGET}`);
