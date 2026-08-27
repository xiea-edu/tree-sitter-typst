use std::env;
use std::path::{Path, PathBuf};

const EXPORTED_SYMBOLS: &[&str] = &[
    "tree_sitter_typst",
    "tree_sitter_typst_external_scanner_create",
    "tree_sitter_typst_external_scanner_destroy",
    "tree_sitter_typst_external_scanner_scan",
    "tree_sitter_typst_external_scanner_serialize",
    "tree_sitter_typst_external_scanner_deserialize",
];

fn compile_parser(bench_root: &Path, directory: &str, suffix: &str) {
    let source_root = bench_root.join(directory);
    let src = source_root.join("src");
    let parser = src.join("parser.c");
    let scanner = src.join("scanner.c");

    assert!(parser.is_file(), "missing {}", parser.display());
    assert!(scanner.is_file(), "missing {}", scanner.display());

    let mut build = cc::Build::new();
    build
        .file(&parser)
        .file(&scanner)
        .include(&src)
        .include(src.join("tree_sitter"))
        .std("c11")
        .opt_level(3)
        .warnings(false)
        .define("NDEBUG", None);

    for symbol in EXPORTED_SYMBOLS {
        build.define(symbol, Some(format!("{symbol}_{suffix}").as_str()));
    }

    build.compile(&format!("typst_parser_{suffix}"));
    println!("cargo:rerun-if-changed={}", parser.display());
    println!("cargo:rerun-if-changed={}", scanner.display());
}

fn main() {
    let root = PathBuf::from(
        env::var_os("TYPST_BENCH_ROOT")
            .expect("TYPST_BENCH_ROOT must name the isolated checkout root"),
    );
    compile_parser(&root, "local", "local");
    compile_parser(&root, "uben0", "uben0");
    compile_parser(&root, "seniormars", "seniormars");
    println!("cargo:rerun-if-env-changed=TYPST_BENCH_ROOT");
}
