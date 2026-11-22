# tree-sitter-typst

Tree-sitter grammar for Typst markup, code, and math. The reference parser for
development is `typst-syntax` 0.15.1.

## Source

Edit `grammar.js` for syntax rules and `src/scanner.c` for context-sensitive
tokens. Regenerate the parser after changing the grammar and commit the generated
files under `src/` with the change. Editors can compile `src/parser.c` and
`src/scanner.c` directly. Editor queries live in `queries/`.

## Development

From the repository root, with Node.js, Rust, and a C compiler installed:

```sh
npm ci
npm run build
npm run test:corpus
```

For differential and incremental checks, build the pinned oracle and fetch the
test corpus once:

```sh
npm run oracle:build
npm run corpus:fetch
npm test
```

Use `npm run test:valid` to compare acceptance, `npm run test:diff` to compare
mapped node counts, byte spans, and parents, and `npm run test:incremental` to compare edited and fresh
trees. The node mapping is in `test/lib/kind-map.mjs`. To inspect a disagreement
in one file, run `node scripts/why.mjs <file.typ>`.

The corpus includes the Typst compiler suite, Touying, a sample of Universe
packages, and the pinned test inputs from uben0 and SeniorMars. Each Tree-sitter
corpus example runs as its own Typst document against the oracle, including
uben0's imported compiler examples and SeniorMars's standalone fixtures.
`test/peer-corpora.json` records both revisions and the individual cases with
known disagreements. The remaining cases involve duplicate dictionary keys,
named arguments, or parameter names. New disagreements fail the suite. When a case starts
matching the oracle, remove its entry from that file.

## License

MIT
