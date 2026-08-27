# Typst Tree-sitter Parser Benchmark

## Result

The local parser is the clear accuracy winner on this corpus: it was the only parser to parse every oracle-valid file cleanly, had the highest normalized structural fidelity, detected all naturally invalid files, and matched fresh parsing for every incremental edit. Speed is reported separately and does not override that accuracy result.

## Corpus and controls

- 1,403 unique `.typ` files (6,633,112 bytes), with 13 exact duplicates deduplicated and 1 file excluded.
- 1,366 files were valid under Typst 0.15.1; 37 contained official syntax errors.
- Real-world coverage used the latest versions of 200 Typst Universe packages chosen by the frozen SHA-256 seed `e18d19dece7c09415a302cd26ca13223794ce8f8662eb6a8a3fa927920413710`.
- Existing tests, corpora, scripts, queries, examples, and benchmark code from all three parser repositories were excluded.
- Each checked-in generated C parser and required scanner headers was compiled into one runner with the same Tree-sitter 0.26.13 runtime, MSVC C11 mode, and release optimization.

## Accuracy

| Parser | Clean oracle-valid files | Clean valid bytes | Structural macro F1 | Structural micro F1 | Natural invalid | Mutated invalid | Incremental = full | Timeouts |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Local (xiea-edu) | 1366/1366 (100.000%) | 6,432,570/6,432,570 (100.000%) | 0.9792 | 0.9915 | 37/37 | 935/936 | 220/220 | 0 |
| uben0 | 1353/1366 (99.048%) | 6,254,736/6,432,570 (97.235%) | 0.8814 | 0.8314 | 30/37 | 935/936 | 220/220 | 0 |
| SeniorMars | 1309/1366 (95.827%) | 5,889,953/6,432,570 (91.565%) | 0.9356 | 0.8302 | 32/37 | 930/936 | 220/220 | 0 |

Structural F1 uses exact `(canonical construct, start byte, end byte)` matches for direct one-to-one named constructs shared by all implementations. It is secondary because the parsers intentionally expose different tree schemas; no nodes were merged, trimmed, or weighted for a particular parser.

## Speed on the common-clean cohort

The speed cohort contains 61 deterministically selected files (391,637 bytes) from the 1,297 files parsed cleanly by all three parsers. Results are medians of 30 interleaved blocks after 5 warm-up blocks on logical processor 1.

| Parser | Full parse median | Incremental median per edit |
|---|---:|---:|
| Local (xiea-edu) | 7.31 MiB/s | 48.52 µs |
| uben0 | 5.37 MiB/s | 107.71 µs |
| SeniorMars | 5.39 MiB/s | 56.32 µs |

Pairwise ratios below are `left ÷ right`; values above 1 mean the left parser is faster. Intervals are paired 95% bootstrap confidence intervals over measurement blocks.

| Workload | Comparison | Ratio | 95% CI |
|---|---|---:|---:|
| Full | Local (xiea-edu) / uben0 | 1.363× | [1.285, 1.394] |
| Full | Local (xiea-edu) / SeniorMars | 1.356× | [1.286, 1.404] |
| Full | uben0 / SeniorMars | 0.995× | [0.972, 1.038] |
| Incremental | Local (xiea-edu) / uben0 | 2.220× | [2.188, 2.236] |
| Incremental | Local (xiea-edu) / SeniorMars | 1.161× | [1.142, 1.167] |
| Incremental | uben0 / SeniorMars | 0.523× | [0.518, 0.526] |

## Environment

- CPU: AMD Ryzen 7 9800X3D 8-Core Processor
- OS: Windows-11-10.0.26200-SP0
- Power scheme: `Power Scheme GUID: 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  (High performance)`
- Rust: `rustc 1.98.0 (88d9e12ae 2026-08-18)`
- Cargo: `cargo 1.98.0 (797e8a9bc 2026-08-05)`
- C compiler: MSVC 19.44.35228 (`/std:c11`, `/O2` as emitted by `cc` for `opt_level(3)`)

## Pinned revisions

- local: `604f05fdfd679ff515a5226ecf314b65aa1c5c4f`
- packages: `df365225e63a0de72e6cbfb4704efd26e2f5c3bb`
- seniormars: `1acd48c90d260bc9f8a99f903d3e2a8031bc7aae`
- typst: `9dfd3a08500b7896045f907433cf7b4b02434fad`
- uben0: `46cf4ded12ee974a70bf8457263b67ad7ee0379d`

## Reproduction

Run `prepare_corpus.py` against isolated clones at the pinned revisions, set `TYPST_BENCH_ROOT` to that checkout root, then build and run:

```powershell
cargo build --release --manifest-path benchmark/Cargo.toml
typst-parser-benchmark.exe accuracy <manifest.json> <corpus-root> benchmark/results/accuracy.json
typst-parser-benchmark.exe speed <manifest.json> <corpus-root> benchmark/results/accuracy.json benchmark/results/speed.json
```

The raw JSON, full corpus manifest, exact mapping code, and summary CSV accompany this report. Absolute timings are specific to this machine; the interleaved same-process ratios are the more portable speed result.
