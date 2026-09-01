# tree-sitter-typst

A [tree-sitter](https://tree-sitter.github.io) grammar for [Typst](https://typst.app),
covering all three syntax modes — markup, code and math.

## Why this is hard

Typst resists the usual approach of writing a grammar from the documentation and eyeballing
the result. Three syntax modes nest into one another arbitrarily (`$#{ [*x*] }$` is valid).
A token's meaning depends entirely on mode: `*` is bold in markup, multiplication in code,
and a symbol in math. List nesting is indentation-sensitive. Even within markup the lexing
is subtle — a text run absorbs a *single* space but stops at two, `/` continues the run
unless it opens a comment, and `*` is a delimiter between non-word characters but literal
text inside a word, so `a*b` is text while `*b*` is bold.

Hand-written expectations encode the author's belief about these rules. That belief is
usually wrong somewhere, and the wrongness is invisible.

## Approach

`typst-syntax` — the parser from the real Typst compiler, pinned to `=0.15.1` — is wired in
as a **test oracle**. The grammar is checked continuously against the reference
implementation rather than against expectations written by hand.

Every non-obvious rule in `grammar.js` and `src/scanner.c` carries a comment naming the
`typst-syntax` function it was transcribed from, so each decision is traceable to the
reference rather than to a guess.

Testing is tiered, weakest to strongest:

1. **Validity agreement** — does this grammar accept exactly the files the reference
   accepts? Requires no knowledge of node names, so it ports unchanged to any Typst
   grammar. Measured in both directions: false rejects *and* false accepts.
2. **Span agreement** — does every node land on the same byte range as the reference's?
   Uses an explicit `SyntaxKind` → node-name map (`test/lib/kind-map.mjs`).
3. **Kind coverage** — every one of the reference parser's kinds must appear in that map
   or in an explicit "deliberately not modelled" list, so gaps are reported rather than
   silently passing.

The corpus is 3,831 real documents: 600 packages from Typst Universe plus Typst's own test
suite, which matters because it includes deliberately-broken files that a correct parser
must **reject**. Fuzzing and incremental-reparse checks run on top.

## Results

Against the reference parser, on the full 3,831-file corpus:

| | |
| --- | --- |
| Validity agreement | **100%** — 0 false rejects, 0 false accepts |
| Span agreement | 98.23% of files structurally identical (3,727 / 3,794) |
| `SyntaxKind` coverage | 130 / 130 kinds the corpus produces |
| Golden tests | 67, all passing |
| Fuzz / incremental | clean |

Span agreement splits by group: 98.69% on the 3,519 package files, 100% on the pinned
set, and 88.59% on Typst's own test suite — which is adversarial by design.

### Known gaps

Both of the following come from the same place: how math tells an argument list apart
from a delimited group.

**Delimiter grouping.** The remaining span disagreements are almost entirely math-mode
delimiter grouping. Typst opens a nested `Math` scope at any opening delimiter and closes
it at the end of the equation if the closer never arrives; `math_delimited` here requires
a matched pair, so an unmatched `<` or `[` produces a flat run where the reference nests.
This is why the adversarial suite scores lower than real documents. It does not affect
which tokens receive which capture, so highlighting, folding and indentation are
unaffected.

**Exponential parse on repeated named calls in math.** A run of `name: call(...),` inside
an equation costs roughly 1.9× per repetition:

```typst
$
    name: rgb(abc),     // ×35
$
```

| repetitions | parse time |
| --- | --- |
| 20 | 29 ms |
| 25 | 274 ms |
| 30 | 6.8 s |
| 35 | does not finish |

All three parts are needed — an identifier, a colon, and a **call** followed by a comma.
Any one removed and the same input parses in ~16 ms. Closing the equation does not help.

The cause is two ambiguities that sustain each other. `rgb(` may open a call's argument
list or an identifier followed by a delimited group, and nothing local decides which. The
scanner emits `math_named_ident` only when `valid_symbols` says an argument list is open,
so the *only* reason `name:` can be read as a named argument is that the first ambiguity
is keeping an "inside arguments" parse alive. Neither can be pruned locally, so live
parses multiply.

This is reachable from real documents: a package with seventeen colour themes of eighteen
`black: rgb("#000000"),` entries hangs the parser outright once an equation opens above
them. Editors reparse on every keystroke, so typing `$` above a large dictionary is enough.

A dynamic precedence on `math_call` — the remedy already used for the separators in
`_math_args` — was tried and reverted: it barely moved the exponent (6.8 s to 5.4 s at
30 repetitions) and introduced a false reject on `typst-suite/math/root.typ`, taking
validity agreement from 100% to 99.55%. A real fix means making the call-versus-group
decision authoritative rather than forked, which is surgery on the rules the validity
figure rests on.

The test harness caps any single-file parse at 60 seconds and reports the offending input,
so this degrades to a test failure rather than a hang.

### Compared with other Typst grammars

Validity agreement, same 3,831 files, via `npm run compare`:

| grammar | overall | typst's own suite | false rejects | false accepts |
| --- | --- | --- | --- | --- |
| **this grammar** | **100.00%** | **100.00%** | **0** | **0** |
| [uben0](https://github.com/uben0/tree-sitter-typst) `46cf4ded` | 98.43% | 95.48% | 53 | 7 |
| [SeniorMars](https://github.com/SeniorMars/tree-sitter-typst) `1acd48c9` | 97.26% | 92.76% | 100 | 5 |

Structural fidelity, on a 150-file sample of the same corpus. This compares **byte spans
only**, with punctuation and keywords excluded (tree-sitter models those as anonymous
tokens), so it applies the same rule to every grammar and needs no per-grammar kind map:

| grammar | span agreement | files matching exactly | nodes not in the reference tree |
| --- | --- | --- | --- |
| **this grammar** | **99.70%** | **85 / 147** | 3,665 |
| SeniorMars | 98.10% | 28 / 147 | 27,134 |
| uben0 | 97.38% | 17 / 147 | 22,156 |

The last column is the clearest separator. Both other grammars introduce a document
hierarchy the reference parser does not have — headings become containers nesting their
following content, and paragraph breaks become named nodes — which is a reasonable choice
for folding and section text objects, but means their trees cannot be checked against
`typst-syntax` at all.

Reproduce with:

```sh
npm run corpus:fetch
npm run oracle:build
npm run compare -- ../tree-sitter-typst-uben0 ../tree-sitter-typst-seniormars
```

### Caveats

- The other grammars may target a different Typst version than the pinned 0.15.1 oracle,
  and constructs newer than their target count against them unfairly.
- They may have different goals. A grammar aiming only at highlighting can reasonably
  accept more than the language does.
- "False accept" is measured against files the real parser rejects, and a corpus of real
  documents contains few of those — so it is a weaker signal than the false-reject count.
- The structural table is a 150-file sample, not the full corpus, and its metric is
  deliberately crude so that it ports across grammars. It is not the same measurement as
  the 98.23% figure above, which uses the kind map.

## Usage

Generated `src/parser.c`, `src/grammar.json`, `src/node-types.json` and `src/tree_sitter/`
are committed, so consumers compile the C directly without running the tree-sitter CLI.

Queries live in `queries/` — `highlights`, `injections`, `locals`, `folds`, `indents`.

## Development

```sh
npm run build          # tree-sitter generate && tree-sitter build
npm test               # full suite
npm run test:valid     # validity agreement only
npm run test:diff      # span agreement only
npm run coverage       # SyntaxKind coverage ledger
node scripts/why.mjs <file.typ>   # explain one file's disagreement
```

Bumping the target Typst version means bumping the `typst-syntax` pin in
`tools/oracle/Cargo.toml` and re-baselining.

## License

MIT
