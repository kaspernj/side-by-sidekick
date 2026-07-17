# side-by-sidekick

Run several shell commands **concurrently** while watching their output **one at a time, in
argument order** — like a well-behaved sidekick who lets everyone talk at once but only relays
one conversation to you at a time, in the order you asked to hear them.

A JavaScript/npm successor to [side_by_side](https://github.com/kaspernj/side_by_side), reimagined
as a zero-runtime-dependency CLI.

## Why

`command1 & command2 & wait` runs things concurrently, but interleaves their output into an
unreadable mess. Tools like `concurrently` prefix every line instead. side-by-sidekick takes a
third approach: every command starts immediately, but you only ever watch one command's output at
a time — output from commands further down the list is captured silently in the background and
replayed, in order, once it's their turn.

## Install

```sh
npm install --save-dev side-by-sidekick
```

Or run it without installing:

```sh
npx side-by-sidekick "npm test" "npm run lint"
```

## Usage

```sh
side-by-sidekick <command1> [command2] [...]
```

Each argument is a full shell command string (it's executed through the shell, so pipes,
redirects, and quoting inside the string all work as expected).

```sh
npx side-by-sidekick "npm test" "npm run lint" "npm run typecheck"
```

Running it with no commands is a usage error (exit code `1`, usage printed to stderr).

## Semantics

1. **All commands start immediately.** Nothing waits in a queue; every command is spawned as soon
   as the process starts.
2. **One command is "current" at a time**, starting with the first argument. Its header is printed
   as soon as it becomes current, and its output streams straight through live.
3. **Later commands run in the background.** Their stdout/stderr is captured but not printed while
   they're waiting their turn — even if they finish before the current command does.
4. **When the current command finishes**, the next command becomes current: its header is printed,
   everything it produced while waiting is flushed in the exact order it was generated, and then
   its live output continues streaming (if it's still running) until it, too, finishes.
5. **stdout and stderr are preserved as separate streams** throughout — output is never merged into
   one stream, just interleaved chronologically per command.
6. **Exit code propagation:** if every command succeeds, the overall exit code is `0`. If one or
   more commands fail, the overall exit code is that of the **last failing command in argument
   order** (not necessarily the last one to finish).
7. **A short summary** is printed at the end, listing each command with its exit status and
   duration, followed by the total wall-clock duration of the whole run.
8. **Ctrl-C (SIGINT)** terminates every still-running command (and its subprocesses) and the CLI
   exits with code `130`.

### Example

```sh
$ npx side-by-sidekick "node slow-lint.js" "node fast-tests.js"

>>> [1/2] node slow-lint.js
... (slow-lint.js's output, live, as it runs) ...

>>> [2/2] node fast-tests.js
... (fast-tests.js's output — even though it may have finished seconds ago, it only appears now) ...

--- Summary ---
  node slow-lint.js  ->  exit 0  (3.21s)
  node fast-tests.js  ->  exit 0  (0.45s)
Total duration: 3.22s
```

## Programmatic API

```js
import { runCommands } from 'side-by-sidekick';

const result = await runCommands(['npm test', 'npm run lint']);
// result.outcomes -> [{ command, exitCode, signal, durationMs }, ...] in argument order
// result.exitCode -> 0, or the exit code of the last failed command
// result.totalDurationMs -> wall-clock duration of the whole run
```

`runCommands(commands, options?)` accepts:

- `stdout` / `stderr` — objects with a `write(chunk: Buffer)` method (default:
  `process.stdout` / `process.stderr`). Handy for capturing output in tests or other tooling.
- `signal` — an `AbortSignal`; aborting terminates every still-running command.

## Requirements

Node.js 22 or later. No runtime dependencies.

## Development

```sh
npm install
npm run lint
npm run typecheck
npm test
npm run build
npm run package-dry-run
```

## License

MIT
