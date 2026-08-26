/**
 * Shrink a failing file down to a minimal reproduction.
 *
 *   node scripts/shrink.mjs path/to/file.typ [--math]
 *
 * Delta debugging against the oracle. The invariant held at every step is the failure
 * itself — typst accepts the snippet AND our parse contains `ERROR`/`MISSING` — so
 * whatever survives still reproduces. Lines go first, then characters.
 *
 * This exists because the interesting bugs do not localize. A grammar failure usually
 * produces one `ERROR` node spanning the entire file, so "our first error is at line 1"
 * tells you nothing; `why.mjs` falls back to token-stream divergence, which points at the
 * first *symptom* rather than the cause. Shrinking finds the cause by construction.
 *
 * Two things had to be learned the hard way, and both are load-bearing:
 *
 *   - `tree-sitter parse` exits non-zero both when the file has errors and when the tool
 *     fails to run. Conflating them makes every trial look like a reproduction and the
 *     shrink returns confident nonsense, so a run failure throws here.
 *
 *   - Deleting a closing delimiter lands on input that typst accepts for an unrelated
 *     reason — a top-level unmatched `[` is plain text — which satisfies the invariant
 *     while reproducing a completely different bug. Shrink steps therefore have to keep
 *     the delimiters balanced. Pass `--math` when the snippet is inside `$...$`, where
 *     parens and braces are ordinary symbols and need not balance.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, TS_BIN, color } from '../test/lib/harness.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const MATH = args.includes('--math');

if (!file) {
  console.error('usage: node scripts/shrink.mjs <file.typ> [--math]');
  process.exit(2);
}

const ORACLE = path.join(ROOT, 'tools', 'oracle', 'target', 'release',
                         process.platform === 'win32' ? 'typst-oracle.exe' : 'typst-oracle');
const TRIAL = path.join(ROOT, '.tmp', 'shrink.typ');
fs.mkdirSync(path.dirname(TRIAL), { recursive: true });

// In math, `(`, `)`, `{` and `}` are symbols rather than grouping, and `_`/`*` are
// attachment operators rather than delimiters, so only brackets and `$` must balance.
const PAIRS = MATH ? [['[', ']']] : [['[', ']'], ['(', ')'], ['{', '}']];
const EVEN = MATH ? ['$', '`'] : ['$', '`', '_', '*', '"'];
const count = (t, ch) => t.split(ch).length - 1;

/**
 * A fingerprint of the delimiter structure: the imbalance of each pair, and the parity of
 * each self-closing delimiter.
 *
 * Trials must keep the *starting file's* fingerprint, not reach some absolute balance.
 * Demanding real balance rejects perfectly ordinary inputs — a file containing one `(` in
 * prose never balances, and the shrink would refuse to start. Preserving the fingerprint
 * is what actually matters: it stops a step from deleting a lone closing bracket and
 * landing on input typst accepts for a completely different reason.
 */
function fingerprint(t) {
  return [
    ...PAIRS.map(([open, close]) => count(t, open) - count(t, close)),
    ...EVEN.map((ch) => count(t, ch) % 2),
  ].join(',');
}

/** Whether our parse of the trial file contains ERROR or MISSING. Throws if the CLI
 *  itself failed, which must not be mistaken for a parse error. */
function oursErrors() {
  let out;
  try {
    out = execFileSync(TS_BIN, ['parse', TRIAL],
                       { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = e.stdout;
    if (typeof out !== 'string' || out === '') {
      throw new Error(`tree-sitter could not parse ${TRIAL}: ${e.message}`);
    }
  }
  return /ERROR|MISSING/.test(out);
}

function typstAccepts() {
  return JSON.parse(execFileSync(ORACLE, ['check', TRIAL], { encoding: 'utf8' })).ok;
}

let trials = 0;

let baseline = null;

function reproduces(text) {
  if (!text.trim()) return false;
  if (baseline !== null && fingerprint(text) !== baseline) return false;
  trials++;
  fs.writeFileSync(TRIAL, text);
  return typstAccepts() && oursErrors();
}

let text = fs.readFileSync(file, 'utf8');
baseline = fingerprint(text);

if (!reproduces(text)) {
  console.log(color.yellow(
    'This file does not reproduce a false reject: either typst rejects it too, or we ' +
    'already parse it cleanly.'));
  process.exit(1);
}

// Lines first — far fewer trials, and it usually gets within a few lines of the cause.
{
  let lines = text.split('\n');
  for (let chunk = Math.ceil(lines.length / 2); chunk >= 1; chunk = Math.floor(chunk / 2)) {
    let i = 0;
    while (i < lines.length) {
      const trial = [...lines.slice(0, i), ...lines.slice(i + chunk)];
      if (trial.length < lines.length && reproduces(trial.join('\n'))) lines = trial;
      else i += chunk;
    }
    if (chunk === 1) break;
  }
  text = lines.join('\n');
}

// Then characters, which is what gets it down to something you can read at a glance.
for (let span = 64; span >= 1; span = Math.floor(span / 2)) {
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = 0; i + span <= text.length; ) {
      const trial = text.slice(0, i) + text.slice(i + span);
      if (reproduces(trial)) { text = trial; progress = true; }
      else i++;
    }
  }
  if (span === 1) break;
}

// Re-verify and persist. The loop's last write is whatever trial ran last, which may have
// failed — reporting a result without writing it again is how you end up quoting a
// snippet that does not actually reproduce.
const holds = reproduces(text);
fs.writeFileSync(TRIAL, text);

console.log(`\n${color.bold(`${text.length} chars`)} after ${trials} trials, written to ` +
            `${path.relative(ROOT, TRIAL).replace(/\\/g, '/')}`);
console.log(holds ? color.green('  re-verified: still reproduces')
                  : color.red('  re-verification FAILED — do not trust this output'));
console.log(`${'-'.repeat(60)}\n${text}\n${'-'.repeat(60)}`);
