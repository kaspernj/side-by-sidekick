// @ts-check

/**
 * @typedef {object} ProcessLike
 * @property {number} [pid] Child process id.
 * @property {number|null} [exitCode] Direct-child exit code.
 * @property {NodeJS.Signals|null} [signalCode] Direct-child termination signal.
 * @property {(signal: NodeJS.Signals) => boolean} [kill] Direct-child signal method.
 */

/**
 * @typedef {object} ProcessControl
 * @property {boolean} detached Whether the child should own a new process group.
 * @property {boolean} terminatesDescendants Whether signals cover descendants.
 * @property {(child: ProcessLike) => boolean} isAlive Whether the owned process scope still exists.
 * @property {(child: ProcessLike, signal: NodeJS.Signals) => void} signal Signals the owned process scope.
 */

/**
 * Creates the platform-specific process ownership and termination adapter.
 *
 * POSIX supports owned process groups, so signalling the negative group id reaches descendants.
 * Node does not expose equivalent process-tree signalling on Windows; that path can only promise
 * direct-child termination.
 *
 * @param {NodeJS.Platform} platform
 * @param {typeof process.kill} killProcess
 * @returns {ProcessControl}
 */
export function createProcessControl(platform, killProcess = process.kill) {
  if (platform === 'win32') {
    return {
      detached: false,
      terminatesDescendants: false,
      isAlive(child) {
        return child.exitCode === null && child.signalCode === null;
      },
      signal(child, signal) {
        if (!child.kill) throw new Error('Child process does not support direct termination.');
        child.kill(signal);
      },
    };
  }

  return {
    detached: true,
    terminatesDescendants: true,
    isAlive(child) {
      if (child.pid === undefined) return false;
      try {
        killProcess(-child.pid, 0);
        return true;
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ESRCH') return false;
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM') return true;
        throw error;
      }
    },
    signal(child, signal) {
      if (child.pid === undefined) throw new Error('Cannot signal a process group without a child pid.');
      killProcess(-child.pid, signal);
    },
  };
}
