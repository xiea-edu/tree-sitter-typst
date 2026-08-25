/**
 * Run the validity-agreement test against other tree-sitter Typst grammars.
 *
 * Tier 1 is the only tier that ports across grammars unchanged: it asks nothing about
 * node names, only whether a file parses without `ERROR`/`MISSING`, and compares that
 * against the reference parser's verdict. Tier 2 would need a hand-written kind map per
 * grammar, so it is not attempted here.
 *
 * Usage:
 *   node scripts/compare-parsers.mjs <dir> [<dir> ...]
 *
 * Each <dir> is a tree-sitter grammar directory containing a generated `src/parser.c`.
 * This one is included automatically.
 *
 * Caveats worth stating whenever the numbers are quoted:
 *   - Other grammars may target a different Typst version. The oracle is pinned to
 *     0.15.1, so constructs newer than a grammar's target count against it unfairly.
 *   - They may have deliberately different goals — a grammar aiming only at
 *     highlighting can reasonably accept more than the language does.
 *   - "False accept" is measured against files the real parser rejects, and a corpus of
 *     real documents contains few of those, so it is a weak signal here compared with
 *     the false-reject count.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, corpusGroups, oracleBatch, TS_BIN, color, pct } from '../test/lib/harness.mjs';

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error('usage: node scripts/compare-parsers.mjs <grammar-dir> [...]');
  process.exit(2);
}

/**
 * Delete tree-sitter's compiled-parser cache entry for `typst`.
 *
 * This is essential and easy to miss: the cache is keyed by *language name*, and every
 * Typst grammar is called `typst`. Without clearing it, whichever grammar compiled first
 * answers for all the others, and the comparison reports three identical scores — which
 * is exactly what happened before this was added.
 */
function clearParserCache() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'tree-sitter', 'lib')]
    : [path.join(home, '.cache', 'tree-sitter', 'lib'),
       path.join(home, 'Library', 'Caches', 'tree-sitter', 'lib')];

  for (const dir of candidates) {
    for (const ext of ['dll', 'so', 'dylib']) {
      fs.rmSync(path.join(dir, `typst.${ext}`), { force: true });
    }
  }
}

/** Ask one grammar which files it accepts. Runs from its own directory so the CLI picks
 *  up that grammar rather than ours. */
function summaryFor(dir, files) {
  clearParserCache();

  const listFile = path.join(ROOT, '.tmp', `cmp-paths-${path.basename(dir)}.txt`);
  fs.writeFileSync(listFile, files.join('\n'), 'utf8');
  let stdout;
  try {
    stdout = execFileSync(TS_BIN, ['parse', '--paths', listFile, '--json-summary', '-q'], {
      cwd: dir, maxBuffer: 1 << 30, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    });
  } catch (e) {
    stdout = e.stdout ?? '';
  } finally {
    fs.rmSync(listFile, { force: true });
  }

  const brace = stdout.indexOf('{');
  if (brace === -1) return null;
  const map = new Map();
  for (const s of JSON.parse(stdout.slice(brace)).parse_summaries ?? []) {
    map.set(path.resolve(s.file), s.successful);
  }
  return map;
}

const groups = corpusGroups();
const files = groups.flatMap((g) => g.files);
const suiteFiles = new Set((groups.find((g) => g.name === 'typst-suite')?.files ?? [])
  .map((f) => path.resolve(f)));

console.log(`Comparing on ${files.length} files (${suiteFiles.size} from typst's own suite)\n`);

const oracle = oracleBatch(files);
const rows = [];

for (const dir of [ROOT, ...dirs.map((d) => path.resolve(d))]) {
  const name = path.basename(dir) === path.basename(ROOT) ? 'this grammar' : path.basename(dir);
  process.stdout.write(`  parsing with ${name} ... `);

  const ours = summaryFor(dir, files);
  if (!ours) {
    console.log(color.red('failed to run'));
    rows.push({ name, failed: true });
    continue;
  }

  let agree = 0, total = 0, falseRejects = 0, falseAccepts = 0;
  let suiteAgree = 0, suiteTotal = 0;
  for (const f of files) {
    const key = path.resolve(f);
    const o = oracle.get(key);
    const t = ours.get(key);
    if (!o || t === undefined || o.read_error) continue;
    total++;
    const ok = o.ok === t;
    if (ok) agree++;
    else if (o.ok) falseRejects++;
    else falseAccepts++;
    if (suiteFiles.has(key)) {
      suiteTotal++;
      if (ok) suiteAgree++;
    }
  }
  console.log(color.green('done'));
  rows.push({ name, agree, total, falseRejects, falseAccepts, suiteAgree, suiteTotal });
}

console.log(`\n${'grammar'.padEnd(24)} ${'overall'.padStart(9)} ${'typst suite'.padStart(12)} ${'false rej'.padStart(10)} ${'false acc'.padStart(10)}`);
console.log('-'.repeat(70));
for (const r of rows) {
  if (r.failed) {
    console.log(`${r.name.padEnd(24)} ${color.red('could not run')}`);
    continue;
  }
  console.log(
    `${r.name.padEnd(24)} ${pct(r.agree, r.total).padStart(9)} ` +
    `${pct(r.suiteAgree, r.suiteTotal).padStart(12)} ` +
    `${String(r.falseRejects).padStart(10)} ${String(r.falseAccepts).padStart(10)}`,
  );
}
console.log(
  color.dim('\nOther grammars may target a different Typst version than the pinned 0.15.1 oracle,\n' +
            'and may have different goals. Treat this as a rough comparison, not a verdict.'),
);
