/**
 * Differential test suite for tree-sitter-typst.
 *
 *   node test/run.mjs valid        agreement with the reference parser on validity
 *   node test/run.mjs diff         agreement on node spans
 *   node test/run.mjs fuzz         robustness against malformed input
 *   node test/run.mjs incremental  incremental reparse == full reparse
 *   node test/run.mjs coverage     which Typst SyntaxKinds we handle
 *   node test/run.mjs all          everything, plus the golden corpus tests
 *
 * Flags: --limit=N (cap files per group), --show=N (failures to print), --quiet
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, corpusGroups, oracleBatch, oracleParseText, tsBatchSummary, tsParseSexp,
  tsParseNodes, parseSexpNodes, color, pct, rel, TS_BIN,
} from './lib/harness.mjs';
import { KIND_MAP, UNMAPPED_OK } from './lib/kind-map.mjs';

/*
 * Score floors, so the suite is a regression detector rather than a permanently red
 * light. Demanding perfection from a grammar at 98% would fail every run, and a check
 * that always fails is one nobody reads.
 */
const THRESHOLDS = JSON.parse(
  fs.readFileSync(new URL('./thresholds.json', import.meta.url), 'utf8'),
);

/** Compare a ratio against its floor, reporting the delta in either direction. */
function checkThreshold(label, actual, floor) {
  const asPct = (x) => `${(x * 100).toFixed(2)}%`;
  const delta = ((actual - floor) * 100).toFixed(2);
  if (actual + 1e-9 < floor) {
    fail(`${label} ${asPct(actual)} is below the ${asPct(floor)} floor (${delta} points)`);
  } else {
    pass(`${label} ${asPct(actual)} meets the ${asPct(floor)} floor (+${delta} points)`);
  }
}

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('--')) ?? 'all';
const numFlag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? Number(hit.split('=')[1]) : d;
};
const LIMIT = numFlag('limit', Infinity);
const SHOW = numFlag('show', 12);

let failed = false;
const fail = (msg) => { failed = true; console.log(color.red(`  FAIL  ${msg}`)); };
const pass = (msg) => console.log(color.green(`  ok    ${msg}`));
const head = (t) => console.log(`\n${color.bold(t)}`);

// ---------------------------------------------------------------------------
// Tier 1 — validity agreement
// ---------------------------------------------------------------------------
//
// For every corpus file, the reference parser tells us whether the source is genuinely
// valid Typst. Our grammar must reach the same verdict. This needs no mapping between
// the two node vocabularies, so it works from the very first day of grammar work and
// scales to the whole corpus.
//
// The two failure directions mean very different things, so they're reported apart:
//
//   false reject  typst accepts, we ERROR   -> our grammar is missing a construct
//   false accept  typst rejects, we accept  -> our grammar is too permissive
//
// False rejects are the number to drive down while building; false accepts matter more
// at the end, for error-recovery quality.

