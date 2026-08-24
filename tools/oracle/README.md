# typst-oracle

Wraps `typst-syntax` — the parser from the real Typst compiler — so the test harness can
differentially compare our tree-sitter grammar against the reference implementation.

Pinned to `=0.15.1` to match the `typst` CLI this grammar targets. Bumping Typst means bumping
this pin and re-baselining.

## Commands

    typst-oracle dump <file> [--trivia]   pretty S-expression tree (human debugging)
    typst-oracle check <file>             validity + diagnostics for one file
    typst-oracle batch                    reads NUL-separated paths on stdin, emits JSONL

`batch` is the workhorse: spawning one process per file over a multi-thousand-file corpus is
dominated by process startup, so the harness streams the whole corpus through a single process.

Each `batch` output line is:

    {"path":..., "ok":bool, "len":int, "errors":[{"msg":...,"start":int,"end":int}],
     "warnings":[...], "nodes":[[start,end,"KindName"], ...]}

`nodes` is pre-order and excludes trivia (per typst's own `SyntaxKind::is_trivia`, which counts
Space, Parbreak, LineComment, BlockComment and Shebang as trivia).
