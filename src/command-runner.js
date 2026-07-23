// @ts-check
import {spawn} from 'node:child_process';
import {createProcessControl} from './process-control.js';

/**
 * @typedef {'success'|'non-zero-exit'|'signal-exit'|'deadline-exceeded'|'cancelled'} CompletedStatus
 */

/**
 * @typedef {'none'|'graceful'|'forced'|'failed'} Termination
 */

/**
 * @typedef {object} RunCommandOptions
 * @property {number} deadlineMs Maximum runtime before termination begins.
 * @property {number} [killGraceMs] Grace after SIGTERM before SIGKILL. Defaults to 2000.
 * @property {number} [forceKillWaitMs] Maximum wait for close after SIGKILL. Defaults to 5000.
 * @property {number} [maxOutputBytes] Maximum captured combined-output tail. Defaults to 65536.
 * @property {AbortSignal} [signal] Aborting terminates the child and owned descendants.
 * @property {string} [cwd] Child working directory.
 * @property {NodeJS.ProcessEnv} [env] Child environment. Defaults to process.env.
 * @property {NodeJS.WritableStream} [stdout] Optional live stdout destination.
 * @property {NodeJS.WritableStream} [stderr] Optional live stderr destination.
 */

/**
 * @typedef {object} BaseRunCommandResult
 * @property {number|undefined} pid Spawned process id, when one was assigned.
 * @property {number|null} exitCode Exit code, or null for signal exits and spawn failures.
 * @property {NodeJS.Signals|null} signal Signal reported by close, or null.
 * @property {number} durationMs Wall-clock duration.
 * @property {Termination} termination Termination escalation used for this result.
 * @property {boolean} terminatesDescendants Whether this platform's adapter covers descendants.
 * @property {string} output Bounded combined stdout/stderr tail.
 * @property {number} outputBytes Total bytes observed before truncation.
 * @property {boolean} outputTruncated Whether bytes were removed from the head.
 */

/**
 * @typedef {BaseRunCommandResult & {status: CompletedStatus}} CompletedRunCommandResult
 */

/**
 * @typedef {BaseRunCommandResult & {status: 'spawn-failure'|'termination-failure', error: Error}} FailedRunCommandResult
 */

/**
 * @typedef {CompletedRunCommandResult|FailedRunCommandResult} RunCommandResult
 */

/**
 * @typedef {object} RunCommandDependencies
 * @property {typeof spawn} spawn Child-process factory.
 * @property {() => number} now Monotonic-enough wall-clock source for durations.
 * @property {NodeJS.Platform} platform Platform whose ownership semantics should be used.
 * @property {(child: import('node:child_process').ChildProcess, signal: NodeJS.Signals) => void} signalProcessTree Signals the owned process scope.
 * @property {(child: import('node:child_process').ChildProcess) => boolean} isProcessTreeAlive Checks whether the owned process scope remains alive.
 * @property {(callback: () => void, delayMs: number) => unknown} setTimer Schedules one lifecycle deadline.
 * @property {(timer: unknown) => void} clearTimer Cancels one lifecycle deadline.
 */

/**
 * @typedef {object} OutputTail
 * @property {Buffer} buffer Retained bounded tail.
 * @property {number} bytes Total bytes observed.
 */

/**
 * Creates a timer that cannot keep the parent process alive by itself.
 *
 * @param {() => void} callback
 * @param {number} delayMs
 * @returns {NodeJS.Timeout}
 */
function setUnreferencedTimer(callback, delayMs) {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return timer;
}

const defaultProcessControl = createProcessControl(process.platform);

/** @type {RunCommandDependencies} */
const defaultDependencies = {
  spawn,
  now: Date.now,
  platform: process.platform,
  signalProcessTree: defaultProcessControl.signal,
  isProcessTreeAlive: defaultProcessControl.isAlive,
  setTimer: setUnreferencedTimer,
  clearTimer: (timer) => clearTimeout(/** @type {NodeJS.Timeout} */ (timer)),
};

