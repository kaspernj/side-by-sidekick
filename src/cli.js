#!/usr/bin/env node
// @ts-check
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommands } from './runner.js';

const USAGE = [
  'Usage: side-by-sidekick <command1> [command2] [...]',
  '',
  'Runs every given shell command concurrently, starting all of them immediately,',
  'while presenting their output one command at a time, in argument order.',
  '',
  'Example:',
  '  npx side-by-sidekick "npm test" "npm run lint"',
].join('\n');

/**
 * @param {number} ms Duration in milliseconds.
 * @returns {string} The duration formatted as seconds with two decimals, e.g. `"1.23s"`.
 */
function formatDuration(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Prints the end-of-run summary: one line per command with its exit status and duration,
 * followed by the total wall-clock duration of the whole run.
 *
 * @param {import('./runner.js').RunCommandsResult} result The result of {@link runCommands}.
 * @returns {void}
 */
function printSummary(result) {
  process.stdout.write('\n--- Summary ---\n');
  for (const outcome of result.outcomes) {
    const status = outcome.signal ? `killed by ${outcome.signal}` : `exit ${outcome.exitCode}`;
    process.stdout.write(`  ${outcome.command}  ->  ${status}  (${formatDuration(outcome.durationMs)})\n`);
  }
  process.stdout.write(`Total duration: ${formatDuration(result.totalDurationMs)}\n`);
}

/**
 * Runs the CLI end to end: validates arguments, runs the commands, prints the summary, and
 * terminates any still-running commands if the process receives SIGINT.
 *
 * @param {string[]} argv Command strings, i.e. `process.argv.slice(2)`.
 * @returns {Promise<number>} The process exit code the caller should use.
 */
export async function main(argv) {
  if (argv.length === 0) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }

  const controller = new AbortController();
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    controller.abort();
  };
  process.on('SIGINT', onSigint);

  try {
    const result = await runCommands(argv, { signal: controller.signal });
    printSummary(result);
    return interrupted ? 130 : result.exitCode;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

/**
 * Whether this module was launched directly as the entry script, rather than merely imported.
 * `process.argv[1]` can be a symlink (e.g. npm's `node_modules/.bin` shims, which is exactly how
 * `npx` invokes an installed CLI) while `import.meta.url` is always resolved to the file's
 * realpath, so a plain string comparison between the two fails for every symlinked install;
 * resolving `argv[1]` to its realpath first makes the comparison work in both cases.
 *
 * @returns {boolean}
 */
function isMainModule() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
