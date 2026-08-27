use crate::model::{AccuracyOutput, CorpusFile, Manifest, SpeedOutput, TimingSample};
use crate::parsers::{PARSERS, ParserDef};
use crate::util::{make_edit, oracle_data, select_stratified};
use anyhow::{Context, Result};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::hint::black_box;
use std::path::Path;
use std::time::{Duration, Instant};
use tree_sitter::{Parser, Tree};

const WARMUP_BLOCKS: usize = 5;
const MEASUREMENT_BLOCKS: usize = 30;
const TARGET_BLOCK: Duration = Duration::from_millis(150);
const ORDER: [[usize; 3]; 6] = [
    [0, 1, 2],
    [1, 2, 0],
    [2, 0, 1],
    [0, 2, 1],
    [2, 1, 0],
    [1, 0, 2],
];

#[derive(Clone)]
struct SourceCase {
    source: String,
    bytes: u64,
}

struct IncrementalCase {
    source_index: usize,
    edited: String,
    edit: tree_sitter::InputEdit,
    bytes: u64,
}

pub fn run(
    manifest_path: &Path,
    corpus_root: &Path,
    accuracy_path: &Path,
    output: &Path,
) -> Result<()> {
    let manifest: Manifest = serde_json::from_slice(&fs::read(manifest_path)?)?;
    let accuracy: AccuracyOutput = serde_json::from_slice(&fs::read(accuracy_path)?)?;
    let clean: BTreeSet<&str> = accuracy
        .independent_common_clean_ids
        .iter()
        .map(String::as_str)
        .collect();
    let eligible = manifest
        .files
        .iter()
        .filter(|file| clean.contains(file.id.as_str()))
        .cloned()
        .collect::<Vec<CorpusFile>>();
    let selected = select_stratified(&eligible, 30);
    let cohort_ids = selected
        .iter()
        .map(|file| file.id.clone())
        .collect::<Vec<_>>();
    let sources = selected
        .iter()
        .map(|file| {
            let path = corpus_root.join(&file.stored);
            let source =
                fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
            Ok(SourceCase {
                bytes: source.len() as u64,
                source,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let cohort_bytes = sources.iter().map(|case| case.bytes).sum::<u64>();

    let affinity_core = core_affinity::get_core_ids()
        .and_then(|cores| cores.into_iter().nth(1))
        .and_then(|core| core_affinity::set_for_current(core).then_some(core.id));

    let full_repeats = calibrate_full(&sources)?;
    eprintln!("full parse repeats per block: {full_repeats}");
    let full_parse = run_full(&sources, full_repeats)?;

    let incremental_cases = build_incremental_cases(&sources);
    let incremental_repeats = calibrate_incremental(&sources, &incremental_cases)?;
    eprintln!("incremental repeats per block: {incremental_repeats}");
    let incremental_parse = run_incremental(&sources, &incremental_cases, incremental_repeats)?;

    let result = SpeedOutput {
        schema: 1,
        revisions: manifest.revisions,
        cohort_scope: "independent".to_owned(),
        cohort_ids,
        cohort_files: sources.len(),
        cohort_bytes,
        affinity_core,
        warmup_blocks: WARMUP_BLOCKS,
        measurement_blocks: MEASUREMENT_BLOCKS,
        full_repeats,
        incremental_repeats,
        incremental_cases: incremental_cases.len(),
        full_parse,
        incremental_parse,
    };
    fs::write(output, serde_json::to_vec_pretty(&result)?)
        .with_context(|| format!("writing {}", output.display()))?;
    Ok(())
}

fn calibrate_full(sources: &[SourceCase]) -> Result<usize> {
    let mut fastest = Duration::MAX;
    for definition in PARSERS {
        let mut parser = definition.parser()?;
        let start = Instant::now();
        parse_full_batch(&mut parser, sources, 1);
        fastest = fastest.min(start.elapsed());
    }
    Ok(repeats_for(fastest))
}

fn run_full(sources: &[SourceCase], repeats: usize) -> Result<BTreeMap<String, Vec<TimingSample>>> {
    let mut parsers = PARSERS
        .iter()
        .map(|definition| definition.parser())
        .collect::<Result<Vec<_>>>()?;
    for block in 0..(WARMUP_BLOCKS + MEASUREMENT_BLOCKS) {
        for &index in &ORDER[block % ORDER.len()] {
            if block < WARMUP_BLOCKS {
                parse_full_batch(&mut parsers[index], sources, repeats);
            }
        }
    }

    let mut samples = empty_samples();
    for block in 0..MEASUREMENT_BLOCKS {
        for &index in &ORDER[(block + WARMUP_BLOCKS) % ORDER.len()] {
            let start = Instant::now();
            parse_full_batch(&mut parsers[index], sources, repeats);
            let elapsed = start.elapsed();
            samples
                .get_mut(PARSERS[index].name)
                .unwrap()
                .push(TimingSample {
                    block,
                    elapsed_ns: elapsed.as_nanos(),
                    operations: (sources.len() * repeats) as u64,
                    bytes: sources.iter().map(|case| case.bytes).sum::<u64>() * repeats as u64,
                });
        }
    }
    Ok(samples)
}

fn parse_full_batch(parser: &mut Parser, sources: &[SourceCase], repeats: usize) {
    for _ in 0..repeats {
        for case in sources {
            let tree = parser
                .parse(black_box(case.source.as_bytes()), None)
                .expect("full parse returned None");
            black_box(tree);
        }
    }
}

fn build_incremental_cases(sources: &[SourceCase]) -> Vec<IncrementalCase> {
    let mut output = Vec::new();
    for (source_index, case) in sources.iter().enumerate() {
        let append = make_edit(
            &case.source,
            case.source.len(),
            case.source.len(),
            "\nbenchmark",
        );
        if oracle_data(&typst_syntax::parse(&append.source))
            .1
            .is_empty()
        {
            output.push(IncrementalCase {
                source_index,
                bytes: append.source.len() as u64,
                edited: append.source,
                edit: append.edit,
            });
        }
        let mut middle = case.source.len() / 2;
        while middle > 0 && !case.source.is_char_boundary(middle) {
            middle -= 1;
        }
        let insert = make_edit(&case.source, middle, middle, "x");
        if oracle_data(&typst_syntax::parse(&insert.source))
            .1
            .is_empty()
        {
            output.push(IncrementalCase {
                source_index,
                bytes: insert.source.len() as u64,
                edited: insert.source,
                edit: insert.edit,
            });
        }
    }
    output
}

fn prepare_base_trees(
    definition: ParserDef,
    sources: &[SourceCase],
    cases: &[IncrementalCase],
) -> Result<Vec<Tree>> {
    let mut parser = definition.parser()?;
    let mut output = Vec::with_capacity(cases.len());
    for case in cases {
        let source = &sources[case.source_index];
        output.push(
            parser
                .parse(source.source.as_bytes(), None)
                .expect("base parse returned None"),
        );
    }
    Ok(output)
}

fn calibrate_incremental(sources: &[SourceCase], cases: &[IncrementalCase]) -> Result<usize> {
    let mut fastest = Duration::MAX;
    for definition in PARSERS {
        let mut parser = definition.parser()?;
        let bases = prepare_base_trees(definition, sources, cases)?;
        let mut trees = clone_base_trees(&bases, 1);
        let start = Instant::now();
        parse_incremental_prepared(&mut parser, cases, &mut trees);
        fastest = fastest.min(start.elapsed());
    }
    Ok(repeats_for(fastest))
}

fn run_incremental(
    sources: &[SourceCase],
    cases: &[IncrementalCase],
    repeats: usize,
) -> Result<BTreeMap<String, Vec<TimingSample>>> {
    let mut parsers = PARSERS
        .iter()
        .map(|definition| definition.parser())
        .collect::<Result<Vec<_>>>()?;
    let bases = PARSERS
        .iter()
        .map(|definition| prepare_base_trees(*definition, sources, cases))
        .collect::<Result<Vec<_>>>()?;
    for block in 0..WARMUP_BLOCKS {
        for &index in &ORDER[block % ORDER.len()] {
            let mut trees = clone_base_trees(&bases[index], repeats);
            parse_incremental_prepared(&mut parsers[index], cases, &mut trees);
        }
    }
    let mut samples = empty_samples();
    for block in 0..MEASUREMENT_BLOCKS {
        for &index in &ORDER[(block + WARMUP_BLOCKS) % ORDER.len()] {
            let mut trees = clone_base_trees(&bases[index], repeats);
            let start = Instant::now();
            parse_incremental_prepared(&mut parsers[index], cases, &mut trees);
            let elapsed = start.elapsed();
            samples
                .get_mut(PARSERS[index].name)
                .unwrap()
                .push(TimingSample {
                    block,
                    elapsed_ns: elapsed.as_nanos(),
                    operations: (cases.len() * repeats) as u64,
                    bytes: cases.iter().map(|case| case.bytes).sum::<u64>() * repeats as u64,
                });
        }
    }
    Ok(samples)
}

fn clone_base_trees(bases: &[Tree], repeats: usize) -> Vec<Tree> {
    (0..repeats).flat_map(|_| bases.iter().cloned()).collect()
}

fn parse_incremental_prepared(parser: &mut Parser, cases: &[IncrementalCase], trees: &mut [Tree]) {
    for chunk in trees.chunks_exact_mut(cases.len()) {
        for (case, tree) in cases.iter().zip(chunk.iter_mut()) {
            tree.edit(&case.edit);
            let reparsed = parser
                .parse(black_box(case.edited.as_bytes()), Some(tree))
                .expect("incremental parse returned None");
            black_box(reparsed);
        }
    }
}

fn repeats_for(elapsed: Duration) -> usize {
    if elapsed.is_zero() {
        return 50;
    }
    ((TARGET_BLOCK.as_nanos() + elapsed.as_nanos() - 1) / elapsed.as_nanos()).clamp(1, 50) as usize
}

fn empty_samples() -> BTreeMap<String, Vec<TimingSample>> {
    PARSERS
        .iter()
        .map(|definition| (definition.name.to_owned(), Vec::new()))
        .collect()
}
