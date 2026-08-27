use crate::mapping;
use crate::model::{CorpusFile, StructuralKind, StructuralSummary};
use std::collections::{BTreeMap, BTreeSet};
use tree_sitter::{InputEdit, Node, Point, Tree};
use typst_syntax::{SyntaxKind, SyntaxNode};

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd)]
pub struct Event {
    pub kind: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct TreeEvent {
    pub kind: String,
    pub start: usize,
    pub end: usize,
    pub named: bool,
    pub error: bool,
    pub missing: bool,
}

#[derive(Debug, Clone)]
pub struct EditCase {
    pub source: String,
    pub edit: InputEdit,
}

pub fn oracle_data(root: &SyntaxNode) -> (BTreeSet<Event>, Vec<(usize, usize)>) {
    let mut events = BTreeSet::new();
    let mut errors = Vec::new();
    events.insert(Event {
        kind: "source_file".into(),
        start: 0,
        end: root.len(),
    });
    collect_oracle(root, 0, &mut events, &mut errors);
    (events, errors)
}

fn collect_oracle(
    node: &SyntaxNode,
    start: usize,
    events: &mut BTreeSet<Event>,
    errors: &mut Vec<(usize, usize)>,
) {
    let end = start + node.len();
    if node.kind() == SyntaxKind::Error {
        errors.push((start, end));
    }
    if let Some(kind) = mapping::official(node.kind()) {
        events.insert(Event {
            kind: kind.into(),
            start,
            end,
        });
    }
    let mut child_start = start;
    for child in node.children() {
        collect_oracle(child, child_start, events, errors);
        child_start += child.len();
    }
}

pub fn parser_data(tree: &Tree, parser: &str) -> (BTreeSet<Event>, Vec<(usize, usize)>, u64) {
    let mut events = BTreeSet::new();
    let mut errors = Vec::new();
    let mut missing = 0;
    collect_parser(
        tree.root_node(),
        parser,
        &mut events,
        &mut errors,
        &mut missing,
    );
    (events, errors, missing)
}

fn collect_parser(
    node: Node<'_>,
    parser: &str,
    events: &mut BTreeSet<Event>,
    errors: &mut Vec<(usize, usize)>,
    missing: &mut u64,
) {
    if node.is_error() {
        errors.push((node.start_byte(), node.end_byte()));
    }
    if node.is_missing() {
        *missing += 1;
        errors.push((node.start_byte(), node.start_byte()));
    }
    if node.is_named() {
        if let Some(kind) = mapping::parser(parser, node.kind()) {
            events.insert(Event {
                kind: kind.into(),
                start: node.start_byte(),
                end: node.end_byte(),
            });
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_parser(child, parser, events, errors, missing);
    }
}

pub fn tree_stream(tree: &Tree) -> Vec<TreeEvent> {
    let mut output = Vec::new();
    collect_stream(tree.root_node(), &mut output);
    output
}

fn collect_stream(node: Node<'_>, output: &mut Vec<TreeEvent>) {
    output.push(TreeEvent {
        kind: node.kind().into(),
        start: node.start_byte(),
        end: node.end_byte(),
        named: node.is_named(),
        error: node.is_error(),
        missing: node.is_missing(),
    });
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_stream(child, output);
    }
}

#[derive(Default)]
pub struct StructuralAccumulator {
    kinds: BTreeMap<String, (u64, u64, u64)>,
}

impl StructuralAccumulator {
    pub fn add(&mut self, oracle: &BTreeSet<Event>, parser: &BTreeSet<Event>) {
        for event in oracle {
            self.kinds.entry(event.kind.clone()).or_default().0 += 1;
        }
        for event in parser {
            self.kinds.entry(event.kind.clone()).or_default().1 += 1;
        }
        for event in oracle.intersection(parser) {
            self.kinds.entry(event.kind.clone()).or_default().2 += 1;
        }
    }

    pub fn finish(self) -> StructuralSummary {
        let mut summary = StructuralSummary::default();
        let mut macro_sum = 0.0;
        let mut macro_count = 0u64;
        let mut total_oracle = 0u64;
        let mut total_parser = 0u64;
        let mut total_matched = 0u64;
        for (kind, (oracle, parser, matched)) in self.kinds {
            let precision = ratio(matched, parser);
            let recall = ratio(matched, oracle);
            let f1 = harmonic(precision, recall);
            macro_sum += f1;
            macro_count += 1;
            total_oracle += oracle;
            total_parser += parser;
            total_matched += matched;
            summary.kinds.insert(
                kind,
                StructuralKind {
                    oracle,
                    parser,
                    matched,
                    precision,
                    recall,
                    f1,
                },
            );
        }
        summary.micro_precision = ratio(total_matched, total_parser);
        summary.micro_recall = ratio(total_matched, total_oracle);
        summary.micro_f1 = harmonic(summary.micro_precision, summary.micro_recall);
        summary.macro_f1 = if macro_count == 0 {
            0.0
        } else {
            macro_sum / macro_count as f64
        };
        summary
    }
}

fn ratio(numerator: u64, denominator: u64) -> f64 {
    if denominator == 0 {
        1.0
    } else {
        numerator as f64 / denominator as f64
    }
}

fn harmonic(a: f64, b: f64) -> f64 {
    if a + b == 0.0 {
        0.0
    } else {
        2.0 * a * b / (a + b)
    }
}

pub fn interval_distance(a: (usize, usize), b: (usize, usize)) -> usize {
    if a.1 < b.0 {
        b.0 - a.1
    } else if b.1 < a.0 {
        a.0 - b.1
    } else {
        0
    }
}

pub fn nearest_error_distance(
    oracle: &[(usize, usize)],
    parser: &[(usize, usize)],
) -> Option<usize> {
    oracle
        .iter()
        .flat_map(|a| parser.iter().map(move |b| interval_distance(*a, *b)))
        .min()
}

pub fn percentile(values: &mut [u64], quantile: f64) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    let index = ((values.len() - 1) as f64 * quantile).round() as usize;
    Some(values[index])
}

