use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub selection_seed: String,
    pub revisions: BTreeMap<String, String>,
    pub files: Vec<CorpusFile>,
    pub summary: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CorpusFile {
    pub id: String,
    pub stored: String,
    pub bytes: usize,
    pub provenances: Vec<Provenance>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Provenance {
    pub origin: String,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Counts {
    pub total: u64,
    pub passed: u64,
    pub failed: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StructuralKind {
    pub oracle: u64,
    pub parser: u64,
    pub matched: u64,
    pub precision: f64,
    pub recall: f64,
    pub f1: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StructuralSummary {
    pub kinds: BTreeMap<String, StructuralKind>,
    pub micro_precision: f64,
    pub micro_recall: f64,
    pub micro_f1: f64,
    pub macro_f1: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InvalidSummary {
    pub natural_total: u64,
    pub natural_detected: u64,
    pub mutation_total: u64,
    pub mutation_detected: u64,
    pub localized_overlap: u64,
    pub distance_p50_bytes: Option<u64>,
    pub distance_p95_bytes: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StratumAccuracy {
    pub valid_files: u64,
    pub valid_bytes: u64,
    pub valid_clean_files: u64,
    pub valid_clean_bytes: u64,
    pub structural: StructuralSummary,
    pub natural_invalid_total: u64,
    pub natural_invalid_detected: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ParserAccuracy {
    pub parse_attempts: u64,
    pub parse_none_or_timeout: u64,
    pub valid_files: u64,
    pub valid_bytes: u64,
    pub valid_clean_files: u64,
    pub valid_clean_bytes: u64,
    pub valid_error_nodes: u64,
    pub valid_missing_nodes: u64,
    pub valid_failure_ids: Vec<String>,
    pub structural: StructuralSummary,
    pub invalid: InvalidSummary,
    pub natural_invalid_missed_ids: Vec<String>,
    pub mutation_misses: Vec<String>,
    pub incremental: Counts,
    pub incremental_failure_cases: Vec<String>,
    pub strata: BTreeMap<String, StratumAccuracy>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccuracyOutput {
    pub schema: u32,
    pub selection_seed: String,
    pub revisions: BTreeMap<String, String>,
    pub corpus_summary: serde_json::Value,
    pub oracle_valid_files: u64,
    pub oracle_invalid_files: u64,
    pub common_clean_ids: Vec<String>,
    pub independent_common_clean_ids: Vec<String>,
    pub parsers: BTreeMap<String, ParserAccuracy>,
    pub mapping_policy: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TimingSample {
    pub block: usize,
    pub elapsed_ns: u128,
    pub operations: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpeedOutput {
    pub schema: u32,
    pub revisions: BTreeMap<String, String>,
    pub cohort_scope: String,
    pub cohort_ids: Vec<String>,
    pub cohort_files: usize,
    pub cohort_bytes: u64,
    pub affinity_core: Option<usize>,
    pub warmup_blocks: usize,
    pub measurement_blocks: usize,
    pub full_repeats: usize,
    pub incremental_repeats: usize,
    pub incremental_cases: usize,
    pub full_parse: BTreeMap<String, Vec<TimingSample>>,
    pub incremental_parse: BTreeMap<String, Vec<TimingSample>>,
}