/**
 * Adds bytes to a fixed-size tail buffer.
 *
 * @param {OutputTail} tail
 * @param {Buffer} chunk
 * @param {number} maximumBytes
 * @returns {void}
 */
function appendOutput(tail, chunk, maximumBytes) {
  tail.bytes += chunk.length;
  if (maximumBytes === 0) return;
  if (chunk.length >= maximumBytes) {
    tail.buffer = Buffer.from(chunk.subarray(chunk.length - maximumBytes));
    return;
  }

  const bytesToKeep = Math.min(tail.buffer.length, maximumBytes - chunk.length);
  tail.buffer = Buffer.concat([
    tail.buffer.subarray(tail.buffer.length - bytesToKeep),
    chunk,
  ], bytesToKeep + chunk.length);
}

/**
 * Decodes captured bytes without letting a partial leading UTF-8 sequence exceed the byte cap
 * after replacement-character decoding.
 *
 * @param {Buffer} buffer
 * @param {number} maximumBytes
 * @returns {string}
 */
function decodeOutput(buffer, maximumBytes) {
  let output = buffer.toString('utf8');
  while (Buffer.byteLength(output) > maximumBytes) output = output.slice(1);
  return output;
}

/**
 * Returns whether a process-signal failure only says the target has already disappeared.
 *
 * @param {Error} error
 * @returns {boolean}
 */
function processAlreadyGone(error) {
  return /** @type {NodeJS.ErrnoException} */ (error).code === 'ESRCH';
}

/**
 * Validates a positive integer duration.
 *
 * @param {number} value
 * @param {string} name
 * @returns {void}
 */
function validatePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

/**
 * Validates a non-negative output limit.
 *
 * @param {number} value
 * @returns {void}
 */
function validateOutputLimit(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('maxOutputBytes must be a non-negative safe integer.');
  }
}

/**
 * Runs one executable with an argument array, bounded lifetime, bounded captured output, and
 * controlled process-tree termination.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {RunCommandOptions} options
 * @param {RunCommandDependencies} dependencies
 * @returns {Promise<RunCommandResult>}
 */