pub fn size_bucket(bytes: usize) -> usize {
    if bytes <= 4 * 1024 {
        0
    } else if bytes <= 64 * 1024 {
        1
    } else {
        2
    }
}

pub fn select_stratified(files: &[CorpusFile], per_bucket: usize) -> Vec<CorpusFile> {
    let mut buckets: [Vec<CorpusFile>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for file in files {
        buckets[size_bucket(file.bytes)].push(file.clone());
    }
    let mut output = Vec::new();
    for bucket in &mut buckets {
        bucket.sort_by(|a, b| a.id.cmp(&b.id));
        output.extend(bucket.iter().take(per_bucket).cloned());
    }
    output
}

fn boundary_at_or_before(source: &str, target: usize) -> usize {
    let mut value = target.min(source.len());
    while value > 0 && !source.is_char_boundary(value) {
        value -= 1;
    }
    value
}

pub fn point_for(source: &str, byte: usize) -> Point {
    let mut row = 0usize;
    let mut column = 0usize;
    for value in source.as_bytes()[..byte].iter().copied() {
        if value == b'\n' {
            row += 1;
            column = 0;
        } else {
            column += 1;
        }
    }
    Point { row, column }
}

pub fn make_edit(source: &str, start: usize, old_end: usize, replacement: &str) -> EditCase {
    let mut edited = String::with_capacity(source.len() - (old_end - start) + replacement.len());
    edited.push_str(&source[..start]);
    edited.push_str(replacement);
    edited.push_str(&source[old_end..]);
    let new_end = start + replacement.len();
    EditCase {
        edit: InputEdit {
            start_byte: start,
            old_end_byte: old_end,
            new_end_byte: new_end,
            start_position: point_for(source, start),
            old_end_position: point_for(source, old_end),
            new_end_position: point_for(&edited, new_end),
        },
        source: edited,
    }
}

pub fn valid_edit_candidates(source: &str) -> Vec<EditCase> {
    let mut edits = Vec::new();
    edits.push(make_edit(source, source.len(), source.len(), "\nbenchmark"));
    let first = boundary_at_or_before(source, source.len() / 3);
    edits.push(make_edit(source, first, first, "x"));
    let second = boundary_at_or_before(source, source.len() * 2 / 3);
    edits.push(make_edit(source, second, second, " "));
    if let Some((offset, character)) = source
        .char_indices()
        .skip_while(|(offset, _)| *offset < source.len() / 4)
        .find(|(_, character)| character.is_ascii_alphabetic())
    {
        edits.push(make_edit(
            source,
            offset,
            offset + character.len_utf8(),
            "z",
        ));
    }
    edits
}

pub fn invalid_candidates(source: &str) -> Vec<(String, String)> {
    let mut output = vec![
        ("unclosed_code_group".into(), format!("{source}\n#(")),
        ("unclosed_string".into(), format!("{source}\n#\"")),
        ("unclosed_equation".into(), format!("{source}\n$(")),
    ];
    if let Some((offset, character)) = source
        .char_indices()
        .rev()
        .find(|(_, value)| matches!(value, ')' | ']' | '}' | '"'))
    {
        let mut changed = source.to_owned();
        changed.replace_range(offset..offset + character.len_utf8(), "");
        output.push(("deleted_closer".into(), changed));
    }
    let truncation = boundary_at_or_before(source, source.len() * 3 / 4);
    if truncation > 0 && truncation < source.len() {
        output.push(("truncated".into(), source[..truncation].to_owned()));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interval_distance_handles_points_and_overlap() {
        assert_eq!(interval_distance((2, 4), (4, 8)), 0);
        assert_eq!(interval_distance((2, 2), (5, 7)), 3);
        assert_eq!(interval_distance((9, 10), (5, 7)), 2);
    }

    #[test]
    fn edit_positions_use_utf8_byte_columns() {
        let edit = make_edit("α\nb", 2, 2, "x");
        assert_eq!(edit.source, "αx\nb");
        assert_eq!(edit.edit.start_position, Point { row: 0, column: 2 });
        assert_eq!(edit.edit.new_end_position, Point { row: 0, column: 3 });
    }

    #[test]
    fn stratification_caps_each_size_bucket() {
        let files = vec![
            CorpusFile {
                id: "b".into(),
                stored: "b".into(),
                bytes: 1,
                provenances: Vec::new(),
            },
            CorpusFile {
                id: "a".into(),
                stored: "a".into(),
                bytes: 2,
                provenances: Vec::new(),
            },
            CorpusFile {
                id: "c".into(),
                stored: "c".into(),
                bytes: 8 * 1024,
                provenances: Vec::new(),
            },
            CorpusFile {
                id: "d".into(),
                stored: "d".into(),
                bytes: 128 * 1024,
                provenances: Vec::new(),
            },
        ];
        let selected = select_stratified(&files, 1);
        assert_eq!(
            selected
                .iter()
                .map(|file| file.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "c", "d"]
        );
    }
}
