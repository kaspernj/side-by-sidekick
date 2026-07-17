// @ts-check
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';

/**
 * @typedef {object} WritableLike
 * @property {(chunk: Buffer) => unknown} write Writes a chunk of output.
 */

/**
 * @typedef {object} RunCommandsOptions
 * @property {WritableLike} [stdout] Destination for child stdout output. Defaults to `process.stdout`.
 * @property {WritableLike} [stderr] Destination for child stderr output. Defaults to `process.stderr`.
 * @property {AbortSignal} [signal] Aborting terminates every still-running child process (and its subprocesses).
 * @property {string} [cwd] Working directory to spawn every command in. Defaults to `process.cwd()`.
 * @property {number} [killGraceMs] How long to wait after sending SIGTERM (on abort) before
 *   escalating to SIGKILL for a command that won't exit. Defaults to `5000`.
 */

/**
 * @typedef {object} CommandOutcome
 * @property {string} command The original command string, as supplied.
 * @property {number|null} exitCode The process exit code, or `null` if it was killed by a signal.
 * @property {NodeJS.Signals|null} signal The signal that killed the process, or `null` if it exited normally.
 * @property {number} durationMs Wall-clock time the command took to finish, in milliseconds.
 */

/**
 * @typedef {object} RunCommandsResult
 * @property {CommandOutcome[]} outcomes Per-command results, in argument order.
 * @property {number} exitCode Overall exit code: `0` if every command succeeded, otherwise the
 *   exit code of the last-failed command in argument order.
 * @property {number} totalDurationMs Wall-clock duration of the whole run, in milliseconds.
 */

/**
 * @typedef {object} BufferedChunk
 * @property {'stdout'|'stderr'} stream Which stream the chunk was written to.
 * @property {Buffer} chunk The raw bytes written.
 */

/**
 * @typedef {object} TrackedCommand
 * @property {string} command The original command string, as supplied.
 * @property {import('node:child_process').ChildProcess} child The spawned child process.
 * @property {BufferedChunk[]} buffer Output captured while this command is not yet current.
 * @property {boolean} live Whether new output should be written straight through instead of buffered.
 * @property {boolean} headerPrinted Whether this command's header has already been printed.
 * @property {boolean} finished Whether the underlying process has exited.
 * @property {number|null} exitCode The process exit code, once finished.
 * @property {NodeJS.Signals|null} signal The signal that killed the process, if any.
 * @property {number} startTime The timestamp this command was spawned at.
 * @property {number} durationMs How long this command took to finish, once finished.
 */

/**
 * Converts a termination signal into the conventional 128+n shell exit code, or falls back to 1
 * for signals this runtime does not recognize.
 *
 * @param {NodeJS.Signals} signal The signal a process was killed with.
 * @returns {number} The equivalent shell-style exit code.
 */
function signalToExitCode(signal) {
  const signalNumber = /** @type {Record<string, number>} */ (osConstants.signals)[signal];
  return typeof signalNumber === 'number' ? 128 + signalNumber : 1;
}

/**
 * Prints the header that marks a command as "current" and flushes any output that was buffered
 * for it while it was waiting its turn.
 *
 * @param {TrackedCommand} entry The command becoming current.
 * @param {number} index Its zero-based position in argument order.
 * @param {number} total Total number of commands in this run.
 * @param {WritableLike} stdout Where to print the header.
 * @param {(streamName: 'stdout'|'stderr', chunk: Buffer) => void} writeChunk Writes a chunk to the real output streams.
 * @returns {void}
 */
function activateCommand(entry, index, total, stdout, writeChunk) {
  stdout.write(Buffer.from(`\n>>> [${index + 1}/${total}] ${entry.command}\n`));
  for (const { stream, chunk } of entry.buffer) writeChunk(stream, chunk);
  entry.buffer.length = 0;
  entry.headerPrinted = true;
  entry.live = true;
}

/**
 * Runs every command concurrently, starting all of them immediately, while presenting their
 * combined output in argument order: a command's output is buffered until every command before it
 * has finished, at which point its header is printed, its buffered output flushed, and it becomes
 * "current" - meaning further output streams straight through until it finishes and the next
 * command takes its turn.
 *
 * @param {string[]} commands Shell command strings to execute, one child process per entry.
 * @param {RunCommandsOptions} [options] Behavior overrides.
 * @returns {Promise<RunCommandsResult>} Resolves once every command has finished.
 */
