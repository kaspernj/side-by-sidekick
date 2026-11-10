// @ts-check
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const configText = readFileSync(new URL('../tensorbuzz.yml', import.meta.url), 'utf8');

/** Nothing any gate reads: a delivery touching only these must be filtered out. */
const filesOutsideEveryGate = ['README.md', 'LICENSE', '.gitignore'];

/**
 * Repo-root build configs. TensorBuzz runs every build when one of them changed, so
 * they never need a `paths` entry and must never be listed as docs-only.
 */
const alwaysBuiltFiles = ['tensorbuzz.yml', 'peak_flow.yml'];

/** Directories that are build output or tooling, never repository source. */
const ignoredDirectories = new Set(['.git', 'node_modules', 'build']);

/**
 * Reads the `paths:` list out of tensorbuzz.yml. The assertions here are stricter
 * than the YAML TensorBuzz parses with js-yaml on purpose: `- !docs/**` is a YAML
 * scalar tag rather than a string, so an unquoted entry has to fail here instead of
 * turning into a config error on every lane of every open pull request.
 *
 * @param {string} text Contents of a tensorbuzz.yml.
 * @returns {string[]} The declared patterns, in declaration order.
 */
function readPathPatterns(text) {
  const lines = text.split('\n');
  const start = lines.indexOf('paths:');
  assert.notEqual(start, -1, 'tensorbuzz.yml must declare a paths: list');

  /** @type {string[]} */
  const patterns = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim().length === 0 || line.startsWith('#')) continue;
    if (!line.startsWith('  - ')) break;
    const entry = line.slice(4).trim();
    assert.match(entry, /^"([^"]+)"$/, `every paths entry must be a quoted string, got ${JSON.stringify(line)}`);
    patterns.push(entry.slice(1, -1));
  }

  assert.ok(patterns.length > 0, 'paths must declare at least one pattern');

  for (const pattern of patterns) {
    const body = pattern.startsWith('!') ? pattern.slice(1) : pattern;
    assert.ok(body.length > 0, `paths entry ${JSON.stringify(pattern)} has no pattern after "!"`);
    const literals = body.endsWith('/**') ? body.slice(0, -3) : body;
    assert.ok(
      !/[*?[\]]/.test(literals),
      `paths entry ${JSON.stringify(pattern)} uses a glob shape this test does not model - extend the test deliberately before using it`,
    );
  }

  return patterns;
}

/**
 * Mirrors the shipped path-filter grammar for the shapes tensorbuzz.yml declares:
 * a pattern containing `/` is anchored at the repository root, a bare name matches
 * at any depth, a matched directory covers everything below it, and the last
 * matching rule wins - which is what lets `["docs/**", "!docs/api/**"]` carve a
 * subtree out of a directory rule.
 *
 * @param {string} filePath Repository-relative file path.
 * @param {string[]} patterns Ordered patterns from `paths`.
 * @returns {boolean} True when the file counts as a change this build depends on.
 */
function dependsOn(filePath, patterns) {
  let dependedOn = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    const body = negated ? pattern.slice(1) : pattern;
    const directory = body.endsWith('/**') ? body.slice(0, -3) : null;
    const anchored = body.includes('/');
    const segments = filePath.split('/');
    const matched = directory
      ? anchored
        ? filePath === directory || filePath.startsWith(`${directory}/`)
        : segments.includes(directory)
      : anchored
        ? filePath === body
        : segments.at(-1) === body;
    if (matched) dependedOn = !negated;
  }
  return dependedOn;
}

/**
 * Every file checked into the repository, as repo-relative paths.
 *
 * @param {string} [directory] Absolute directory to walk.
 * @param {string} [prefix] Repo-relative prefix of that directory.
 * @returns {string[]} Sorted repo-relative file paths.
 */
function listRepositoryFiles(directory = repoRoot, prefix = '') {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const relativePath = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listRepositoryFiles(directory, relativePath));
    else files.push(relativePath);
  }
  return files.sort();
}

const patterns = readPathPatterns(configText);

test('tensorbuzz.yml declares paths, and every repository file is either a gate input or a known docs-only file', () => {
  const uncovered = listRepositoryFiles().filter(
    (file) =>
      !dependsOn(file, patterns) &&
      !alwaysBuiltFiles.includes(file) &&
      !filesOutsideEveryGate.includes(file),
  );

  assert.deepEqual(
    uncovered,
    [],
    `these files change what the CI build should check but no paths entry covers them: ${uncovered.join(', ')} - extend paths in tensorbuzz.yml`,
  );
});

test('a delivery that only touches documentation or git metadata is filtered out of the build', () => {
  for (const file of filesOutsideEveryGate) {
    assert.ok(existsSync(join(repoRoot, file)), `${file} is no longer in the repository - drop it from filesOutsideEveryGate`);
    assert.equal(dependsOn(file, patterns), false, `${file} must stay outside paths, otherwise a docs-only delivery rebuilds everything`);
  }
});

test('an unquoted paths entry is rejected locally instead of becoming a YAML tag on the builder', () => {
  assert.throws(
    () => readPathPatterns('paths:\n  - !docs/**\n'),
    /quoted string/,
  );
  assert.throws(
    () => readPathPatterns('paths:\n  - src/**\n'),
    /quoted string/,
  );
  assert.throws(() => readPathPatterns('paths:\nbefore_script:\n  - npm ci\n'), /at least one pattern/);
});

test('a negation carves its subtree out of the directory rule it follows', () => {
  assert.equal(dependsOn('src/cli.js', ['src/**']), true);
  assert.equal(dependsOn('src/docs/api.md', ['src/**', '!src/docs/**']), false);
  assert.equal(dependsOn('packages/tool/package.json', ['package.json']), true);
  assert.equal(dependsOn('README.md', ['src/**', '!docs/**']), false);
});
