// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCommands } from '../src/runner.js';
import { createCollector, sequenceCommand } from './helpers.js';

test('starts every command immediately (concurrently, not one after another)', async () => {
  const commandA = sequenceCommand([{ text: 'a\n', delayMs: 300 }]);
  const commandB = sequenceCommand([{ text: 'b\n', delayMs: 300 }]);

  const startedAt = Date.now();
  const result = await runCommands([commandA, commandB], {
    stdout: createCollector(),
    stderr: createCollector(),
  });
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 550, `expected concurrent run to take well under 600ms, took ${elapsed}ms`);
  assert.equal(result.outcomes.length, 2);
  assert.equal(result.exitCode, 0);
});

test('buffers later commands and flushes them in order once earlier ones finish', async () => {
  const commandA = sequenceCommand([
    { text: 'A1\n', delayMs: 0 },
    { text: 'A2\n', delayMs: 120 },
  ]);
  const commandB = sequenceCommand([{ text: 'B1\n', delayMs: 0 }]);

  const stdout = createCollector();
  const result = await runCommands([commandA, commandB], {
    stdout,
    stderr: createCollector(),
  });

  assert.equal(result.exitCode, 0);

  const output = stdout.text();
  const indexHeaderA = output.indexOf('[1/2]');
  const indexA1 = output.indexOf('A1');
  const indexA2 = output.indexOf('A2');
  const indexHeaderB = output.indexOf('[2/2]');
  const indexB1 = output.indexOf('B1');

  assert.ok(indexHeaderA < indexA1, 'A header must precede A1');
  assert.ok(indexA1 < indexA2, 'A1 must precede A2');
  assert.ok(indexA2 < indexHeaderB, 'command A output must fully precede command B header, even though B finished first');
  assert.ok(indexHeaderB < indexB1, 'B header must precede B1');
});

test('preserves stdout vs stderr per command', async () => {
  const command = sequenceCommand([
    { stream: 'stdout', text: 'out-line\n' },
    { stream: 'stderr', text: 'err-line\n' },
  ]);

  const stdout = createCollector();
  const stderr = createCollector();
  await runCommands([command], { stdout, stderr });

  assert.match(stdout.text(), /out-line/);
  assert.doesNotMatch(stdout.text(), /err-line/);
  assert.match(stderr.text(), /err-line/);
  assert.doesNotMatch(stderr.text(), /out-line/);
});

test('reports per-command exit codes and durations', async () => {
  const commandOk = sequenceCommand([{ text: 'ok\n' }], { exitCode: 0 });
  const commandFail = sequenceCommand([{ text: 'fail\n' }], { exitCode: 7 });

  const result = await runCommands([commandOk, commandFail], {
    stdout: createCollector(),
    stderr: createCollector(),
  });

  assert.equal(result.outcomes[0]?.exitCode, 0);
  assert.equal(result.outcomes[1]?.exitCode, 7);
  assert.ok(result.outcomes[0] && result.outcomes[0].durationMs >= 0);
  assert.ok(result.totalDurationMs >= 0);
});

test('propagates the exit code of the last failed command in argument order', async () => {
  const command1 = sequenceCommand([], { exitCode: 2 });
  const command2 = sequenceCommand([], { exitCode: 0 });
  const command3 = sequenceCommand([], { exitCode: 5 });

  const result = await runCommands([command1, command2, command3], {
    stdout: createCollector(),
    stderr: createCollector(),
  });

  assert.equal(result.exitCode, 5);
});

test('a single failing command in the middle still propagates its own exit code', async () => {
  const command1 = sequenceCommand([], { exitCode: 0 });
  const command2 = sequenceCommand([], { exitCode: 3 });
  const command3 = sequenceCommand([], { exitCode: 0 });

  const result = await runCommands([command1, command2, command3], {
    stdout: createCollector(),
    stderr: createCollector(),
  });

  assert.equal(result.exitCode, 3);
});

test('exit code is 0 when every command succeeds', async () => {
  const result = await runCommands(
    [sequenceCommand([], { exitCode: 0 }), sequenceCommand([], { exitCode: 0 })],
    { stdout: createCollector(), stderr: createCollector() },
  );

  assert.equal(result.exitCode, 0);
});

test('returns immediately for an empty command list', async () => {
  const result = await runCommands([]);
  assert.deepEqual(result.outcomes, []);
  assert.equal(result.exitCode, 0);
});

test('aborting terminates still-running commands', async () => {
  const controller = new AbortController();
  const command = sequenceCommand([{ text: 'before\n', delayMs: 50 }, { text: 'after\n', delayMs: 5000 }]);

  const resultPromise = runCommands([command], {
    stdout: createCollector(),
    stderr: createCollector(),
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(), 200);

  const startedAt = Date.now();
  const result = await resultPromise;
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 4000, `expected abort to terminate the command quickly, took ${elapsed}ms`);
  assert.equal(result.outcomes[0]?.signal, 'SIGTERM');
});
