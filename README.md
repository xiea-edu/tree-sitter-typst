# tree-sitter-typst

A [tree-sitter](https://tree-sitter.github.io) grammar for [Typst](https://typst.app).

> **Status: in development.** Phase 0 (test harness) is complete; the grammar itself is
> being built. See [Progress](#progress).

## Why another one

Typst is unusually hard to parse. It has three syntax modes — markup, code and math —
that nest into one another arbitrarily (`$#{ [*x*] }$` is valid), indentation-sensitive
list nesting, and tokens whose meaning depends entirely on mode (`*` is bold in markup,
multiplication in code, a symbol in math).

The approach here is to not guess. `typst-syntax` — the parser from the real Typst
compiler — is wired in as a **test oracle**, so the grammar is continuously
differential-tested against the reference implementation over thousands of real
documents, rather than against hand-written expectations.

## Testing

Four tiers, cheapest and highest-yield first.

| Tier | What it checks | Why it exists |
| --- | --- | --- |
| 1. Validity agreement | For every corpus file, typst accepts ⟺ we accept | Needs no node mapping, so it works from day one and scales to thousands of files |
| 2. Span agreement | Both trees flattened to `(start, end, kind)` and compared | Catches mis-*structuring* — files that parse cleanly but nest wrongly |
| 3. Golden corpus | Hand-checked `tree-sitter test` cases | The readable spec of intent, and the regression net |
| 4. Robustness | Fuzzing + incremental-reparse equivalence | Catches scanner crashes, hangs, and lost serialize/deserialize state |

Tier 1 reports two failure directions separately, because they mean opposite things:

- **false reject** — typst accepts it, we produce `ERROR`. A missing construct.
- **false accept** — typst rejects it, we parse it happily. Too permissive.

Both must reach zero. Tracking only one is how you end up with a grammar that either
can't parse real documents or accepts anything you throw at it.

Tier 4b (incremental equivalence) deserves special mention: it applies a random edit,
reparses incrementally, and checks the result is byte-identical to a fresh parse of the
edited text. Divergence there almost always means the external scanner's
`serialize`/`deserialize` is losing state — the nastiest class of tree-sitter bug, and
the one editors hit constantly, since an editor only ever parses incrementally.

### Running the tests

```bash
npm install
npm run oracle:build      # builds tools/oracle (needs a Rust toolchain)
npm run corpus:fetch      # downloads ~3,700 real .typ files into corpus/ (gitignored)
npm test
```

Individual tiers:

```bash
npm run test:corpus && npm run test:valid && npm run test:diff && npm run test:fuzz && npm run test:incremental && npm run coverage
```

Useful flags: `--limit=N` caps files per group, `--rounds=N` sets fuzz/incremental
iterations, `--seed=N` reproduces a specific failing run.

Inspect a single file against the reference parser:

```bash
tools/oracle/target/release/typst-oracle dump path/to/file.typ
```

## Corpus

Fetched on demand into `corpus/`, never committed — it is third-party Apache-2.0
material and would bloat the repo.

- **`typst/typst@v0.15.1 tests/suite`** (221 files) — the compiler's own test suite.
  Adversarial edge cases written by the people who designed the language, so it exercises
  exactly the corners a grammar gets wrong. Many files are *deliberately* invalid, which
  makes them just as useful: we must reject them too.
- **Typst Universe packages** (~3,500 files) — ordinary real-world documents, which catch
  the opposite failure mode: common constructs nobody thought to test.

## Progress

Coverage is measured against the 130 `SyntaxKind`s the reference parser actually produces
across the corpus.

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Test harness, oracle, corpus, CI | done |
| 1 | Code mode | in progress |
| 2 | Markup mode + external scanner | |
| 3 | Math mode | |
| 4 | Queries (highlights, injections, locals, folds, indents) | |
| 5 | Hardening, perf, release | |

## Version pinning

The grammar targets **Typst 0.15.1**. The oracle pins `typst-syntax = "=0.15.1"` to
match. Upgrading Typst means bumping both and re-baselining the tests.

## License

MIT
