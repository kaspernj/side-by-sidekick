// @ts-check
import {readdir, readFile} from 'node:fs/promises';

/**
 * @typedef {object} ProcessLike
 * @property {number} [pid] Child process id.
 * @property {number|null} [exitCode] Direct-child exit code.
 * @property {NodeJS.Signals|null} [signalCode] Direct-child termination signal.
 * @property {(signal: NodeJS.Signals) => boolean} [kill] Direct-child signal method.
 */

/**
 * @typedef {(processGroupId: number) => Promise<boolean|null>} ProcessGroupLivenessReader
 * Whether an owned process group still holds a live process, or null when the platform exposes no
 * process state to consult.
 */

/**
 * @typedef {object} ProcessControl
 * @property {boolean} detached Whether the child should own a new process group.
 * @property {boolean} terminatesDescendants Whether signals cover descendants.
 * @property {(child: ProcessLike) => Promise<boolean>} isAlive Whether the owned process scope still holds a live process.
 * @property {(child: ProcessLike, signal: NodeJS.Signals) => void} signal Signals the owned process scope.
 */

/** State field of a /proc entry for a process that has terminated but was never reaped. */
const DEFUNCT_STATE = 'Z';

/** /proc entries read at once while looking for the members of one process group. */
const PROCESS_SCAN_BATCH_SIZE = 64;

/**
 * @typedef {object} ProcessEntry
 * @property {string} state Process state field.
 * @property {number} processGroupId Process group id.
 */

/**
 * Reads one process entry from /proc, or null when the process is gone or the platform has no /proc.
 * The bracketed comm field can contain spaces, so fields are counted from its closing parenthesis.
 *
 * @param {number} pid
 * @returns {Promise<ProcessEntry|null>}
 */
async function readProcessEntry(pid) {
  let raw;
  try {
    raw = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
    throw error;
  }

  const fields = raw.slice(raw.lastIndexOf(')') + 1).trim().split(' ');
  const state = fields[0];
  const processGroupId = fields[2];
  if (state === undefined || processGroupId === undefined) return null;
  return {state, processGroupId: Number(processGroupId)};
}

/**
 * Reports whether an owned process group still holds a live process.
 *
 * A defunct entry has already terminated and only its parent can remove it. This library cannot reap
 * a grandchild, so a group whose remaining members are all defunct is terminated, not alive. Without
 * that distinction a group signal that reached every member is reported as a termination failure on
 * hosts whose init does not reap orphaned descendants.
 *
 * @param {number} processGroupId
 * @returns {Promise<boolean|null>}
 */
async function defaultProcessGroupLiveness(processGroupId) {
  const leader = await readProcessEntry(processGroupId);
  if (leader) return leader.state !== DEFUNCT_STATE;

  let entries;
  try {
    entries = await readdir('/proc');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
    throw error;
  }

  /** @type {boolean} */
  let sawDefunctMember = false;
  for (let offset = 0; offset < entries.length; offset += PROCESS_SCAN_BATCH_SIZE) {
    const batch = entries.slice(offset, offset + PROCESS_SCAN_BATCH_SIZE).filter((entry) => /^\d+$/.test(entry));
    for (const processEntry of await Promise.all(batch.map((entry) => readProcessEntry(Number(entry))))) {
      if (!processEntry || processEntry.processGroupId !== processGroupId) continue;
      if (processEntry.state !== DEFUNCT_STATE) return true;
      sawDefunctMember = true;
    }
  }

  if (sawDefunctMember) return false;
  return null;
}

/**
 * Creates the platform-specific process ownership and termination adapter.
 *
 * POSIX supports owned process groups, so signalling the negative group id reaches descendants.
 * Node does not expose equivalent process-tree signalling on Windows; that path can only promise
 * direct-child termination.
 *
 * @param {NodeJS.Platform} platform
 * @param {typeof process.kill} killProcess
 * @param {ProcessGroupLivenessReader} readGroupLiveness
 * @returns {ProcessControl}
 */
export function createProcessControl(
  platform,
  killProcess = process.kill,
  readGroupLiveness = defaultProcessGroupLiveness,
) {
  if (platform === 'win32') {
    return {
      detached: false,
      terminatesDescendants: false,
      async isAlive(child) {
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
    async isAlive(child) {
      if (child.pid === undefined) return false;
      try {
        killProcess(-child.pid, 0);
      } catch (error) {
        const code = /** @type {NodeJS.ErrnoException} */ (error).code;
        if (code === 'ESRCH') return false;
        if (code === 'EPERM') return true;
        throw error;
      }

      // The group probe answers for a group whose only remaining members are defunct, so the state
      // has to be read before the probe can be called liveness.
      const liveness = await readGroupLiveness(child.pid);
      return liveness === null ? true : liveness;
    },
    signal(child, signal) {
      if (child.pid === undefined) throw new Error('Cannot signal a process group without a child pid.');
      killProcess(-child.pid, signal);
    },
  };
}
