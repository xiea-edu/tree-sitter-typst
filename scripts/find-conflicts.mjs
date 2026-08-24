/**
 * Iteratively discover which grammar conflicts tree-sitter needs declared.
 *
 * Running `tree-sitter generate` reports one unresolved conflict at a time, along with
 * the rules involved. Resolving them by hand is a slow round-trip, so this applies the
 * suggested conflict, regenerates, and repeats.
 *
 * This is a *development aid*, not an auto-fixer to trust blindly: every conflict it
 * proposes should be reviewed. A conflict declaration tells the GLR parser to explore
 * both interpretations, which is correct when the ambiguity is genuine (Typst's `(`
 * really is ambiguous until you read to the matching paren) and a performance and
 * correctness hazard when it is papering over a badly-factored rule.
 *
 * Usage: node scripts/find-conflicts.mjs [maxIterations]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, TS_BIN } from '../test/lib/harness.mjs';

const MAX = Number(process.argv[2] ?? 30);
const GRAMMAR = path.join(ROOT, 'grammar.js');
const MARKER = '// AUTO-DISCOVERED CONFLICTS';

const added = [];

for (let i = 0; i < MAX; i++) {
  let err = '';
  try {
    execFileSync(TS_BIN, ['generate'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    console.log(`\nGenerated cleanly after adding ${added.length} conflict(s).`);
    for (const a of added) console.log(`  [${a.join(', ')}]`);
    process.exit(0);
  } catch (e) {
    err = (e.stderr ?? '') + (e.stdout ?? '');
  }

  const m = err.match(/Add a conflict for these rules: (.+)/);
  if (!m) {
    console.error('\nNo further conflict suggestion. Remaining error:\n');
    console.error(err.trim().split('\n').slice(0, 25).join('\n'));
    process.exit(1);
  }

  const rules = m[1].split(',').map((s) => s.trim().replace(/^`|`$/g, ''));
  const entry = rules.map((r) => (r.startsWith('_') ? `$.${r}` : `$.${r}`)).join(', ');
  added.push(rules);
  console.log(`  + [${rules.join(', ')}]`);

  let src = fs.readFileSync(GRAMMAR, 'utf8');
  if (!src.includes(MARKER)) {
    src = src.replace(/(\n  \],\n\n  rules:)/, `\n\n    ${MARKER}\n$1`);
  }
  src = src.replace(MARKER, `${MARKER}\n    [${entry}],`);
  fs.writeFileSync(GRAMMAR, src, 'utf8');
}

console.error(`\nStill unresolved after ${MAX} iterations — the grammar likely needs restructuring, not more conflicts.`);
process.exit(1);
