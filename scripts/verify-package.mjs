#!/usr/bin/env node
// @ts-check
// Verifies the published package is correct: the tarball only contains built artifacts (no
// src/test leakage), then installs that exact tarball into a scratch project and runs the CLI
// through npx as a real consumer would, as a smoke test. Intended to run after `npm run build`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 * @returns {string}
 */
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
  });
}

console.log('Checking tarball contents...');
const dryRunOutput = run('npm', ['pack', '--dry-run', '--json']);
const [packInfo] = JSON.parse(dryRunOutput);
/** @type {string[]} */
const files = packInfo.files.map((/** @type {{ path: string }} */ entry) => entry.path);

const allowedTopLevel = new Set(['package.json', 'README.md', 'LICENSE']);
const unexpected = files.filter((file) => !file.startsWith('build/') && !allowedTopLevel.has(file));
if (unexpected.length > 0) {
  throw new Error(`Unexpected files would be published: ${unexpected.join(', ')}`);
}
for (const required of ['build/cli.js', 'build/index.js', 'build/runner.js', 'build/index.d.ts']) {
  if (!files.includes(required)) {
    throw new Error(`Expected ${required} in the package tarball - did you run "npm run build" first?`);
  }
}
console.log(`OK: ${files.length} files would be published, none of them src/ or test/.`);

console.log('Running consumer smoke test...');
const scratchDir = mkdtempSync(join(tmpdir(), 'side-by-sidekick-smoke-'));
try {
  const tarballName = run('npm', ['pack', '--pack-destination', scratchDir]).trim();
  const tarballPath = join(scratchDir, tarballName);

  const consumerDir = join(scratchDir, 'consumer');
  mkdirSync(consumerDir);
  run('npm', ['init', '--yes'], { cwd: consumerDir });
  run('npm', ['install', tarballPath], { cwd: consumerDir });

  const output = run(
    'npx',
    ['side-by-sidekick', 'node -e "console.log(1)"', 'node -e "console.log(2)"'],
    { cwd: consumerDir },
  );
  if (!output.includes('1') || !output.includes('2') || !/exit 0/.test(output)) {
    throw new Error(`Unexpected smoke test output:\n${output}`);
  }
  console.log('OK: installed the tarball into a scratch project and ran it via npx.');
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}