export function runCommandWithDependencies(command, args, options, dependencies) {
  const {
    deadlineMs,
    killGraceMs = 2_000,
    forceKillWaitMs = 5_000,
    maxOutputBytes = 65_536,
    signal: abortSignal,
    cwd,
    env = process.env,
    stdout,
    stderr,
  } = options;
  validatePositiveInteger(deadlineMs, 'deadlineMs');
  validatePositiveInteger(killGraceMs, 'killGraceMs');
  validatePositiveInteger(forceKillWaitMs, 'forceKillWaitMs');
  validateOutputLimit(maxOutputBytes);

  const processControl = createProcessControl(dependencies.platform);
  const startedAt = dependencies.now();
  /** @type {OutputTail} */
  const outputTail = {buffer: Buffer.alloc(0), bytes: 0};

  /**
   * @param {CompletedStatus|'spawn-failure'|'termination-failure'} status
   * @param {Error} [error]
   * @returns {RunCommandResult}
   */
  function resultWithoutChild(status, error) {
    const base = {
      pid: undefined,
      exitCode: null,
      signal: null,
      durationMs: dependencies.now() - startedAt,
      termination: /** @type {Termination} */ ('none'),
      terminatesDescendants: processControl.terminatesDescendants,
      output: '',
      outputBytes: 0,
      outputTruncated: false,
    };
    if (status === 'spawn-failure' || status === 'termination-failure') {
      return {...base, status, error: /** @type {Error} */ (error)};
    }
    return {...base, status};
  }

  if (abortSignal?.aborted) return Promise.resolve(resultWithoutChild('cancelled'));

  /** @type {import('node:child_process').ChildProcess} */
  let child;
  try {
    child = dependencies.spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached: processControl.detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return Promise.resolve(resultWithoutChild('spawn-failure', /** @type {Error} */ (error)));
  }

  return new Promise((resolve) => {
    /** @type {Set<unknown>} */
    const timers = new Set();
    /** @type {Array<{destination: NodeJS.WritableStream, listener: () => void, source: NodeJS.ReadableStream}>} */
    const drainListeners = [];
    /** @type {'deadline-exceeded'|'cancelled'|'termination-failure'|null} */
    let terminationCause = null;
    /** @type {Error|undefined} */
    let terminationError;
    /** @type {Termination} */
    let termination = 'none';
    /** @type {{exitCode: number|null, signal: NodeJS.Signals|null}|null} */
    let closeOutcome = null;
    let forwardLiveOutput = true;
    let settled = false;

    /**
     * @param {() => void} callback
     * @param {number} delayMs
     * @returns {unknown}
     */
    function schedule(callback, delayMs) {
      /** @type {unknown} */
      let timer;
      timer = dependencies.setTimer(() => {
        timers.delete(timer);
        callback();
      }, delayMs);
      timers.add(timer);
      return timer;
    }

    /** @returns {void} */
    function releaseBackpressure() {
      forwardLiveOutput = false;
      for (const {destination, listener, source} of drainListeners) {
        destination.off('drain', listener);
        source.resume();
      }
      drainListeners.length = 0;
    }

    /** @returns {void} */
    function cleanup() {
      for (const timer of timers) dependencies.clearTimer(timer);
      timers.clear();
      child.off('close', onClose);
      child.off('error', onChildError);
      child.stdout?.off('data', onStdout);
      child.stdout?.off('error', onStreamError);
      child.stderr?.off('data', onStderr);
      child.stderr?.off('error', onStreamError);
      abortSignal?.removeEventListener('abort', onAbort);
      releaseBackpressure();
    }

    /**
     * @param {CompletedStatus|'spawn-failure'|'termination-failure'} status
     * @param {number|null} exitCode
     * @param {NodeJS.Signals|null} closeSignal
     * @param {Error} [error]
     * @returns {void}
     */
    function settle(status, exitCode, closeSignal, error) {
      if (settled) return;
      settled = true;
      cleanup();
      const base = {
        pid: child.pid,
        exitCode,
        signal: closeSignal,
        durationMs: dependencies.now() - startedAt,
        termination,
        terminatesDescendants: processControl.terminatesDescendants,
        output: decodeOutput(outputTail.buffer, maxOutputBytes),
        outputBytes: outputTail.bytes,
        outputTruncated: outputTail.bytes > outputTail.buffer.length,
      };
      if (status === 'spawn-failure' || status === 'termination-failure') {
        resolve({...base, status, error: /** @type {Error} */ (error)});
      } else {
        resolve({...base, status});
      }
    }

    /**
     * Releases every parent-side descriptor when a killed process never reports close.
     *
     * @param {Error} error
     * @returns {void}
     */
    function failTermination(error) {
      termination = 'failed';
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      settle('termination-failure', child.exitCode, child.signalCode, error);
    }

    /**
     * @param {NodeJS.Signals} killSignal
     * @returns {boolean}
     */
    function signalTree(killSignal) {
      try {
        dependencies.signalProcessTree(child, killSignal);
        return true;
      } catch (error) {
        const signalError = /** @type {Error} */ (error);
        if (processAlreadyGone(signalError)) return true;
        failTermination(signalError);
        return false;
      }
    }

    /**
     * @returns {boolean}
     */
    function processTreeIsAlive() {
      try {
        return dependencies.isProcessTreeAlive(child);
      } catch (error) {
        failTermination(/** @type {Error} */ (error));
        return true;
      }
    }

    /** @returns {void} */
    function settleTerminatedProcessIfGone() {
      if (settled || !terminationCause || !closeOutcome || processTreeIsAlive()) return;
      settle(terminationCause, closeOutcome.exitCode, closeOutcome.signal, terminationError);
    }

    /** @returns {void} */
    function pollForForcedExit() {
      if (settled) return;
      settleTerminatedProcessIfGone();
      if (!settled) schedule(pollForForcedExit, 10);
    }

    /**
     * @param {'deadline-exceeded'|'cancelled'|'termination-failure'} cause
     * @param {Error} [initialError]
     * @returns {void}
     */
    function terminate(cause, initialError) {
      if (settled || terminationCause) return;
      terminationCause = cause;
      terminationError = initialError;
      termination = 'graceful';
      releaseBackpressure();
      if (!signalTree('SIGTERM')) return;
      schedule(() => {
        settleTerminatedProcessIfGone();
        if (settled) return;
        const processTreeAlive = processTreeIsAlive();
        if (settled) return;
        if (!processTreeAlive) {
          schedule(() => failTermination(new Error(
            `Child process did not close within ${forceKillWaitMs}ms after its process tree exited.`,
          )), forceKillWaitMs);
          return;
        }
        termination = 'forced';
        if (!signalTree('SIGKILL')) return;
        schedule(pollForForcedExit, 10);
        schedule(() => failTermination(new Error(
          `Child process did not close within ${forceKillWaitMs}ms after SIGKILL.`,
        )), forceKillWaitMs);
      }, killGraceMs);
    }

    /**
     * @param {NodeJS.ReadableStream} source
     * @param {NodeJS.WritableStream|undefined} destination
     * @param {Buffer} chunk
     * @returns {void}
     */
    function captureAndForward(source, destination, chunk) {
      appendOutput(outputTail, chunk, maxOutputBytes);
      if (!forwardLiveOutput || !destination || destination.write(chunk)) return;
      source.pause();
      const onDrain = () => {
        destination.off('drain', onDrain);
        const index = drainListeners.findIndex((entry) => entry.listener === onDrain);
        if (index >= 0) drainListeners.splice(index, 1);
        source.resume();
      };
      drainListeners.push({destination, listener: onDrain, source});
      destination.once('drain', onDrain);
    }

    /** @param {Buffer} chunk @returns {void} */
    function onStdout(chunk) {
      if (child.stdout) captureAndForward(child.stdout, stdout, chunk);
    }

    /** @param {Buffer} chunk @returns {void} */
    function onStderr(chunk) {
      if (child.stderr) captureAndForward(child.stderr, stderr, chunk);
    }

    /** @param {Error} error @returns {void} */
    function onStreamError(error) {
      terminate('termination-failure', error);
    }

    /** @param {Error} error @returns {void} */
    function onChildError(error) {
      if (child.pid === undefined) settle('spawn-failure', null, null, error);
      else terminate('termination-failure', error);
    }

    /**
     * @param {number|null} exitCode
     * @param {NodeJS.Signals|null} closeSignal
     * @returns {void}
     */
    function onClose(exitCode, closeSignal) {
      if (terminationCause) {
        closeOutcome = {exitCode, signal: closeSignal};
        settleTerminatedProcessIfGone();
      } else if (exitCode === 0) {
        settle('success', exitCode, closeSignal);
      } else if (exitCode !== null) {
        settle('non-zero-exit', exitCode, closeSignal);
      } else {
        settle('signal-exit', exitCode, closeSignal);
      }
    }

    /** @returns {void} */
    function onAbort() {
      terminate('cancelled');
    }

    child.stdout?.on('data', onStdout);
    child.stdout?.on('error', onStreamError);
    child.stderr?.on('data', onStderr);
    child.stderr?.on('error', onStreamError);
    child.on('close', onClose);
    child.on('error', onChildError);
    abortSignal?.addEventListener('abort', onAbort, {once: true});
    schedule(() => terminate('deadline-exceeded'), deadlineMs);
  });
}

/**
 * Runs one executable with an argument array, bounded lifetime, bounded captured output, and
 * controlled process-tree termination.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {RunCommandOptions} options
 * @returns {Promise<RunCommandResult>}
 */
export function runCommand(command, args, options) {
  return runCommandWithDependencies(command, args, options, defaultDependencies);
}
