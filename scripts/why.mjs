/**
 * Explain why a file fails, by putting our first parse error next to the reference
 * parser's view of the same spot.
 *
 * Usage:
 *   node scripts/why.mjs <file.typ>          first error, with source context
 *   node scripts/why.mjs <file.typ> --tree   plus both parse trees around the error
 *   node scripts/why.mjs --sample <dir> [n]  first error of each of n failing files,
 *                                            grouped so the common cause is obvious
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  listTypFiles, oracleBatch, tsBatchSummary, tsParseSexp, parseSexpNodes, color, rel, ROOT,
} from '../test/lib/harness.mjs';
import { execFileSync } from 'node:child_process';

const ORACLE = path.join(
  ROOT, 'tools', 'oracle', 'target', 'release',
  process.platform === 'win32' ? 'typst-oracle.exe' : 'typst-oracle',
);

/**
 * The *narrowest* ERROR/MISSING node, which is the one that actually localizes the
 * problem. A failure anywhere often makes the root an `ERROR` spanning the whole file,
 * so reporting the first error by position would blame line 1 of every broken file and
 * bucket unrelated causes together.
 */
function firstError(file) {
  const sexp = tsParseSexp(file);
  const re = /\((ERROR|MISSING)[^[]*\[(\d+), (\d+)\] - \[(\d+), (\d+)\]/g;
  let m;
  let best = null;
  while ((m = re.exec(sexp)) !== null) {
    const node = {
      kind: m[1],
      row: Number(m[2]), col: Number(m[3]),
      endRow: Number(m[4]), endCol: Number(m[5]),
    };
    const size = (node.endRow - node.row) * 1000 + (node.endCol - node.col);
    if (!best || size < best.size) best = { ...node, size };
  }
  return best;
}

function showContext(file, row, col) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = Math.max(0, row - 2); i <= Math.min(lines.length - 1, row + 2); i++) {
    const mark = i === row ? color.red('>') : ' ';
    console.log(`  ${mark} ${String(i + 1).padStart(4)} | ${lines[i]}`);
    if (i === row) console.log(`         | ${' '.repeat(col)}${color.red('^')}`);
  }
}

/**
 * Locate the first byte offset where our tree structurally diverges from typst's.
 *
 * A single bad token usually makes tree-sitter's root one `ERROR` spanning the whole
 * file, so neither the error's position nor prefix-bisection says anything useful —
 * bisection just finds the first point at which the file happens to be syntactically
 * complete. Comparing the two token streams instead pinpoints the real divergence: the
 * first node typst produces that has no node starting at the same offset in ours.
 */
function divergence(file) {
  const buf = fs.readFileSync(file);
  const theirs = JSON.parse(
    execFileSync(ORACLE, ['stdin'], { input: buf.toString('utf8'), encoding: 'utf8' }),
  );
  if (!theirs.ok) return null;

  const ours = parseSexpNodes(tsParseSexp(file), buf);
  const ourStarts = new Set(ours.map((n) => n.start));

  for (const [start, end, kind] of theirs.nodes) {
    if (start === end) continue;             // zero-width bookkeeping nodes
    if (UNINTERESTING.has(kind)) continue;   // punctuation we never name
    if (!ourStarts.has(start)) {
      // Translate the byte offset back to a line and column.
      let row = 0, lineStart = 0;
      for (let i = 0; i < start && i < buf.length; i++) {
        if (buf[i] === 0x0a) { row++; lineStart = i + 1; }
      }
      return { offset: start, row, col: start - lineStart, kind };
    }
  }
  return null;
}

/** typst kinds that are punctuation or keywords, which we never emit as named nodes. */
const UNINTERESTING = new Set([
  'Hash', 'LeftBrace', 'RightBrace', 'LeftBracket', 'RightBracket', 'LeftParen',
  'RightParen', 'Comma', 'Semicolon', 'Colon', 'Star', 'Underscore', 'Dollar',
  'Plus', 'Minus', 'Slash', 'Hat', 'Dot', 'Eq', 'EqEq', 'ExclEq', 'Lt', 'LtEq',
  'Gt', 'GtEq', 'PlusEq', 'HyphEq', 'StarEq', 'SlashEq', 'Dots', 'Arrow', 'Root',
  'Bang', 'Not', 'And', 'Or', 'Let', 'Set', 'Show', 'Context', 'If', 'Else', 'For',
  'In', 'While', 'Break', 'Continue', 'Return', 'Import', 'Include', 'As',
  'HeadingMarker', 'ListMarker', 'EnumMarker', 'TermMarker', 'RefMarker',
  'RawDelim', 'RawTrimmed',
]);

