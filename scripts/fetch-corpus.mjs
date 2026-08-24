/**
 * Fetch real-world Typst source into `corpus/` for differential testing.
 *
 * The corpus is deliberately NOT committed. It is third-party Apache-2.0 material and
 * would bloat the repo; `corpus/` is gitignored and rebuilt on demand (and cached, so
 * re-runs are cheap).
 *
 * Two sources, in descending order of value per file:
 *
 *   1. `typst/typst@vN tests/suite/**\/*.typ` — the compiler's own test suite. These are
 *      adversarial edge cases written by the people who designed the language, so they
 *      exercise exactly the corners a grammar gets wrong.
 *   2. Typst Universe packages — ordinary real-world documents, which catch the opposite
 *      failure mode: common constructs we somehow never thought to test.
 *
 * Usage:
 *   node scripts/fetch-corpus.mjs                 # suite + 300 packages
 *   node scripts/fetch-corpus.mjs --packages=800
 *   node scripts/fetch-corpus.mjs --packages=0    # suite only
 *   node scripts/fetch-corpus.mjs --refresh       # ignore cache
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTarGz } from './tar.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = path.join(ROOT, 'corpus');
const CACHE = path.join(CORPUS, '.cache');

/** Typst version to pin the suite to. Keep in sync with tools/oracle/Cargo.toml. */
const TYPST_VERSION = '0.15.1';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? dflt : hit.split('=')[1];
};
const PACKAGE_COUNT = Number(flag('packages', '300'));
const REFRESH = args.includes('--refresh');

/**
 * Normalize source the same way the oracle and the tree-sitter harness will read it.
 *
 * This matters more than it looks: we are on Windows, and if the oracle saw CRLF while
 * tree-sitter saw LF (or vice versa) every byte offset past line 1 would disagree and
 * the span comparison would be pure noise. Normalizing once, at write time, means every
 * consumer reads identical bytes.
 */
function normalize(buf) {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n/g, '\n');
}

async function download(url, cacheName) {
  const cached = path.join(CACHE, cacheName);
  if (!REFRESH && fs.existsSync(cached)) return fs.readFileSync(cached);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cached, buf);
  return buf;
}

/** Write a corpus file, returning true if it was written (false if empty/duplicate). */
function writeEntry(destDir, relPath, data, seen) {
  const text = normalize(data);
  if (text.trim() === '') return false;

  // Identical files across package versions are common; skip byte-identical repeats so
  // the pass-rate percentage isn't skewed by whichever file happens to be duplicated.
  const key = text.length + ':' + text.slice(0, 256);
  if (seen.has(key)) return false;
  seen.add(key);

  const dest = path.join(destDir, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text, 'utf8');
  return true;
}

async function fetchSuite(seen) {
  const dest = path.join(CORPUS, 'typst-suite');
  fs.rmSync(dest, { recursive: true, force: true });

  process.stdout.write(`  typst ${TYPST_VERSION} source tarball ... `);
  const gz = await download(
    `https://codeload.github.com/typst/typst/tar.gz/refs/tags/v${TYPST_VERSION}`,
    `typst-${TYPST_VERSION}.tar.gz`,
  );
  process.stdout.write(`${(gz.length / 1e6).toFixed(1)} MB\n`);

  let count = 0;
  for (const { name, data } of readTarGz(gz)) {
    // Paths look like `typst-0.15.1/tests/suite/math/attach.typ`.
    const m = name.match(/^[^/]+\/tests\/suite\/(.+\.typ)$/);
    if (!m) continue;
    if (writeEntry(dest, m[1], data, seen)) count++;
  }
  return count;
}

async function fetchPackages(limit, seen) {
  const dest = path.join(CORPUS, 'packages');
  fs.rmSync(dest, { recursive: true, force: true });

  process.stdout.write('  Typst Universe index ... ');
  const indexBuf = await download('https://packages.typst.org/preview/index.json', 'index.json');
  const index = JSON.parse(indexBuf.toString('utf8'));
  process.stdout.write(`${index.length} packages\n`);

  // Keep only the newest version of each package, then take a deterministic slice so
  // the corpus is reproducible across runs and machines.
  const newest = new Map();
  for (const p of index) {
    const prev = newest.get(p.name);
    if (!prev || compareVersions(p.version, prev.version) > 0) newest.set(p.name, p);
  }
  const chosen = [...newest.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);

  let count = 0;
  let done = 0;
  const CONCURRENCY = 8;
  const queue = [...chosen];

  async function worker() {
    while (queue.length) {
      const pkg = queue.shift();
      try {
        const gz = await download(
          `https://packages.typst.org/preview/${pkg.name}-${pkg.version}.tar.gz`,
          `pkg-${pkg.name}-${pkg.version}.tar.gz`,
        );
        for (const { name, data } of readTarGz(gz)) {
          if (!name.endsWith('.typ')) continue;
          if (writeEntry(dest, `${pkg.name}/${name}`, data, seen)) count++;
        }
      } catch {
        // A few packages 404 or are malformed; they are not worth failing the run over.
      }
      done++;
      if (done % 25 === 0 || done === chosen.length) {
        process.stdout.write(`\r  packages ${done}/${chosen.length}, ${count} .typ files   `);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write('\n');
  return count;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

async function main() {
  console.log('Fetching Typst corpus\n');
  fs.mkdirSync(CORPUS, { recursive: true });
  const seen = new Set();

  const suite = await fetchSuite(seen);
  console.log(`  -> ${suite} files from the Typst test suite\n`);

  let packages = 0;
  if (PACKAGE_COUNT > 0) {
    packages = await fetchPackages(PACKAGE_COUNT, seen);
    console.log(`  -> ${packages} files from Typst Universe\n`);
  }

  const manifest = {
    fetchedAt: new Date().toISOString(),
    typstVersion: TYPST_VERSION,
    counts: { suite, packages, total: suite + packages },
  };
  fs.writeFileSync(path.join(CORPUS, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`Corpus ready: ${suite + packages} .typ files in corpus/`);
}

main().catch((err) => {
  console.error(`\nfetch-corpus failed: ${err.message}`);
  process.exit(1);
});
