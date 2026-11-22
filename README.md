# tree-sitter-typst

This branch builds the `typst` grammar for Emacs and stock `typst-ts-mode`
0.12.3. The mode supplies its own highlighting, indentation, Imenu, and
structural editing commands. The parser uses `typst-syntax` 0.15.1 as its
reference for valid syntax.

## Use in Emacs

With this branch checked out locally, register the checkout as the grammar
source. Adjust the path for your machine.

```elisp
(with-eval-after-load 'treesit
  (setf (alist-get 'typst treesit-language-source-alist)
        (list (expand-file-name "dev/tree-sitter-typst"
                                (or (getenv "USERPROFILE") "~")))))
```

Run `M-x treesit-install-language-grammar RET typst RET`, then start a new
Emacs process and visit a `.typ` file in `typst-ts-mode`. This also replaces an
older installed Typst grammar. Use the built-in installer here because
`typst-ts-mc-install-grammar` supplies its own upstream repository. The
tested configuration is Emacs 31.1 with Tree-sitter grammar ABI 15.

Keep a final newline when using the mode's `M-RET` heading command. In
0.12.3, invoking it on the last section of a buffer without a final newline
can turn the last body line into a heading. This also happens with uben0's grammar.

## Source

Edit `grammar.js` for syntax rules and `src/scanner.c` for context-sensitive
tokens. Regenerate the parser after changing the grammar and commit the generated
files under `src/` with the change. Emacs compiles `src/parser.c` and
`src/scanner.c` directly.

## Development

From the repository root, with Node.js, Rust, and a C compiler installed:

```sh
npm ci
npm run build
npm run test:corpus
```

Run `npm run test:emacs` to build a private grammar library and exercise the
installed major mode in batch Emacs. Set `EMACS` to the executable path if it
is outside `PATH`. Set `TYPST_TS_MODE_DIR` to the directory containing
`typst-ts-mode.el` if the package is outside the default package directory.
The tests run without loading your personal init file.

For differential and incremental checks, build the pinned oracle and fetch the
test corpus once:

```sh
npm run oracle:build
npm run corpus:fetch
npm test
```

Use `npm run test:valid` to compare acceptance, `npm run test:diff` to compare
mapped node counts, byte spans, and parents, and `npm run test:incremental` to compare edited and fresh
trees. For example, the official parser wraps a named function and its body in
a closure. The Emacs tree puts the signature in the `pattern` field of a
`let` and the body in its `value` field. The differential test compares
the corresponding spans and parents. Document and content-block headings
form sections. As in the mode's original grammar, depths above six share the
sixth marker type. The Emacs tests cover nesting, fold boundaries, and edits.
The node mapping is in `test/lib/kind-map.mjs`. To inspect a disagreement in
one file, run `node scripts/why.mjs <file.typ>`.

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
