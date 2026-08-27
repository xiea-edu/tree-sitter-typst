# Typst Tree-sitter Parser Benchmark

## Result

The independent corpus remains the primary accuracy result; upstream-owned tests are reported as separate home-test strata. The local parser retained the strongest independent accuracy. Speed is measured only on the independent common-clean cohort and does not override accuracy.

## Corpus and controls

- 4,615 unique Typst inputs (7,160,683 bytes), with 22 exact duplicate provenances deduplicated and 1 input excluded.
- 4,372 files were valid under Typst 0.15.1; 243 contained official syntax errors.
- Real-world coverage used the latest versions of 200 Typst Universe packages chosen by the frozen SHA-256 seed `e18d19dece7c09415a302cd26ca13223794ce8f8662eb6a8a3fa927920413710`.
- Independent stratum: 1,403 unique files (6,633,112 bytes).
- uben0 stratum: 2,933 unique sources from 2,934 corpus cases.
- SeniorMars stratum: 282 unique sources from 276 corpus cases and 11 `.typ` fixtures.
- For parser-owned corpora, only the Typst source portion is reused. Parser-specific expected trees are intentionally ignored because the three grammars expose different node schemas.
- Mutation and incremental-correctness samples remain drawn only from the independent stratum, preserving the original comparison exactly.
- Each checked-in generated C parser and required scanner headers was compiled into one runner with the same Tree-sitter 0.26.13 runtime, MSVC C11 mode, and release optimization.

## Primary accuracy: independent corpus

| Parser | Clean oracle-valid files | Clean valid bytes | Structural macro F1 | Structural micro F1 | Natural invalid | Mutated invalid | Incremental = full | Timeouts |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Local (xiea-edu) | 1363/1366 (99.780%) | 6,416,257/6,432,570 (99.746%) | 0.9785 | 0.9915 | 37/37 | 935/936 | 220/220 | 0 |
| uben0 | 1353/1366 (99.048%) | 6,254,736/6,432,570 (97.235%) | 0.8814 | 0.8314 | 30/37 | 935/936 | 220/220 | 0 |
| SeniorMars | 1309/1366 (95.827%) | 5,889,953/6,432,570 (91.565%) | 0.9356 | 0.8302 | 32/37 | 930/936 | 220/220 | 0 |

Structural F1 uses exact `(canonical construct, start byte, end byte)` matches for direct one-to-one named constructs shared by all implementations. It is secondary because the parsers intentionally expose different tree schemas; no nodes were merged, trimmed, or weighted for a particular parser.

## Parser-owned test strata

These rows make home-field effects visible rather than blending them into the independent headline result.

| Corpus stratum | Parser | Clean oracle-valid files | Clean valid bytes | Structural macro F1 | Structural micro F1 | Natural invalid |
|---|---|---:|---:|---:|---:|---:|
| uben0 tests | Local (xiea-edu) | 2751/2794 (98.461%) | 479,308/482,844 (99.268%) | 0.9696 | 0.9501 | 115/139 |
| uben0 tests | uben0 | 2788/2794 (99.785%) | 482,094/482,844 (99.845%) | 0.9049 | 0.7836 | 75/139 |
| uben0 tests | SeniorMars | 2754/2794 (98.568%) | 477,426/482,844 (98.878%) | 0.9290 | 0.7967 | 106/139 |
| SeniorMars tests | Local (xiea-edu) | 214/215 (99.535%) | 23,892/23,980 (99.633%) | 0.9727 | 0.9804 | 52/67 |
| SeniorMars tests | uben0 | 210/215 (97.674%) | 23,866/23,980 (99.525%) | 0.8282 | 0.7850 | 44/67 |
| SeniorMars tests | SeniorMars | 211/215 (98.140%) | 23,808/23,980 (99.283%) | 0.9215 | 0.8033 | 29/67 |

## Speed on the common-clean cohort

The speed cohort contains 61 deterministically selected independent files (391,637 bytes) from the 1,294 independent files parsed cleanly by all three parsers. Results are medians of 30 interleaved blocks after 5 warm-up blocks on logical processor 1.

| Parser | Full parse median | Incremental median per edit |
|---|---:|---:|
| Local (xiea-edu) | 7.16 MiB/s | 50.65 µs |
| uben0 | 5.45 MiB/s | 106.86 µs |
| SeniorMars | 5.52 MiB/s | 56.52 µs |

Pairwise ratios below are `left ÷ right`; values above 1 mean the left parser is faster. Intervals are paired 95% bootstrap confidence intervals over measurement blocks.

| Workload | Comparison | Ratio | 95% CI |
|---|---|---:|---:|
| Full | Local (xiea-edu) / uben0 | 1.313× | [1.282, 1.345] |
| Full | Local (xiea-edu) / SeniorMars | 1.296× | [1.270, 1.325] |
| Full | uben0 / SeniorMars | 0.987× | [0.968, 1.003] |
| Incremental | Local (xiea-edu) / uben0 | 2.109× | [2.078, 2.153] |
| Incremental | Local (xiea-edu) / SeniorMars | 1.116× | [1.101, 1.135] |
| Incremental | uben0 / SeniorMars | 0.529× | [0.517, 0.539] |

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
