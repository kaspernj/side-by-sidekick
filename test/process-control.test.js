// @ts-check
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProcessControl} from '../src/process-control.js';

test('POSIX process control owns a detached group and signals the negative group id', async () => {
  /** @type {Array<[number, NodeJS.Signals]>} */
  const calls = [];
  const control = createProcessControl('linux', (pid, signal) => calls.push([pid, signal]), async () => null);

  assert.equal(control.detached, true);
  assert.equal(await control.isAlive({pid: 1234}), true);
  control.signal({pid: 1234}, 'SIGTERM');
  assert.deepEqual(calls, [[-1234, 0], [-1234, 'SIGTERM']]);
  assert.equal(control.terminatesDescendants, true);
});

test('a group whose signal probe succeeds but holds only defunct members is not alive', async () => {
  const control = createProcessControl('linux', () => {}, async () => false);

  assert.equal(await control.isAlive({pid: 1234}), false);
});

test('a group that no longer exists is not alive without consulting process state', async () => {
  /** @type {number[]} */
  const consulted = [];
  const control = createProcessControl('linux', () => {
    throw Object.assign(new Error('no such process group'), {code: 'ESRCH'});
  }, async (processGroupId) => {
    consulted.push(processGroupId);
    return null;
  });

  assert.equal(await control.isAlive({pid: 1234}), false);
  assert.deepEqual(consulted, []);
});

test('Windows process control documents and uses direct-child termination only', async () => {
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
  assert.equal(await control.isAlive({...child, exitCode: null, signalCode: null}), true);
  control.signal(child, 'SIGKILL');
  assert.deepEqual(calls, ['SIGKILL']);
  assert.equal(control.terminatesDescendants, false);
});
