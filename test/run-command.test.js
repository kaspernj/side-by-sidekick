// @ts-check
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {setImmediate as waitForImmediate} from 'node:timers/promises';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {runCommandWithDependencies} from '../src/command-runner.js';
import {runCommand} from '../src/run-command.js';

const fixturePath = fileURLToPath(new URL('./fixtures/run-command-child.mjs', import.meta.url));

/** @returns {import('../src/run-command.js').RunCommandOptions} */
function options() {
  return {
    deadlineMs: 1_000,
    forceKillWaitMs: 1_000,
    killGraceMs: 100,
    maxOutputBytes: 64 * 1_024,
  };
}

/**
 * @param {string} mode
 * @param {Partial<import('../src/run-command.js').RunCommandOptions>} [overrides]
 * @returns {Promise<import('../src/run-command.js').RunCommandResult>}
 */
function runFixture(mode, overrides = {}) {
  return runCommand(process.execPath, [fixturePath, mode], {...options(), ...overrides});
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ESRCH') return false;
    throw error;
  }
}

test('returns success before the deadline', async () => {
  const result = await runFixture('success');

  assert.equal(result.status, 'success');
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /success stdout/);
  assert.match(result.output, /success stderr/);
});

test('returns a normal non-zero exit with stdout and stderr', async () => {
  const result = await runFixture('non-zero');

  assert.equal(result.status, 'non-zero-exit');
  assert.equal(result.exitCode, 7);
  assert.match(result.output, /failure stdout/);
  assert.match(result.output, /failure stderr/);
});

test('a deadline terminates a process that would otherwise never exit', async () => {
  const result = await runFixture('hang', {deadlineMs: 100});

  assert.equal(result.status, 'deadline-exceeded');
  assert.equal(result.termination, 'graceful');
  assert.equal(await processIsGone(assertPid(result.pid)), true);
});

test('a process that ignores graceful termination is forcibly terminated', async () => {
  const result = await runFixture('ignore-term', {deadlineMs: 100, killGraceMs: 50});

  assert.equal(result.status, 'deadline-exceeded');
  assert.equal(result.termination, 'forced');
  assert.equal(result.signal, 'SIGKILL');
  assert.match(result.output, /ignored SIGTERM/);
  assert.equal(await processIsGone(assertPid(result.pid)), true);
});

test('captured output is a strict bounded tail with explicit truncation metadata', async () => {
  const maxOutputBytes = 4_096;
  const result = await runFixture('noisy', {maxOutputBytes});

  assert.equal(result.status, 'non-zero-exit');
  assert.ok(Buffer.byteLength(result.output) <= maxOutputBytes);
  assert.ok(result.outputBytes > maxOutputBytes);
  assert.equal(result.outputTruncated, true);
  assert.doesNotMatch(result.output, /0000:/);
  assert.match(result.output, /USEFUL OUTPUT TAIL/);
});

test('POSIX deadlines terminate descendants in the owned process group', {
  skip: process.platform === 'win32' ? 'Windows only guarantees direct-child termination' : false,
}, async () => {
  const result = await runFixture('spawn-descendant', {deadlineMs: 150});
  const descendantMatch = result.output.match(/descendant:(\d+)/);

  assert.equal(result.status, 'deadline-exceeded');
  assert.ok(descendantMatch);
  assert.equal(await processIsGone(Number(descendantMatch[1])), true);
  assert.equal(await processIsGone(assertPid(result.pid)), true);
});

test('spawn failures are reported without an unhandled rejection', async () => {
  /** @type {unknown[]} */
  const unhandledRejections = [];
  const onUnhandledRejection = (/** @type {unknown} */ error) => unhandledRejections.push(error);
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    const result = await runCommand('/definitely/missing/side-by-sidekick-command', [], options());
    await waitForImmediate();

    assert.equal(result.status, 'spawn-failure');
    assert.match(result.error.message, /ENOENT/);
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
});

test('external cancellation reaches the child process', async () => {
  const controller = new AbortController();
  const resultPromise = runFixture('hang', {signal: controller.signal});
  setImmediate(() => controller.abort());

  const result = await resultPromise;

  assert.equal(result.status, 'cancelled');
  assert.equal(result.termination, 'graceful');
  assert.equal(await processIsGone(assertPid(result.pid)), true);
});

