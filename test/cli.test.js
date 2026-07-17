// @ts-check
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sequenceCommand } from './helpers.js';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

/**
 * Spawns the CLI with the given command-line arguments and collects its result.
 *
 * @param {string[]} args
 * @returns {{ child: import('node:child_process').ChildProcess, done: Promise<{ code: number|null, signal: NodeJS.Signals|null, stdout: string, stderr: string }> }}
 */
function runCli(args) {
  const child = spawn(process.execPath, [cliPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const done = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

test('prints usage and exits with a nonzero code when no commands are given', async () => {
  const { done } = runCli([]);
  const result = await done;

  assert.equal(result.code, 1);
  assert.match(result.stderr, /usage/i);
  assert.equal(result.stdout, '');
});

test('runs a single successful command end to end', async () => {
  const command = sequenceCommand([{ text: 'hello\n' }], { exitCode: 0 });
  const { done } = runCli([command]);
  const result = await done;

  assert.equal(result.code, 0);
  assert.match(result.stdout, /\[1\/1\]/);
  assert.match(result.stdout, /hello/);
  assert.match(result.stdout, /Summary/);
  assert.match(result.stdout, /Total duration/);
});

test('propagates the exit code of the last failed command', async () => {
  const commandOk = sequenceCommand([], { exitCode: 0 });
  const commandFail = sequenceCommand([], { exitCode: 9 });
  const { done } = runCli([commandOk, commandFail]);
  const result = await done;

  assert.equal(result.code, 9);
  assert.match(result.stdout, /exit 9/);
});

test('SIGINT terminates child processes and exits with code 130', async () => {
  const command = sequenceCommand([
    { text: 'started\n', delayMs: 50 },
    { text: 'should-never-be-seen\n', delayMs: 5000 },
  ]);
  const { child, done } = runCli([command]);

  setTimeout(() => child.kill('SIGINT'), 250);

  const startedAt = Date.now();
  const result = await done;
  const elapsed = Date.now() - startedAt;

  assert.equal(result.code, 130);
  assert.ok(elapsed < 4000, `expected the process tree to be killed quickly, took ${elapsed}ms`);
  assert.doesNotMatch(result.stdout, /should-never-be-seen/);
});
