import {spawn} from 'node:child_process';

const [mode] = process.argv.slice(2);

if (mode === 'success') {
  process.stdout.write('success stdout\n');
  process.stderr.write('success stderr\n');
  process.exit(0);
} else if (mode === 'non-zero') {
  process.stdout.write('failure stdout\n');
  process.stderr.write('failure stderr\n');
  process.exit(7);
} else if (mode === 'hang') {
  process.stdout.write(`ready:${process.pid}\n`);
  setInterval(() => {}, 60_000);
} else if (mode === 'ignore-term') {
  process.on('SIGTERM', () => process.stderr.write('ignored SIGTERM\n'));
  process.stdout.write(`ready:${process.pid}\n`);
  setInterval(() => {}, 60_000);
} else if (mode === 'noisy') {
  for (let index = 0; index < 2_048; index += 1) {
    process.stdout.write(`${String(index).padStart(4, '0')}:${'x'.repeat(1018)}\n`);
  }
  await new Promise((resolve) => process.stdout.write('USEFUL OUTPUT TAIL\n', resolve));
  process.exit(9);
} else if (mode === 'descendant') {
  setInterval(() => {}, 60_000);
} else if (mode === 'spawn-descendant') {
  const descendant = spawn(process.execPath, [new URL(import.meta.url).pathname, 'descendant'], {
    stdio: 'ignore',
  });
  process.stdout.write(`parent:${process.pid}\ndescendant:${descendant.pid}\n`);
  setInterval(() => {}, 60_000);
} else {
  throw new Error(`Unknown fixture mode: ${mode}`);
}