function tierValid() {
  head('Tier 1 — validity agreement');
  const groups = corpusGroups({ limit: LIMIT });
  let totalAgree = 0, total = 0;
  const falseRejects = [], falseAccepts = [];

  const perGroup = new Map();

  for (const g of groups) {
    const oracle = oracleBatch(g.files);
    const ours = tsBatchSummary(g.files);

    let agree = 0, seen = 0;
    for (const file of g.files) {
      const key = path.resolve(file);
      const o = oracle.get(key), t = ours.get(key);
      if (!o || !t || o.read_error) continue;
      total++;
      seen++;
      if (o.ok === t.ok) { agree++; totalAgree++; }
      else if (o.ok && !t.ok) falseRejects.push(file);
      else falseAccepts.push(file);
    }
    perGroup.set(g.name, { agree, seen });

    const rate = pct(agree, g.files.length);
    const line = `${g.name.padEnd(14)} ${String(agree).padStart(5)}/${String(g.files.length).padEnd(5)} ${rate}`;
    console.log(`  ${agree === g.files.length ? color.green(line) : color.yellow(line)}`);
  }

  console.log(`\n  ${color.bold('agreement')}  ${totalAgree}/${total}  ${color.bold(pct(totalAgree, total))}`);
  console.log(`  false rejects (we error, typst accepts): ${color.red(falseRejects.length)}`);
  console.log(`  false accepts (we accept, typst errors): ${color.yellow(falseAccepts.length)}`);

  if (falseRejects.length) {
    console.log(color.dim('\n  first false rejects — these are grammar gaps:'));
    for (const f of falseRejects.slice(0, SHOW)) {
      console.log(`    ${rel(f)}${firstErrorHint(f)}`);
    }
  }
  /*
   * The gate is the typst-suite group, not the whole corpus.
   *
   * `typst/typst@v0.15.1 tests/suite` is a fixed, version-pinned set, so its score is
   * the same on every machine. The Universe corpus is whatever the registry held on the
   * day it was fetched and however many packages were asked for, so its score drifts —
   * CI fetching 200 packages and a laptop fetching 600 do not produce the same number.
   * Gating on it would make the floor meaningless.
   */
  const suite = perGroup.get('typst-suite');
  if (suite && suite.seen) {
    checkThreshold('typst-suite validity', suite.agree / suite.seen,
                   THRESHOLDS.suiteValidityAgreement);
  } else {
    fail('the typst-suite corpus is missing; run `npm run corpus:fetch`');
  }

  const falseAcceptRatio = total ? falseAccepts.length / total : 0;
  if (falseAcceptRatio > THRESHOLDS.maxFalseAcceptRatio) {
    fail(`false accepts ${(falseAcceptRatio * 100).toFixed(2)}% exceed the ` +
         `${(THRESHOLDS.maxFalseAcceptRatio * 100).toFixed(2)}% limit`);
  }
  return { totalAgree, total, falseRejects, falseAccepts };
}