function explainOne(file, showTree) {
  const err = firstError(file);
  console.log(color.bold(`\n${rel(file)}`));
  if (!err) {
    console.log(color.green('  parses cleanly'));
    return;
  }

  // An error node covering most of the file localizes nothing; use the token streams.
  const lineCount = fs.readFileSync(file, 'utf8').split('\n').length;
  if (err.endRow - err.row > Math.min(5, lineCount - 1)) {
    const d = divergence(file);
    if (d) {
      console.log(color.dim(
        `  first divergence at line ${d.row + 1}, column ${d.col + 1}: ` +
        `typst has ${color.bold(d.kind)} here, we have nothing starting at this offset`,
      ));
      showContext(file, d.row, d.col);
      console.log(color.yellow('\n  typst accepts this file, so the gap is ours.'));
      if (showTree) {
        console.log(color.dim('\n  typst tree:'));
        const dump = execFileSync(ORACLE, ['dump', file], { encoding: 'utf8' });
        const near = dump.split('\n').filter((l) => l.includes(`${d.offset}..`));
        console.log(near.slice(0, 15).map((l) => `    ${l.trim()}`).join('\n'));
      }
      return;
    }
  }

  console.log(color.dim(`  our first ${err.kind} at line ${err.row + 1}, column ${err.col + 1}`));
  showContext(file, err.row, err.col);

  const check = JSON.parse(execFileSync(ORACLE, ['check', file], { encoding: 'utf8' }));
  if (check.ok) {
    console.log(color.yellow('\n  typst accepts this file, so the gap is ours.'));
  } else {
    console.log(color.dim(`\n  typst also rejects it: ${check.errors.map((e) => e.msg).join('; ')}`));
  }

  if (showTree) {
    console.log(color.dim('\n  typst tree around the error:'));
    const dump = execFileSync(ORACLE, ['dump', file], { encoding: 'utf8' });
    console.log(dump.split('\n').slice(0, 60).map((l) => `    ${l}`).join('\n'));
  }
}

const args = process.argv.slice(2);

if (args[0] === '--sample') {
  const dir = args[1] ?? 'corpus';
  const limit = Number(args[2] ?? 15);
  const files = listTypFiles(path.resolve(ROOT, dir));
  const oracle = oracleBatch(files);
  const ours = tsBatchSummary(files);

  const bad = files.filter((f) => {
    const k = path.resolve(f);
    const o = oracle.get(k), t = ours.get(k);
    return o && t && o.ok && !t.ok;
  });

  console.log(`${bad.length} false rejects in ${dir}\n`);

  // Group by the source line that failed, so a shared root cause shows up as one bucket
  // rather than as N separate-looking files.
  const buckets = new Map();
  for (const f of bad.slice(0, 400)) {
    const err = firstError(f);
    if (!err) continue;
    // Prefer the token-stream divergence when the error node is too wide to localize.
    let row = err.row;
    const lineCount = fs.readFileSync(f, 'utf8').split('\n').length;
    if (err.endRow - err.row > Math.min(5, lineCount - 1)) {
      const d = divergence(f);
      if (d) row = d.row;
    }
    const line = (fs.readFileSync(f, 'utf8').split('\n')[row] ?? '').trim().slice(0, 70);
    const key = line.replace(/["'][^"']*["']/g, '"…"').replace(/\b\w{4,}\b/g, 'W');
    if (!buckets.has(key)) buckets.set(key, { count: 0, sample: line, file: f });
    buckets.get(key).count++;
  }

  const sorted = [...buckets.values()].sort((a, b) => b.count - a.count);
  for (const b of sorted.slice(0, limit)) {
    console.log(`  ${String(b.count).padStart(4)}x  ${JSON.stringify(b.sample)}`);
    console.log(color.dim(`        ${rel(b.file)}`));
  }
} else if (args.length) {
  explainOne(path.resolve(args[0]), args.includes('--tree'));
} else {
  console.error('usage: node scripts/why.mjs <file.typ> [--tree] | --sample <dir> [n]');
  process.exit(2);
}
