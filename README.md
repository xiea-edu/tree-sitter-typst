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
mapped node spans, and `npm run test:incremental` to compare edited and fresh
trees. The node mapping is in `test/lib/kind-map.mjs`. To inspect a disagreement
in one file, run `node scripts/why.mjs <file.typ>`.

## License

MIT
