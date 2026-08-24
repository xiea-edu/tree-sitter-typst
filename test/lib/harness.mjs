/**
 * Shared plumbing for the differential test suite.
 *
 * Everything here talks to two parsers:
 *   - the *oracle*, `tools/oracle` wrapping typst-syntax (the real Typst parser)
 *   - *ours*, via the tree-sitter CLI
 *
 * Neither native node bindings nor a WASM build are available on this machine (no MSVC
 * toolchain for node-gyp, no emcc/docker for wasm), so we drive the tree-sitter CLI and
 * parse its output. The CLI batches via `--paths`, so this costs two processes for the
 * whole corpus rather than two per file.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CORPUS = path.join(ROOT, 'corpus');
const TMP = path.join(ROOT, '.tmp');

const ORACLE_BIN = path.join(
  ROOT, 'tools', 'oracle', 'target', 'release',
  process.platform === 'win32' ? 'typst-oracle.exe' : 'typst-oracle',
);

// ---------------------------------------------------------------------------
// corpus
// ---------------------------------------------------------------------------

/** Recursively collect `.typ` files under `dir`. */
export function listTypFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // `.cache` holds the downloaded tarballs, not source.
    if (entry.name === '.cache') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTypFiles(full));
    else if (entry.name.endsWith('.typ')) out.push(full);
  }
  return out.sort();
}

/**
 * The corpus, split by provenance so results can be reported separately: the Typst test
 * suite is the high-signal set (hand-written edge cases) and packages are the
 * real-world set.
 */
export function corpusGroups({ limit = Infinity } = {}) {
  const groups = [
    { name: 'typst-suite', files: listTypFiles(path.join(CORPUS, 'typst-suite')) },
    { name: 'packages', files: listTypFiles(path.join(CORPUS, 'packages')) },
  ].filter((g) => g.files.length);

  if (!groups.length) {
    console.error('No corpus found. Run: npm run corpus:fetch');
    process.exit(1);
  }
  if (limit !== Infinity) for (const g of groups) g.files = g.files.slice(0, limit);
  return groups;
}

// ---------------------------------------------------------------------------
// oracle (reference parser)
// ---------------------------------------------------------------------------

export function ensureOracle() {
  if (fs.existsSync(ORACLE_BIN)) return;
  console.error(`Oracle binary missing at ${ORACLE_BIN}\nRun: npm run oracle:build`);
  process.exit(1);
}

/**
 * Run the reference parser over `files`.
 * @returns {Map<string, {ok: boolean, len: number, errors: any[], nodes: [number,number,string][]}>}
 */
export function oracleBatch(files) {
  ensureOracle();
  const stdout = execFileSync(ORACLE_BIN, ['batch'], {
    input: files.join('\0') + '\0',
    maxBuffer: 1 << 30,
    encoding: 'utf8',
  });
  const map = new Map();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    map.set(path.resolve(rec.path), rec);
  }
  return map;
}

/** Parse a single source string with the reference parser. */
export function oracleParseText(text) {
  ensureOracle();
  const stdout = execFileSync(ORACLE_BIN, ['stdin'], {
    input: text,
    maxBuffer: 1 << 28,
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

// ---------------------------------------------------------------------------
// our parser (tree-sitter CLI)
// ---------------------------------------------------------------------------

/**
 * Path to the real tree-sitter executable.
 *
 * Deliberately not `node_modules/.bin/tree-sitter` — that is a `.cmd` shim on Windows,
 * and Node refuses to spawn `.cmd` without a shell.
 */
export const TS_BIN = path.join(
  ROOT, 'node_modules', 'tree-sitter-cli',
  process.platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter',
);

function treeSitter(args, opts = {}) {
  const bin = TS_BIN;
  return execFileSync(bin, args, {
    cwd: ROOT,
    maxBuffer: 1 << 30,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

fs.mkdirSync(TMP, { recursive: true });

/**
 * Ask our parser which files parse cleanly.
 * @returns {Map<string, {ok: boolean, bytes: number}>}
 */
export function tsBatchSummary(files) {
  const listFile = path.join(TMP, `paths-${process.pid}.txt`);
  fs.writeFileSync(listFile, files.join('\n'), 'utf8');
  let stdout;
  try {
    // A corpus containing deliberately-invalid files makes the CLI exit nonzero; that
    // is data, not a harness failure, so read stdout either way.
    stdout = treeSitter(['parse', '--paths', listFile, '--json-summary', '-q']);
  } catch (e) {
    stdout = e.stdout ?? '';
  } finally {
    fs.rmSync(listFile, { force: true });
  }

  const json = JSON.parse(stdout.slice(stdout.indexOf('{')));
  const map = new Map();
  for (const s of json.parse_summaries ?? []) {
    map.set(path.resolve(s.file), { ok: s.successful, bytes: s.bytes });
  }
  return map;
}

/** Parse one file with our parser, returning the raw S-expression text. */
export function tsParseSexp(file, extraArgs = []) {
  try {
    return treeSitter(['parse', file, ...extraArgs]);
  } catch (e) {
    // Nonzero exit just means the tree contains ERROR nodes; the tree is still printed.
    return e.stdout ?? '';
  }
}

/** Parse one file and return its nodes as flat pre-order records with byte offsets. */
export function tsParseNodes(file, sourceBuf) {
  return parseSexpNodes(tsParseSexp(file), sourceBuf);
}

/**
 * Parse `file`, apply `edits`, and return the incrementally-updated tree.
 * Edit format is the CLI's: `"row,col deleteCount insertText"`.
 */
export function tsParseWithEdits(file, edits, sourceBuf) {
  return parseSexpNodes(tsParseSexp(file, ['--edits', ...edits]), sourceBuf);
}

// ---------------------------------------------------------------------------
// S-expression parsing + position conversion
// ---------------------------------------------------------------------------

/**
 * Byte offset for a tree-sitter (row, column) point.
 *
 * tree-sitter columns are byte counts within the line, not character counts, so this is
 * an exact conversion as long as both sides read identical bytes — which is why the
 * corpus is normalized to LF at fetch time.
 */
export function makeLineIndex(buf) {
  const starts = [0];
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) starts.push(i + 1);
  return (row, col) => (row < starts.length ? starts[row] + col : buf.length);
}

/**
 * Tokenize the tree-sitter CLI's S-expression output into flat pre-order records.
 *
 * Output looks like:
 *   (source_file [0, 0] - [3, 0]
 *     (heading [0, 0] - [0, 9]
 *       field: (text [0, 2] - [0, 9])))
 *
 * @returns {{start:number,end:number,kind:string,depth:number}[]}
 */
export function parseSexpNodes(text, sourceBuf) {
  const toByte = makeLineIndex(sourceBuf);
  const nodes = [];
  // (name [r, c] - [r, c]
  const re = /\(([A-Za-z_][A-Za-z0-9_]*|ERROR|MISSING|UNEXPECTED)\s+\[(\d+),\s*(\d+)\]\s*-\s*\[(\d+),\s*(\d+)\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    nodes.push({
      kind: m[1],
      start: toByte(+m[2], +m[3]),
      end: toByte(+m[4], +m[5]),
    });
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

export const color = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

export function pct(n, d) {
  return d === 0 ? '100.00%' : `${((n / d) * 100).toFixed(2)}%`;
}

export function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}
