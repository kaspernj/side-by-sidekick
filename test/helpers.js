// @ts-check
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturePath = fileURLToPath(new URL('./fixtures/sequence.mjs', import.meta.url));

/**
 * Writes a fixture config file to a fresh temp directory and returns the shell command string
 * that runs test/fixtures/sequence.mjs against it.
 *
 * @param {Array<{ stream?: 'stdout'|'stderr', text: string, delayMs?: number }>} steps
 * @param {{ exitCode?: number }} [rest]
 * @returns {string} A shell command string suitable for `runCommands`.
 */
export function sequenceCommand(steps, rest = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'side-by-sidekick-test-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ steps, exitCode: rest.exitCode ?? 0 }));
  return `node ${JSON.stringify(fixturePath)} ${JSON.stringify(configPath)}`;
}

/**
 * Creates a fake writable stream that just collects every chunk written to it in memory.
 *
 * @returns {{ write: (chunk: Buffer) => true, text: () => string }}
 */
export function createCollector() {
  /** @type {Buffer[]} */
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(chunk);
      return true;
    },
    text() {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}