/** Locate the first ERROR/MISSING node in our tree, to point at the gap. */
function firstErrorHint(file) {
  const sexp = tsParseSexp(file);
  const m = sexp.match(/\((ERROR|MISSING)[^\[]*\[(\d+), (\d+)\]/);
  if (!m) return '';
  const line = Number(m[2]) + 1;
  let snippet = '';
  try {
    snippet = (fs.readFileSync(file, 'utf8').split('\n')[Number(m[2])] ?? '').trim().slice(0, 60);
  } catch { /* ignore */ }
  return color.dim(`  ${m[1]} at line ${line}: ${JSON.stringify(snippet)}`);
}

// ---------------------------------------------------------------------------
// Tier 2 — span agreement
// ---------------------------------------------------------------------------
//
// Tier 1 cannot see mis-structuring: a file can parse without error yet nest wrongly.
// Here we flatten both trees to (start, end, kind) and compare, mapping typst's
// SyntaxKind names onto our node names via test/lib/kind-map.mjs.
//
// Only files both parsers accept are compared — a tier-1 failure would just produce
// noise here.

function tierDiff() {
  head('Tier 2 — span agreement');
  if (Object.keys(KIND_MAP).length === 0) {
    console.log(color.dim('  kind map is empty; skipping until the grammar has nodes to map'));
    return;
  }

  const groups = corpusGroups({ limit: LIMIT });
  let filesCompared = 0, filesMatching = 0;
  const mismatches = [];
  const perGroup = new Map();

  for (const g of groups) {
    const oracle = oracleBatch(g.files);
    const ours = tsBatchSummary(g.files);
    let compared = 0, matching = 0;

    for (const file of g.files) {
      const key = path.resolve(file);
      const o = oracle.get(key), t = ours.get(key);
      if (!o || !t || !o.ok || !t.ok) continue;

      const buf = fs.readFileSync(file);
      const mine = tsParseNodes(file, buf);
      const theirs = o.nodes;

      const diff = compareSpans(theirs, mine, buf);
      filesCompared++;
      compared++;
      if (diff.length === 0) { filesMatching++; matching++; }
      else mismatches.push({ file, diff });
    }
    perGroup.set(g.name, { compared, matching });
    console.log(`  ${g.name.padEnd(14)} ${String(matching).padStart(5)}/${String(compared).padEnd(5)} ${pct(matching, compared)}`);
  }

  console.log(`\n  ${filesMatching}/${filesCompared} files structurally identical  ${color.bold(pct(filesMatching, filesCompared))}`);

  if (mismatches.length) {
    // Which kinds go wrong matters far more than which files do: one bad rule shows up
    // as thousands of mismatches spread across the corpus, and the histogram names it.
    const byKind = new Map();
    for (const { diff } of mismatches) {
      for (const d of diff) {
        const kind = d.split(' ')[0];
        byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
      }
    }
    const ranked = [...byKind.entries()].sort((a, b) => b[1] - a[1]);
    console.log(color.dim('\n  mismatches by kind:'));
    const cells = ranked.map(([k, n]) => `${k}(${n})`);
    for (let i = 0; i < cells.length; i += 5) {
      console.log(color.dim(`    ${cells.slice(i, i + 5).join('  ')}`));
    }

    console.log(color.dim('\n  examples:'));
    for (const { file, diff } of mismatches.slice(0, SHOW)) {
      console.log(`    ${rel(file)}`);
      for (const d of diff.slice(0, 2)) console.log(color.dim(`      ${d}`));
    }
  }

  // Gated on the version-pinned suite for the same reason as tier 1: the package corpus
  // is not the same set from one fetch to the next.
  const suite = perGroup.get('typst-suite');
  if (suite && suite.compared) {
    checkThreshold('typst-suite span agreement', suite.matching / suite.compared,
                   THRESHOLDS.spanAgreement);
  }
}

/**
 * Compare two flat node lists. Returns human-readable difference descriptions.
 * Kinds typst produces that we deliberately do not model are listed in UNMAPPED_OK.
 */
/**
 * Container kinds whose extent includes surrounding trivia in typst but not in ours.
 *
 * Typst's CST is lossless, so the `Markup` inside `[With ]` covers the trailing space
 * and the one inside `[\n  body\n]` covers both newlines. tree-sitter derives a node's
 * extent from its child tokens and leaves `extras` outside, so ours starts and ends at
 * the content. The structure is identical; only trivia ownership differs, so these are
 * compared against the whitespace-trimmed span as well as the literal one.
 */
const TRIVIA_OWNING = new Set(['Markup', 'Code']);

function compareSpans(theirs, mine, buf) {
  const have = new Set(mine.map((n) => `${n.start}:${n.end}:${n.kind}`));
  const out = [];

  /** True when no non-trivia node of typst's own lies inside this span. */
  const holdsOnlyTrivia = (start, end) =>
    !theirs.some(([s, e]) => s >= start && e <= end && !(s === start && e === end));

  /*
   * Typst splits a raw block's contents into one `Text` per line, after working out a
   * common dedent and emitting `RawTrimmed` nodes for the whitespace it removed. That is
   * a presentation decision about how the block will be laid out, not syntax an editor
   * needs, so we model the block as delimiters, an optional language tag and one content
   * span — and exclude typst's inner segmentation here rather than chase it.
   */
  const rawRanges = theirs.filter(([, , k]) => k === 'Raw').map(([s, e]) => [s, e]);
  const insideRaw = (start, end) =>
    rawRanges.some(([s, e]) => start >= s && end <= e && !(start === s && end === e));

  /**
   * The extent of a container's actual content, taken from typst's own children.
   *
   * Trimming whitespace off the reported span is not enough, because a content block may
   * open with comments: in `[\n  // note\n  #f()\n]` typst's `Markup` starts at the
   * newline while ours starts at `#f()`. The oracle has already dropped trivia — spaces
   * and comments alike — so the span covered by the remaining children is precisely what
   * our node should cover.
   */
  const innerExtent = (start, end) => {
    let s = Infinity, e = -Infinity;
    for (const [a, b] of theirs) {
      if (a >= start && b <= end && !(a === start && b === end)) {
        if (a < s) s = a;
        if (b > e) e = b;
      }
    }
    return s <= e ? [s, e] : null;
  };

  for (const [start, end, kind] of theirs) {
    const mapped = KIND_MAP[kind];
    if (mapped === null || mapped === undefined || UNMAPPED_OK.has(kind)) continue;

    // Typst's CST is lossless, so it wraps positions that hold nothing but trivia: an
    // empty content block still contains a zero-width `Markup`, and `[ ]` contains a
    // `Markup` around just the space. tree-sitter models neither, and not modelling them
    // is correct rather than a structural difference.
    if (start === end) continue;
    if (kind === 'Markup' && holdsOnlyTrivia(start, end)) continue;
    if (insideRaw(start, end)) continue;

    // An array of names means "any one of these is acceptable at this span" — used where
    // one typst kind legitimately corresponds to more than one of our nodes, e.g.
    // `Markup` is our `source_file` at the root and our `markup` when nested.
    const names = [].concat(mapped);
    const hit = (s, e) => names.some((name) => have.has(`${s}:${e}:${name}`));

    if (hit(start, end)) continue;

    // Only if the literal span misses is the trivia-adjusted one worth computing.
    if (TRIVIA_OWNING.has(kind)) {
      const inner = innerExtent(start, end);
      if (inner && hit(inner[0], inner[1])) continue;
    }

    out.push(`${kind} at ${start}..${end} -> expected ${names.join('|')}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tier 4a — fuzzing
// ---------------------------------------------------------------------------
//
// Mutated and truncated real files. We are not checking that the tree is *right* here —
// the input is usually nonsense — only that the parser survives it: no crash, no hang,
// no runaway. An external scanner makes all three genuinely reachable.

function tierFuzz() {
  head('Tier 4a — fuzz / robustness');
  const groups = corpusGroups({ limit: LIMIT });
  const files = groups.flatMap((g) => g.files);
  const ROUNDS = numFlag('rounds', 400);

  // Deterministic PRNG so a failure can be reproduced exactly from the seed.
  const SEED = numFlag('seed', 0x5eed);
  let state = SEED >>> 0;
  const rnd = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  const tmp = path.join(ROOT, '.tmp', 'fuzz.typ');
  const crashes = [];

  for (let i = 0; i < ROUNDS; i++) {
    const src = fs.readFileSync(pick(files), 'utf8');
    const mutated = mutate(src, rnd);
    fs.writeFileSync(tmp, mutated, 'utf8');
    try {
      // A timeout catches infinite loops; a nonzero exit from ERROR nodes is expected
      // and fine, so only a signal/timeout counts as a failure.
      execFileSync(
        TS_BIN,
        ['parse', tmp, '-q'],
        { cwd: ROOT, timeout: 10_000, stdio: 'ignore' },
      );
    } catch (e) {
      if (e.killed || e.signal || e.code === 'ETIMEDOUT') {
        crashes.push({ round: i, reason: e.signal ?? 'timeout', src: mutated.slice(0, 200) });
      }
    }
  }

  fs.rmSync(tmp, { force: true });
  if (crashes.length) {
    fail(`${crashes.length}/${ROUNDS} fuzz inputs crashed or hung (seed ${SEED})`);
    for (const c of crashes.slice(0, 3)) {
      console.log(color.dim(`    round ${c.round} (${c.reason}): ${JSON.stringify(c.src.slice(0, 120))}`));
    }
  } else {
    pass(`${ROUNDS} mutated inputs parsed without crash or hang (seed ${SEED})`);
  }
}

/** Apply one random structure-breaking mutation. */
function mutate(src, rnd) {
  const ops = ['truncate', 'delete', 'insert', 'duplicate', 'swap'];
  const op = ops[Math.floor(rnd() * ops.length)];
  const at = Math.floor(rnd() * Math.max(1, src.length));
  // Characters that drive Typst's mode switching, i.e. the ones most likely to
  // desynchronize an external scanner.
  const spicy = ['#', '$', '[', ']', '{', '}', '(', ')', '*', '_', '`', '\\', '\n', '<', '>', '@', '/', '-', '='];
  switch (op) {
    case 'truncate': return src.slice(0, at);
    case 'delete': return src.slice(0, at) + src.slice(at + 1 + Math.floor(rnd() * 20));
    case 'insert': return src.slice(0, at) + spicy[Math.floor(rnd() * spicy.length)].repeat(1 + Math.floor(rnd() * 4)) + src.slice(at);
    case 'duplicate': return src.slice(0, at) + src.slice(at, at + 50) + src.slice(at);
    default: {
      const b = Math.floor(rnd() * Math.max(1, src.length));
      const [i, j] = at < b ? [at, b] : [b, at];
      return src.slice(0, i) + src.slice(j, j + 30) + src.slice(i + 30, j) + src.slice(j);
    }
  }
}

// ---------------------------------------------------------------------------
// Tier 4b — incremental reparse equivalence
// ---------------------------------------------------------------------------
//
// Incrementally reparsing after an edit must yield exactly the tree a fresh parse of
// the edited text would. When it doesn't, the cause is almost always an external
// scanner whose serialize/deserialize loses state — the single nastiest class of bug in
// a tree-sitter grammar, and one almost no grammar tests for. Editors hit it constantly
// because they only ever parse incrementally.

function tierIncremental() {
  head('Tier 4b — incremental reparse equivalence');
  const groups = corpusGroups({ limit: LIMIT });
  const files = groups.flatMap((g) => g.files);
  const ROUNDS = numFlag('rounds', 150);

  const SEED = numFlag('seed', 0xed17);
  let state = SEED >>> 0;
  const rnd = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);

  const base = path.join(ROOT, '.tmp', 'inc-base.typ');
  const edited = path.join(ROOT, '.tmp', 'inc-edited.typ');
  const bad = [];
  let checked = 0;

  for (let i = 0; i < ROUNDS && i < files.length; i++) {
    const file = files[Math.floor(rnd() * files.length)];
    const srcBuf = fs.readFileSync(file);
    if (srcBuf.length < 8 || srcBuf.length > 40_000) continue;

    // Half the edits are benign (typing an ordinary word character, which usually keeps
    // the document valid) and half are mode-switching characters, which stress the
    // scanner hardest but usually break the document. The two are scored separately
    // below, because they answer different questions.
    const benign = rnd() < 0.5;
    const insert = benign
      ? 'abcxyz019'[Math.floor(rnd() * 9)]
      : ['#', '$', '[', '*', '`', ']'][Math.floor(rnd() * 6)];

    // Edits go to the CLI as BYTE offsets, and everything here works in bytes to match.
    //
    // Two traps, both of which produced phantom failures before being pinned down:
    //   - The `row,col` edit form mislocates edits around blank lines (on `\n\nhello`,
    //     `0,0` lands at byte 1), so byte offsets are used instead.
    //   - Slicing the JavaScript string would use UTF-16 code units, which drift from
    //     byte offsets as soon as the file contains non-ASCII text — and most of this
    //     corpus is not ASCII.
    let offset = Math.floor(rnd() * (srcBuf.length + 1));
    // Never split a multi-byte character: back up off any continuation byte.
    while (offset > 0 && offset < srcBuf.length && (srcBuf[offset] & 0xc0) === 0x80) offset--;

    const afterBuf = Buffer.concat([
      srcBuf.subarray(0, offset),
      Buffer.from(insert, 'utf8'),
      srcBuf.subarray(offset),
    ]);

    fs.writeFileSync(base, srcBuf);
    fs.writeFileSync(edited, afterBuf);

    // Incremental: parse the original, then apply the edit.
    const incremental = tsParseSexp(base, ['--edits', `${offset} 0 ${insert}`]);
    // Ground truth: parse the edited text from scratch.
    const fresh = tsParseSexp(edited);

    checked++;
    if (normalizeTree(incremental) === normalizeTree(fresh)) continue;

    // A divergence only proves a scanner bug when the edited document still parses
    // cleanly. Once a tree contains ERROR nodes the two runs are comparing recovery
    // heuristics, which tree-sitter does not promise to make identical between an
    // incremental and a full parse.
    const clean = !/\((ERROR|MISSING)/.test(fresh);
    bad.push({ file, offset, insert, clean });
  }

  fs.rmSync(base, { force: true });
  fs.rmSync(edited, { force: true });

  const real = bad.filter((b) => b.clean);
  const recovery = bad.length - real.length;

  if (real.length) {
    fail(`${real.length}/${checked} incremental reparses of VALID documents diverged (seed ${SEED})`);
    for (const b of real.slice(0, SHOW)) {
      console.log(color.dim(`    ${rel(b.file)} inserting ${JSON.stringify(b.insert)} at byte ${b.offset}`));
    }
  } else {
    pass(`${checked} edits reparsed identically to a full parse (seed ${SEED})`);
  }
  if (recovery) {
    console.log(color.dim(
      `  ${recovery} further divergences were on documents the edit made invalid, ` +
      'where incremental and full parses may recover differently',
    ));
  }
}

/**
 * Keep only the S-expression lines.
 *
 * The CLI also prints a warning banner and per-file timings, and the incremental run
 * emits an extra `Edit:` line that the full parse does not. That line is indented, so a
 * naive "starts with a space" filter keeps it and reports every single comparison as a
 * divergence — which is exactly what happened before this was tightened.
 */
function normalizeTree(sexp) {
  return sexp
    .split('\n')
    .filter((l) => /^\s*\(/.test(l))
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Coverage ledger
// ---------------------------------------------------------------------------
//
// Turns "is the grammar finished?" into a checklist: every SyntaxKind the reference
// parser actually produces on the corpus either maps to one of our nodes, or is
// explicitly listed as deliberately unmodelled.

function tierCoverage() {
  head('Coverage — Typst SyntaxKinds seen in the corpus');
  const groups = corpusGroups({ limit: LIMIT });
  const seen = new Map();

  for (const g of groups) {
    for (const rec of oracleBatch(g.files).values()) {
      for (const [, , kind] of rec.nodes ?? []) seen.set(kind, (seen.get(kind) ?? 0) + 1);
    }
  }

  const kinds = [...seen.entries()].sort((a, b) => b[1] - a[1]);
  const covered = kinds.filter(([k]) => KIND_MAP[k] !== undefined || UNMAPPED_OK.has(k));
  const missing = kinds.filter(([k]) => KIND_MAP[k] === undefined && !UNMAPPED_OK.has(k));

  console.log(`  ${covered.length}/${kinds.length} kinds handled  ${color.bold(pct(covered.length, kinds.length))}`);
  checkThreshold("kind coverage", kinds.length ? covered.length / kinds.length : 1,
                 THRESHOLDS.kindCoverage);
  if (missing.length) {
    console.log(color.dim('\n  not yet handled (most frequent first):'));
    const lines = missing.map(([k, n]) => `${k}(${n})`);
    for (let i = 0; i < lines.length; i += 6) {
      console.log(color.dim(`    ${lines.slice(i, i + 6).join('  ')}`));
    }
  }
  fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, '.tmp', 'coverage.json'),
    JSON.stringify({ total: kinds.length, covered: covered.length, missing: missing.map(([k, n]) => ({ kind: k, count: n })) }, null, 2),
  );
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
//
// A query that names a node the grammar no longer produces fails to compile, and in an
// editor that means highlighting silently stops working for the whole file. Renaming a
// node is exactly the kind of change that breaks them, so compiling every query against
// the current grammar belongs in the suite rather than in a reviewer's memory.

function tierQueries() {
  head('Queries');
  const dir = path.join(ROOT, 'queries');
  if (!fs.existsSync(dir)) {
    console.log(color.dim('  no queries yet'));
    return;
  }

  const sample = path.join(ROOT, '.tmp', 'query-sample.typ');
  fs.writeFileSync(sample, SAMPLE_DOC, 'utf8');

  let ok = 0;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.scm')).sort();
  for (const f of files) {
    try {
      execFileSync(TS_BIN, ['query', path.join(dir, f), sample], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'],
      });
      ok++;
    } catch (e) {
      fail(`queries/${f} does not compile`);
      console.log(color.dim(`    ${(e.stderr ?? '').trim().split('\n').slice(-2).join(' ')}`));
    }
  }
  fs.rmSync(sample, { force: true });
  if (ok === files.length) pass(`${ok} query files compile against the grammar`);
}

/** A document touching every construct the queries mention. */
const SAMPLE_DOC = `= Heading <lbl>
== Sub

Some *bold*, _emph_, \`raw\`, a ~ shorthand and a \\ linebreak.
See @ref and https://typst.app.

- list
+ enum
1. numbered
/ term: description

$ sum_(i=0)^n x_i / 2 $

\`\`\`rust
fn main() {}
\`\`\`

#let f(a, b: 2) = a + b
#let (x, _) = (1, 2)
#set text(size: 10pt)
#show heading: it => it.body
#import "m.typ": a, b as c
#context counter(page).get()
#{
  for i in range(3) { if i > 1 { break } else { continue } }
  while false { }
  return none
}
`;

// ---------------------------------------------------------------------------
// Golden corpus tests (tree-sitter test)
// ---------------------------------------------------------------------------

function tierGolden() {
  head('Tier 3 — golden corpus tests');
  const dir = path.join(ROOT, 'test', 'corpus');
  if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) {
    console.log(color.dim('  no corpus tests yet'));
    return;
  }
  try {
    const out = execFileSync(
      TS_BIN,
      ['test'], { cwd: ROOT, encoding: 'utf8' },
    );
    const totals = out.match(/(\d+) (?:tests? )?(?:passed|failed)/g);
    console.log(color.dim(out.trim().split('\n').slice(-4).join('\n')));
    pass(totals ? totals.join(', ') : 'all golden tests passed');
  } catch (e) {
    fail('golden corpus tests failed');
    console.log(color.dim((e.stdout ?? '').trim().split('\n').slice(-25).join('\n')));
  }
}

// ---------------------------------------------------------------------------

function generate() {
  execFileSync(
    TS_BIN,
    ['generate'], { cwd: ROOT, stdio: 'inherit' },
  );
}

const started = Date.now();
switch (cmd) {
  case 'valid': generate(); tierValid(); break;
  case 'diff': generate(); tierDiff(); break;
  case 'fuzz': generate(); tierFuzz(); break;
  case 'incremental': generate(); tierIncremental(); break;
  case 'coverage': tierCoverage(); break;
  case 'queries': generate(); tierQueries(); break;
  case 'all':
    generate();
    tierQueries();
    tierGolden();
    tierValid();
    tierDiff();
    tierFuzz();
    tierIncremental();
    tierCoverage();
    break;
  default:
    console.error(`unknown command: ${cmd}`);
    process.exit(2);
}

console.log(`\n${color.dim(`finished in ${((Date.now() - started) / 1000).toFixed(1)}s`)}`);
process.exit(failed ? 1 : 0);
