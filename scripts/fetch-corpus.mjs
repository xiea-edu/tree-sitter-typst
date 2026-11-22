/**
 * Fetch real-world Typst source into `corpus/` for differential testing.
 *
 * Fetch the compiler suite, parser test inputs, Touying and Typst Universe packages.
 * Downloaded archives and extracted third-party material stay under gitignored `corpus/`.
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
const peerCorpora = JSON.parse(fs.readFileSync(new URL('../test/peer-corpora.json', import.meta.url)));

/** Typst version to pin the suite to. Keep in sync with tools/oracle/Cargo.toml. */
const TYPST_VERSION = '0.15.1';

/**
 * Repositories fetched in full, regardless of the package slice.
 *
 * The Universe sample is the alphabetically-first N packages, which is reproducible but
 * arbitrary — anything after roughly the letter `i` never gets fetched. A package you
 * actually write documents against deserves to be in the corpus whatever its name, so
 * pin it here.
 *
 * Taken from GitHub rather than the registry because a published tarball is only the
 * library: the repository also carries examples, docs and tests, which is where the
 * interesting syntax lives. Pinned to a tag for the same reason the suite is — an
 * unpinned default branch would make the score move on its own.
 */
const PINNED_REPOS = [
  { repo: 'touying-typ/touying', tag: '0.7.4' },
];

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

async function fetchPinned(seen) {
  const dest = path.join(CORPUS, 'pinned');
  fs.rmSync(dest, { recursive: true, force: true });

  let count = 0;
  for (const { repo, tag } of PINNED_REPOS) {
    const slug = repo.replace('/', '-');
    process.stdout.write(`  ${repo}@${tag} ... `);
    const gz = await download(
      `https://codeload.github.com/${repo}/tar.gz/refs/tags/${tag}`,
      `${slug}-${tag}.tar.gz`,
    );
    let n = 0;
    for (const { name, data } of readTarGz(gz)) {
      if (!name.endsWith('.typ')) continue;
      // Strip the tarball's `<repo>-<tag>/` prefix.
      const rel = name.replace(/^[^/]+\//, '');
      if (writeEntry(dest, `${repo.split('/')[1]}/${rel}`, data, seen)) n++;
    }
    process.stdout.write(`${n} .typ files\n`);
    count += n;
  }
  return count;
}

/** Headers in these two pinned corpora have one title line and unsuffixed delimiters. */
function* corpusExamples(text) {
  const headers = [...text.matchAll(/^(={3,})\n([^\n]+)\n\1\n/gm)];
  if (!headers.length) throw new Error('Missing Tree-sitter corpus header');
  for (const [i, header] of headers.entries()) {
    const body = text.slice(header.index + header[0].length, headers[i + 1]?.index);
    // Tree-sitter picks the longest divider (last on a tie) so Typst shorthands
    // can appear in the source. Strip exactly the newline introducing the divider.
    let divider;
    for (const m of body.matchAll(/^-{3,}\n/gm)) {
      if (!divider || m[0].length >= divider[0].length) divider = m;
    }
    if (!divider) throw new Error('Missing corpus divider for ' + header[2]);
    yield [header[2], body.slice(0, divider.index).replace(/\n$/, '')];
  }
}

async function fetchParserCorpus(owner, { revision, files }) {
  const archive = await download(
    'https://codeload.github.com/' + owner + '/tree-sitter-typst/tar.gz/' + revision,
    owner + '-' + revision + '.tar.gz',
  );
  const dest = path.join(CORPUS, owner);
  const inputs = new Map();
  let license;
  for (const { name, data } of readTarGz(archive)) {
    const rel = name.slice(name.indexOf('/') + 1);
    if (rel === 'LICENSE') license = data;
    if (/^test\/fixtures\/(?:[\w-]+\/)*[\w-]+\.typ$/.test(rel)) {
      inputs.set(rel.slice('test/'.length), normalize(data));
    }
    const suite = /^test\/corpus\/([\w-]+)\.(?:scm|txt)$/.exec(rel)?.[1];
    if (!suite) continue;
    for (const [title, source] of corpusExamples(normalize(data))) {
      const label = title.startsWith(suite + '/') ? title.slice(suite.length + 1) : title;
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const file = suite + '/' + slug + '.typ';
      if (!slug || inputs.has(file)) throw new Error('Ambiguous corpus title: ' + title);
      inputs.set(file, source);
    }
  }
  if (!license || inputs.size !== files) {
    throw new Error(owner + ' archive incomplete: found ' + inputs.size + ' test inputs, expected ' + files);
  }
  fs.rmSync(dest, { recursive: true, force: true });
  for (const [file, source] of inputs) {
    const target = path.join(dest, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
  fs.writeFileSync(path.join(dest, 'LICENSE'), license);
  return inputs.size;
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

  const pinned = await fetchPinned(seen);
  console.log(`  -> ${pinned} files from pinned repositories
`);

  let packages = 0;
  const parsers = {};
  for (const [owner, pin] of Object.entries(peerCorpora)) {
    parsers[owner] = await fetchParserCorpus(owner, pin);
    console.log('  -> ' + parsers[owner] + ' test inputs from ' + owner);
  }
  if (PACKAGE_COUNT > 0) {
    packages = await fetchPackages(PACKAGE_COUNT, seen);
    console.log(`  -> ${packages} files from Typst Universe\n`);
  }

  const total = suite + pinned + packages + Object.values(parsers).reduce((a, b) => a + b, 0);
  const manifest = {
    fetchedAt: new Date().toISOString(),
    typstVersion: TYPST_VERSION,
    counts: { suite, pinned, ...parsers, packages, total },
  };
  fs.writeFileSync(path.join(CORPUS, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log('Corpus ready: ' + total + ' .typ files in corpus/');
}

main().catch((err) => {
  console.error(`\nfetch-corpus failed: ${err.message}`);
  process.exit(1);
});