export function runCommands(commands, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const { signal, cwd } = options;

  if (commands.length === 0) {
    return Promise.resolve({ outcomes: [], exitCode: 0, totalDurationMs: 0 });
  }

  const startedAt = Date.now();
  const killGraceMs = 1_000;

  return new Promise((resolve) => {
    /**
     * @param {'stdout'|'stderr'} streamName
     * @param {Buffer} chunk
     * @returns {void}
     */
    function writeChunk(streamName, chunk) {
      (streamName === 'stdout' ? stdout : stderr).write(chunk);
    }

    let currentIndex = 0;

    /**
     * Advances the "current command" pointer past every command that has already finished,
     * printing headers and flushing buffers along the way, and stops at the first still-running one.
     *
     * @returns {void}
     */
    function advance() {
      while (currentIndex < tracked.length) {
        const entry = /** @type {TrackedCommand} */ (tracked[currentIndex]);
        if (!entry.headerPrinted) activateCommand(entry, currentIndex, tracked.length, stdout, writeChunk);
        if (!entry.finished) break;
        currentIndex += 1;
      }
    }

    /**
     * Resolves the outer promise once every command has finished.
     *
     * @returns {void}
     */
    function maybeResolve() {
      if (!tracked.every((entry) => entry.finished)) return;

      const outcomes = tracked.map((entry) => ({
        command: entry.command,
        exitCode: entry.exitCode,
        signal: entry.signal,
        durationMs: entry.durationMs,
      }));

      let exitCode = 0;
      for (const outcome of outcomes) {
        const code = outcome.exitCode ?? (outcome.signal ? signalToExitCode(outcome.signal) : 0);
        if (code !== 0) exitCode = code;
      }

      resolve({ outcomes, exitCode, totalDurationMs: Date.now() - startedAt });
    }

    /** @type {TrackedCommand[]} */
    const tracked = commands.map((command) => {
      const child = spawn(command, {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        cwd,
      });

      /** @type {TrackedCommand} */
      const entry = {
        command,
        child,
        buffer: [],
        live: false,
        headerPrinted: false,
        finished: false,
        exitCode: null,
        signal: null,
        startTime: Date.now(),
        durationMs: 0,
      };

      /**
       * @param {'stdout'|'stderr'} streamName
       * @param {Buffer} chunk
       * @returns {void}
       */
      function emit(streamName, chunk) {
        if (entry.live) writeChunk(streamName, chunk);
        else entry.buffer.push({ stream: streamName, chunk });
      }

      child.stdout?.on('data', (/** @type {Buffer} */ chunk) => emit('stdout', chunk));
      child.stderr?.on('data', (/** @type {Buffer} */ chunk) => emit('stderr', chunk));

      let settled = false;

      /**
       * Finalizes this command's outcome exactly once, whether it exited normally, was killed by
       * a signal, or could not even be spawned (both `'close'` and `'error'` may fire for the
       * latter, and letting `'error'` go unhandled would crash the whole process).
       *
       * @param {number|null} exitCode
       * @param {NodeJS.Signals|null} closeSignal
       * @returns {void}
       */
      function settle(exitCode, closeSignal) {
        if (settled) return;
        settled = true;
        entry.exitCode = exitCode;
        entry.signal = closeSignal;
        entry.finished = true;
        entry.durationMs = Date.now() - entry.startTime;
        advance();
        maybeResolve();
      }

      child.on('close', (code, closeSignal) => settle(code, closeSignal));

      child.on('error', (err) => {
        emit('stderr', Buffer.from(`${entry.command}: ${err.message}\n`));
        // 'close' still fires after a spawn error in current Node versions and carries the more
        // precise outcome, so prefer it; this is only a safety net against a broken command
        // hanging the whole run forever if 'close' were ever not to arrive.
        setTimeout(() => settle(entry.exitCode ?? 1, null), 250).unref();
      });

      if (signal) {
        /**
         * @param {NodeJS.Signals} killSignal
         * @returns {void}
         */
        const killGroup = (killSignal) => {
          const { pid } = child;
          if (pid === undefined) return;
          try {
            process.kill(-pid, killSignal);
          } catch {
            // The process group may already be gone; nothing left to terminate.
          }
        };
        const onAbort = () => {
          killGroup('SIGTERM');
          // A command that ignores SIGTERM would otherwise hang the whole run forever on
          // abort/Ctrl-C; escalate to SIGKILL if it hasn't exited after a short grace period.
          const escalate = setTimeout(() => killGroup('SIGKILL'), killGraceMs);
          escalate.unref();
          child.once('close', () => clearTimeout(escalate));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      return entry;
    });

    advance();
  });
}
