//! Differential-testing oracle: exposes the real Typst parser (`typst-syntax`) to the
//! JS test harness so our tree-sitter grammar can be checked against the reference
//! implementation rather than against hand-written expectations.

use std::io::{self, BufWriter, Read, Write};
use typst_syntax::{parse, SyntaxNode};

/// A flattened, pre-order view of one syntax node.
struct Flat {
    start: usize,
    end: usize,
    kind: String,
    depth: usize,
}

/// Flatten `n` into pre-order `(start, end, kind, depth)` records, skipping trivia.
///
/// Typst's tree is lossless (every byte is covered by some leaf) but nodes don't carry
/// absolute offsets, so we thread a running offset through the walk using `len()`.
fn flatten(n: &SyntaxNode, offset: usize, depth: usize, out: &mut Vec<Flat>) {
    let kind = n.kind();
    if !kind.is_trivia() {
        out.push(Flat { start: offset, end: offset + n.len(), kind: format!("{kind:?}"), depth });
    }
    let mut off = offset;
    for c in n.children() {
        flatten(c, off, depth + 1, out);
        off += c.len();
    }
}

/// Render a node as an indented S-expression, for human debugging.
fn sexp(n: &SyntaxNode, offset: usize, depth: usize, trivia: bool, out: &mut String) {
    let kind = n.kind();
    if !trivia && kind.is_trivia() {
        return;
    }
    let pad = "  ".repeat(depth);
    let span = format!("{}..{}", offset, offset + n.len());
    if n.children().len() == 0 {
        out.push_str(&format!("{pad}({kind:?} {span} {:?})\n", n.leaf_text()));
    } else {
        out.push_str(&format!("{pad}({kind:?} {span}\n"));
        let mut off = offset;
        for c in n.children() {
            sexp(c, off, depth + 1, trivia, out);
            off += c.len();
        }
        out.push_str(&format!("{pad})\n"));
    }
}

/// Parse `src` and return `(ok, errors, warnings, nodes)` as JSON-ready values.
fn analyze(src: &str) -> (bool, serde_json::Value, serde_json::Value, serde_json::Value) {
    let root = parse(src);
    let (errs, warns) = root.errors_and_warnings();

    let to_json = |ds: &[typst_syntax::SyntaxDiagnostic]| -> serde_json::Value {
        ds.iter()
            .map(|d| {
                serde_json::json!({
                    "msg": d.message.to_string(),
                    "hints": d.hints.iter().map(|h| h.v.to_string()).collect::<Vec<_>>(),
                })
            })
            .collect::<Vec<_>>()
            .into()
    };

    let mut flat = Vec::new();
    flatten(&root, 0, 0, &mut flat);
    let nodes: Vec<serde_json::Value> = flat
        .iter()
        .map(|f| serde_json::json!([f.start, f.end, &f.kind, f.depth]))
        .collect();

    (errs.is_empty(), to_json(&errs), to_json(&warns), nodes.into())
}

fn read_source(path: &str) -> io::Result<String> {
    let bytes = std::fs::read(path)?;
    // Match what the test harness feeds tree-sitter: UTF-8, LF line endings, no BOM.
    let s = String::from_utf8_lossy(&bytes).into_owned();
    Ok(s.strip_prefix('\u{feff}').unwrap_or(&s).replace("\r\n", "\n"))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("");

    match cmd {
        "dump" => {
            let path = args.get(1).expect("usage: typst-oracle dump <file> [--trivia]");
            let trivia = args.iter().any(|a| a == "--trivia");
            let src = read_source(path).expect("cannot read file");
            let root = parse(&src);
            let mut out = String::new();
            sexp(&root, 0, 0, trivia, &mut out);
            print!("{out}");
            let (errs, warns) = root.errors_and_warnings();
            eprintln!("errors={} warnings={}", errs.len(), warns.len());
            for e in errs {
                eprintln!("  error: {}", e.message);
            }
        }

        "check" => {
            let path = args.get(1).expect("usage: typst-oracle check <file>");
            let src = read_source(path).expect("cannot read file");
            let (ok, errors, warnings, _) = analyze(&src);
            let v = serde_json::json!({
                "path": path, "ok": ok, "len": src.len(),
                "errors": errors, "warnings": warnings,
            });
            println!("{v}");
        }

        // Workhorse: stream the whole corpus through one process. Paths arrive on stdin
        // NUL-separated (paths may contain spaces); one JSON object per line comes back.
        "batch" => {
            let mut input = String::new();
            io::stdin().read_to_string(&mut input).expect("stdin");
            let stdout = io::stdout();
            let mut out = BufWriter::new(stdout.lock());
            for path in input.split('\0').filter(|p| !p.is_empty()) {
                let v = match read_source(path) {
                    Ok(src) => {
                        let (ok, errors, warnings, nodes) = analyze(&src);
                        serde_json::json!({
                            "path": path, "ok": ok, "len": src.len(),
                            "errors": errors, "warnings": warnings, "nodes": nodes,
                        })
                    }
                    Err(e) => serde_json::json!({
                        "path": path, "read_error": e.to_string(),
                    }),
                };
                writeln!(out, "{v}").expect("write");
            }
            out.flush().expect("flush");
        }

        // Parse text supplied on stdin. Used by the fuzzer, which generates inputs that
        // never touch the filesystem.
        "stdin" => {
            let mut src = String::new();
            io::stdin().read_to_string(&mut src).expect("stdin");
            let (ok, errors, warnings, nodes) = analyze(&src);
            let v = serde_json::json!({
                "ok": ok, "len": src.len(),
                "errors": errors, "warnings": warnings, "nodes": nodes,
            });
            println!("{v}");
        }

        _ => {
            eprintln!("usage: typst-oracle <dump|check|batch|stdin> [args]");
            std::process::exit(2);
        }
    }
}
