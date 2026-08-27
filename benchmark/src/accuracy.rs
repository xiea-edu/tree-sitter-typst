use crate::model::{
    AccuracyOutput, CorpusFile, Manifest, ParserAccuracy, UpstreamCaseFailure,
};
use crate::parsers::PARSERS;
use crate::util::{
    StructuralAccumulator, invalid_candidates, nearest_error_distance, oracle_data, parser_data,
    percentile, select_stratified, tree_stream, valid_edit_candidates,
};
use anyhow::{Context, Result};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::ops::ControlFlow;
use std::path::Path;
use std::time::{Duration, Instant};
use tree_sitter::{ParseOptions, Parser, Point, Tree};

struct WorkingParser {
    name: &'static str,
    parser: Parser,
    summary: ParserAccuracy,
    structural: StructuralAccumulator,
    stratum_structural: BTreeMap<String, StructuralAccumulator>,
    distances: Vec<u64>,
}

pub fn run(manifest_path: &Path, corpus_root: &Path, output: &Path) -> Result<()> {
    let manifest: Manifest = serde_json::from_slice(
        &fs::read(manifest_path).with_context(|| format!("reading {}", manifest_path.display()))?,
    )?;
    let mut parsers = PARSERS
        .iter()
        .map(|definition| {
            let parser = definition.parser()?;
            Ok(WorkingParser {
                name: definition.name,
                parser,
                summary: ParserAccuracy::default(),
                structural: StructuralAccumulator::default(),
                stratum_structural: BTreeMap::new(),
                distances: Vec::new(),
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let mut oracle_valid_files = 0u64;
    let mut oracle_invalid_files = 0u64;
    let mut valid_files = Vec::new();
    let mut common_clean_ids = Vec::new();
    let mut independent_common_clean_ids = Vec::new();

    for (index, file) in manifest.files.iter().enumerate() {
        if index % 100 == 0 {
            eprintln!("accuracy corpus: {index}/{}", manifest.files.len());
        }
        let source = read_source(corpus_root, file)?;
        let oracle_root = typst_syntax::parse(&source);
        let (oracle_events, oracle_errors) = oracle_data(&oracle_root);
        let oracle_valid = oracle_errors.is_empty();
        let strata = file_strata(file);
        if oracle_valid {
            oracle_valid_files += 1;
            if strata.iter().any(|stratum| stratum == "independent") {
                valid_files.push(file.clone());
            }
        } else {
            oracle_invalid_files += 1;
        }

        let mut all_clean = oracle_valid;
        for working in &mut parsers {
            working.summary.parse_attempts += 1;
            for stratum in &strata {
                let summary = working.summary.strata.entry(stratum.clone()).or_default();
                if oracle_valid {
                    summary.valid_files += 1;
                    summary.valid_bytes += source.len() as u64;
                } else {
                    summary.natural_invalid_total += 1;
                }
            }
            let Some(tree) = parse_limited(&mut working.parser, source.as_bytes(), None) else {
                working.summary.parse_none_or_timeout += 1;
                record_upstream(&mut working.summary, file, None);
                if oracle_valid {
                    working.summary.valid_failure_ids.push(file.id.clone());
                }
                all_clean = false;
                continue;
            };
            let (events, errors, missing) = parser_data(&tree, working.name);
            let clean = errors.is_empty() && missing == 0;
            record_upstream(&mut working.summary, file, Some(clean));
            if oracle_valid {
                working.summary.valid_files += 1;
                working.summary.valid_bytes += source.len() as u64;
                working.summary.valid_error_nodes += errors.len() as u64;
                working.summary.valid_missing_nodes += missing;
                if clean {
                    working.summary.valid_clean_files += 1;
                    working.summary.valid_clean_bytes += source.len() as u64;
                    for stratum in &strata {
                        let summary = working.summary.strata.entry(stratum.clone()).or_default();
                        summary.valid_clean_files += 1;
                        summary.valid_clean_bytes += source.len() as u64;
                    }
                } else {
                    working.summary.valid_failure_ids.push(file.id.clone());
                    all_clean = false;
                }
                working.structural.add(&oracle_events, &events);
                for stratum in &strata {
                    working
                        .stratum_structural
                        .entry(stratum.clone())
                        .or_default()
                        .add(&oracle_events, &events);
                }
            } else {
                working.summary.invalid.natural_total += 1;
                if !clean {
                    working.summary.invalid.natural_detected += 1;
                    for stratum in &strata {
                        working
                            .summary
                            .strata
                            .entry(stratum.clone())
                            .or_default()
                            .natural_invalid_detected += 1;
                    }
                } else {
                    working
                        .summary
                        .natural_invalid_missed_ids
                        .push(file.id.clone());
                }
            }
        }
        if all_clean {
            common_clean_ids.push(file.id.clone());
            if strata.iter().any(|stratum| stratum == "independent") {
                independent_common_clean_ids.push(file.id.clone());
            }
        }
    }

    run_invalid_mutations(corpus_root, &valid_files, &mut parsers)?;
    run_incremental(corpus_root, &valid_files, &mut parsers)?;

    let mut summaries = BTreeMap::new();
    for mut working in parsers {
        working.summary.structural = working.structural.finish();
        for (stratum, structural) in working.stratum_structural {
            working
                .summary
                .strata
                .entry(stratum)
                .or_default()
                .structural = structural.finish();
        }
        working.summary.invalid.distance_p50_bytes = percentile(&mut working.distances, 0.50);
        working.summary.invalid.distance_p95_bytes = percentile(&mut working.distances, 0.95);
        summaries.insert(working.name.to_owned(), working.summary);
    }

    let result = AccuracyOutput {
        schema: 1,
        selection_seed: manifest.selection_seed,
        revisions: manifest.revisions,
        corpus_summary: manifest.summary,
        oracle_valid_files,
        oracle_invalid_files,
        common_clean_ids,
        independent_common_clean_ids,
        parsers: summaries,
        mapping_policy: "Exact byte-span tuples for direct one-to-one named constructs; no node merging, trimming, or parser-specific weighting.".into(),
    };
    fs::write(output, serde_json::to_vec_pretty(&result)?)
        .with_context(|| format!("writing {}", output.display()))?;
    Ok(())
}

fn file_strata(file: &CorpusFile) -> Vec<String> {
    let origins = file
        .provenances
        .iter()
        .map(|provenance| provenance.origin.as_str())
        .collect::<BTreeSet<_>>();
    let mut strata = Vec::new();
    if origins.contains("typst") || origins.contains("typst-universe") {
        strata.push("independent".to_owned());
    }
    if origins.contains("uben0-tests") {
        strata.push("uben0-tests".to_owned());
    }
    if origins.contains("seniormars-tests") {
        strata.push("seniormars-tests".to_owned());
    }
    strata
}

fn record_upstream(summary: &mut ParserAccuracy, file: &CorpusFile, parser_clean: Option<bool>) {
    for provenance in &file.provenances {
        let Some(expected_recovery) = provenance.expected_recovery else {
            continue;
        };
        let upstream = summary
            .upstream
            .entry(provenance.origin.clone())
            .or_default();
        upstream.cases += 1;
        if expected_recovery {
            upstream.expected_recovery += 1;
        } else {
            upstream.expected_clean += 1;
        }

        let passed = parser_clean.is_some_and(|clean| clean == !expected_recovery);
        if passed {
            upstream.passed += 1;
            if expected_recovery {
                upstream.recovery_passed += 1;
            } else {
                upstream.clean_passed += 1;
            }
        } else {
            upstream.failures.push(UpstreamCaseFailure {
                id: file.id.clone(),
                path: provenance.path.clone(),
                case: provenance.case.clone(),
                case_index: provenance.case_index,
                expected_recovery,
                parser_clean,
            });
        }
    }
}

fn run_invalid_mutations(
    corpus_root: &Path,
    valid_files: &[CorpusFile],
    parsers: &mut [WorkingParser],
) -> Result<()> {
    let selected = select_stratified(valid_files, 100);
    eprintln!("invalid mutations: {} source files", selected.len());
    for file in selected {
        let source = read_source(corpus_root, &file)?;
        for (name, changed) in invalid_candidates(&source) {
            let oracle_root = typst_syntax::parse(&changed);
            let (_, oracle_errors) = oracle_data(&oracle_root);
            if oracle_errors.is_empty() {
                continue;
            }
            for working in parsers.iter_mut() {
                working.summary.invalid.mutation_total += 1;
                working.summary.parse_attempts += 1;
                let Some(tree) = parse_limited(&mut working.parser, changed.as_bytes(), None)
                else {
                    working.summary.parse_none_or_timeout += 1;
                    continue;
                };
                let (_, parser_errors, missing) = parser_data(&tree, working.name);
                if !parser_errors.is_empty() || missing > 0 {
                    working.summary.invalid.mutation_detected += 1;
                    if let Some(distance) = nearest_error_distance(&oracle_errors, &parser_errors) {
                        if distance == 0 {
                            working.summary.invalid.localized_overlap += 1;
                        }
                        working.distances.push(distance as u64);
                    }
                } else {
                    working
                        .summary
                        .mutation_misses
                        .push(format!("{}:{name}", file.id));
                }
            }
        }
    }
    Ok(())
}

fn run_incremental(
    corpus_root: &Path,
    valid_files: &[CorpusFile],
    parsers: &mut [WorkingParser],
) -> Result<()> {
    let selected = select_stratified(valid_files, 30);
    eprintln!("incremental correctness: {} source files", selected.len());
    for file in selected {
        let source = read_source(corpus_root, &file)?;
        let edits = valid_edit_candidates(&source)
            .into_iter()
            .filter(|candidate| {
                oracle_data(&typst_syntax::parse(&candidate.source))
                    .1
                    .is_empty()
            })
            .collect::<Vec<_>>();
        for working in parsers.iter_mut() {
            for (edit_index, candidate) in edits.iter().enumerate() {
                working.summary.incremental.total += 1;
                let Some(mut old_tree) =
                    parse_limited(&mut working.parser, source.as_bytes(), None)
                else {
                    working.summary.incremental.failed += 1;
                    working
                        .summary
                        .incremental_failure_cases
                        .push(format!("{}:{edit_index}", file.id));
                    continue;
                };
                old_tree.edit(&candidate.edit);
                let incremental = parse_limited(
                    &mut working.parser,
                    candidate.source.as_bytes(),
                    Some(&old_tree),
                );
                let full = parse_limited(&mut working.parser, candidate.source.as_bytes(), None);
                let passed = match (incremental, full) {
                    (Some(incremental), Some(full)) => {
                        tree_stream(&incremental) == tree_stream(&full)
                    }
                    _ => false,
                };
                if passed {
                    working.summary.incremental.passed += 1;
                } else {
                    working.summary.incremental.failed += 1;
                    working
                        .summary
                        .incremental_failure_cases
                        .push(format!("{}:{edit_index}", file.id));
                }
            }
        }
    }
    Ok(())
}

fn read_source(corpus_root: &Path, file: &CorpusFile) -> Result<String> {
    let path = corpus_root.join(&file.stored);
    fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))
}

fn parse_limited(parser: &mut Parser, text: &[u8], old_tree: Option<&Tree>) -> Option<Tree> {
    let started = Instant::now();
    let mut progress = |_state: &tree_sitter::ParseState| {
        if started.elapsed() >= Duration::from_secs(5) {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    };
    let mut reader = |offset: usize, _position: Point| {
        if offset < text.len() {
            &text[offset..]
        } else {
            &[]
        }
    };
    parser.parse_with_options(
        &mut reader,
        old_tree,
        Some(ParseOptions::new().progress_callback(&mut progress)),
    )
}
