# Typst parser benchmark

This harness compares only the checked-in generated parser implementation from each repository:
`src/parser.c`, `src/scanner.c`, and headers included by those files. Accuracy is reported first on an
independent Typst/Typst Universe corpus, then separately on source inputs extracted from uben0's and
SeniorMars's own test corpora. Expected trees remain excluded because each parser exposes a different
schema. Queries, examples, bindings, development scripts, and existing benchmark code are not used.

The three parsers are linked into one executable after their exported C symbols are renamed. They
therefore share the same Tree-sitter runtime, compiler, optimization settings, process, corpus, and
measurement schedule.

## Pinned inputs

- Local: `604f05fdfd679ff515a5226ecf314b65aa1c5c4f`
- uben0: `46cf4ded12ee974a70bf8457263b67ad7ee0379d`
- SeniorMars: `1acd48c90d260bc9f8a99f903d3e2a8031bc7aae`
- Typst syntax oracle: `9dfd3a08500b7896045f907433cf7b4b02434fad` (v0.15.1)
- Typst Universe: `df365225e63a0de72e6cbfb4704efd26e2f5c3bb`

## Reproduce

Create an isolated directory containing clones named `local`, `uben0`, `seniormars`, `typst`, and
`packages`. Check out the three parser revisions above; `prepare_corpus.py` performs sparse checkouts
of the pinned Typst and package revisions itself.

```powershell
$benchmarkRoot = Join-Path $env:TEMP 'tree-sitter-typst-benchmark'
$corpusRoot = Join-Path $benchmarkRoot 'corpus'

python benchmark/prepare_corpus.py --bench-root $benchmarkRoot --output $corpusRoot

$env:TYPST_BENCH_ROOT = $benchmarkRoot
$env:CARGO_TARGET_DIR = Join-Path $benchmarkRoot 'target'
cargo build --release --manifest-path benchmark/Cargo.toml

$runner = Join-Path $env:CARGO_TARGET_DIR 'release/typst-parser-benchmark.exe'
& $runner accuracy (Join-Path $corpusRoot 'manifest.json') $corpusRoot benchmark/results/accuracy.json
& $runner speed (Join-Path $corpusRoot 'manifest.json') $corpusRoot benchmark/results/accuracy.json benchmark/results/speed.json
python benchmark/report.py --accuracy benchmark/results/accuracy.json --speed benchmark/results/speed.json --manifest benchmark/results/corpus-manifest.json --report benchmark/results/report.md --csv benchmark/results/summary.csv --strata-csv benchmark/results/strata.csv
```

The speed runner uses only independent inputs parsed cleanly by every parser. It pins itself to the
second available logical processor, performs five warm-up blocks, and records 30 interleaved
measurement blocks. Incremental timing excludes source construction and old-tree cloning.
