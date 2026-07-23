// @ts-check
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProcessControl} from '../src/process-control.js';

test('POSIX process control owns a detached group and signals the negative group id', () => {
  /** @type {Array<[number, NodeJS.Signals]>} */
  const calls = [];
  const control = createProcessControl('linux', (pid, signal) => calls.push([pid, signal]));

  assert.equal(control.detached, true);
  assert.equal(control.isAlive({pid: 1234}), true);
  control.signal({pid: 1234}, 'SIGTERM');
  assert.deepEqual(calls, [[-1234, 0], [-1234, 'SIGTERM']]);
  assert.equal(control.terminatesDescendants, true);
});

test('Windows process control documents and uses direct-child termination only', () => {
  /** @type {NodeJS.Signals[]} */
  const calls = [];
  const control = createProcessControl('win32', () => {
    throw new Error('process.kill should not be called on Windows');
  });
  const child = {
    pid: 1234,
    kill(signal) {
      calls.push(signal);
      return true;
    },
  };

  assert.equal(control.detached, false);
  assert.equal(control.isAlive({...child, exitCode: null, signalCode: null}), true);
  control.signal(child, 'SIGKILL');
  assert.deepEqual(calls, ['SIGKILL']);
  assert.equal(control.terminatesDescendants, false);
});