test('cleanup removes every timer and child listener on every settlement path', async () => {
  for (const scenario of ['success', 'failure', 'timeout', 'spawn-error']) {
    const harness = createHarness(scenario);
    const promise = runCommandWithDependencies('fixture', [], options(), harness.dependencies);
    harness.start();
    const result = await promise;

    assert.equal(harness.pendingTimerCount(), 0, `${scenario} retained a timer`);
    assert.equal(harness.child.listenerCount('close'), 0, `${scenario} retained a close listener`);
    assert.equal(harness.child.listenerCount('error'), 0, `${scenario} retained an error listener`);
    assert.equal(harness.child.stdout.listenerCount('data'), 0, `${scenario} retained a stdout listener`);
    assert.equal(harness.child.stderr.listenerCount('data'), 0, `${scenario} retained a stderr listener`);
    assert.notEqual(result.status, 'termination-failure');
  }
});

test('reports forced termination failure and releases descriptors when the child cannot be reaped', async () => {
  const harness = createHarness('termination-failure');
  const promise = runCommandWithDependencies('fixture', [], options(), harness.dependencies);
  harness.start();
  const result = await promise;

  assert.equal(result.status, 'termination-failure');
  assert.equal(result.termination, 'failed');
  assert.equal(harness.child.stdout.destroyed, true);
  assert.equal(harness.child.stderr.destroyed, true);
  assert.equal(harness.child.unrefCalls, 1);
  assert.equal(harness.pendingTimerCount(), 0);
});

/**
 * @param {number|undefined} pid
 * @returns {number}
 */
function assertPid(pid) {
  assert.notEqual(pid, undefined);
  return /** @type {number} */ (pid);
}

/**
 * @param {number} pid
 * @returns {Promise<boolean>}
 */
async function processIsGone(pid) {
  const deadline = Date.now() + 1_000;
  while (processExists(pid) && Date.now() < deadline) await waitForImmediate();
  return !processExists(pid);
}

/**
 * @typedef {'success'|'failure'|'timeout'|'spawn-error'|'termination-failure'} HarnessScenario
 */

/**
 * @param {HarnessScenario} scenario
 * @returns {{child: FakeChild, dependencies: import('../src/run-command.js').RunCommandDependencies, pendingTimerCount: () => number, start: () => void}}
 */
function createHarness(scenario) {
  const child = new FakeChild();
  let processTreeAlive = true;
  /** @type {Map<number, () => void>} */
  const timers = new Map();
  let nextTimerId = 1;

  const dependencies = {
    now: () => 10,
    platform: 'linux',
    spawn: () => child,
    isProcessTreeAlive: () => processTreeAlive,
    signalProcessTree: (_child, signal) => {
      if (signal === 'SIGKILL' && scenario === 'termination-failure') {
        throw new Error('SIGKILL failed');
      }
      if (signal === 'SIGKILL') {
        processTreeAlive = false;
        setImmediate(() => {
          child.exitCode = null;
          child.signalCode = 'SIGKILL';
          child.emit('close', null, 'SIGKILL');
        });
      }
    },
    setTimer: (callback) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (id) => timers.delete(/** @type {number} */ (id)),
  };

  return {
    child,
    dependencies,
    pendingTimerCount: () => timers.size,
    start() {
      if (scenario === 'success') {
        child.emit('close', 0, null);
      } else if (scenario === 'failure') {
        child.emit('close', 3, null);
      } else if (scenario === 'spawn-error') {
        child.pid = undefined;
        child.emit('error', Object.assign(new Error('spawn failed'), {code: 'ENOENT'}));
      } else {
        runNextTimer(timers);
        runNextTimer(timers);
      }
    },
  };
}

/**
 * @param {Map<number, () => void>} timers
 * @returns {void}
 */
function runNextTimer(timers) {
  const entry = timers.entries().next().value;
  assert.ok(entry);
  const [id, callback] = entry;
  timers.delete(id);
  callback();
}

/** Fake child process for deterministic lifecycle tests. */
class FakeChild extends EventEmitter {
  pid = 1234;
  exitCode = null;
  signalCode = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  unrefCalls = 0;

  /** @returns {void} */
  unref() {
    this.unrefCalls += 1;
  }
}
