#!/usr/bin/env node
// @ts-check
// Small deterministic fixture used by the integration tests: reads a JSON config file describing
// a sequence of writes (with optional delays) to stdout/stderr, then exits with a given code.
//
// Config shape:
//   {
//     "steps": [{ "stream": "stdout" | "stderr", "text": "...", "delayMs": 0 }, ...],
//     "exitCode": 0
//   }
import { readFileSync } from 'node:fs';

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const configPath = process.argv[2];
if (!configPath) {
  process.stderr.write('sequence.mjs: missing config path argument\n');
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));

for (const step of config.steps ?? []) {
  if (step.delayMs) await sleep(step.delayMs);
  const stream = step.stream === 'stderr' ? process.stderr : process.stdout;
  stream.write(step.text);
}

process.exitCode = config.exitCode ?? 0;
