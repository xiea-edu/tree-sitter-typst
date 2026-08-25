# tree-sitter-typst

A [tree-sitter](https://tree-sitter.github.io) grammar for [Typst](https://typst.app).

Covers all three of Typst's syntax modes — markup, code and math — and is
differential-tested against `typst-syntax`, the parser from the real Typst compiler,
over ~3,700 real documents.

## Why another one

Typst is unusually hard to parse. Three syntax modes nest into one another arbitrarily
(`$#{ [*x*] }$` is valid), list nesting is indentation-sensitive, and a token's meaning
depends entirely on mode — `*` is bold in markup, multiplication in code, and a symbol in
math. Even within markup the lexing is subtle: a text run absorbs a *single* space but
stops at two, `/` continues the run unless it opens a comment, and `*` is a delimiter
between non-word characters but literal text inside a word, so `a*b` is text while `*b*`
is bold.

The approach here is to not guess. `typst-syntax` is wired in as a **test oracle**, so
the grammar is continuously checked against the reference implementation rather than
against hand-written expectations. Every non-obvious rule in `grammar.js` and
`src/scanner.c` is transcribed from it, with a comment saying which function it came
from.

## Status

| | |
| --- | --- |
| Validity agreement with typst | **98.1%** of 3,740 corpus files (67 false rejects, 5 false accepts) |
| `SyntaxKind` coverage | **130 / 130** kinds the corpus produces |
| Span agreement | **78.3%** of files structurally identical to typst's tree |
| Golden tests | 60, all passing |
| Fuzz / incremental | clean |

Span agreement is the strictest number here and the one still worth pushing: it requires
every mapped node to land on exactly the same byte range as typst's, so a single
disagreement anywhere marks the whole file as differing.

## How it compares

Tier 1 is the only tier that ports across grammars unchanged — it asks nothing about node
names — so it can be run against the other Typst grammars directly:

```bash
node scripts/compare-parsers.mjs ../uben0-tree-sitter-typst ../SeniorMars-tree-sitter-typst
```

Measured over the same 3,740 files:

| grammar | overall | typst suite | false rejects | false accepts |
| --- | --- | --- | --- | --- |
| this grammar | 98.07% | 94.12% | 67 | 5 |
| [uben0](https://github.com/uben0/tree-sitter-typst) | **98.42%** | **95.48%** | **52** | 7 |
| [SeniorMars](https://github.com/SeniorMars/tree-sitter-typst) | 97.22% | 92.76% | 99 | 5 |

uben0 is ahead on validity, and the version gap makes that *more* impressive rather than
less. Its README lists `Update 0.13` as an unchecked TODO ("Identify changes" also
unchecked) and its last commit is from February 2025, so it targets pre-0.13 while the
corpus and oracle are 0.15.1. Three minor versions of newer syntax it has never seen can
only produce extra false rejects, so the handicap runs against it.

It is not a subset relationship either: it accepts 63 files this grammar rejects, and
rejects 48 that this one accepts, so the two fail on different things. That difference
list is the most useful backlog available — each entry is a construct with a known-good
counterexample.

Read the false-accept column with its denominator in mind: only **37 of the 3,740 files
are invalid Typst**, so that is the entire population a false accept can come from. This
grammar correctly rejects 32 of 37, uben0 30 of 37. It is a small sample and the two are
close; the honest summary is that uben0 is modestly more permissive and modestly better
on valid input.

Nothing here compares tree *structure*, which would need a hand-written kind map per
grammar, and other grammars may have different goals — one aiming only at highlighting
can reasonably accept more than the language does.

One trap worth knowing if you run this yourself: tree-sitter caches compiled parsers by
*language name*, and every Typst grammar is called `typst`. Without clearing that cache
between runs, whichever compiled first answers for all the others and you get three
identical scores. The script clears it.

## Using it in Neovim

Neovim ships a `typst` parser already, so point it at this one:

```lua
vim.api.nvim_create_autocmd("User", {
  pattern = "TSUpdate",
  callback = function()
    require("nvim-treesitter.parsers").typst = {
      install_info = {
        url = "https://github.com/xiea/tree-sitter-typst",
        branch = "main",
        queries = "queries",
      },
    }
  end,
})
```

Then `:TSInstall typst`. To develop against a local checkout, use a path instead of a
URL:

```lua
install_info = { url = "~/dev/tree-sitter-typst", queries = "queries" }
```

`:InspectTree` shows the parse tree for the current buffer and `:Inspect` shows the
highlight groups under the cursor — both are the fastest way to check a query change.

Query files use the standard capture names (`@markup.heading.1`, `@function.call`,
`@keyword.conditional`), so no per-editor translation is needed. `injections.scm` sends
the contents of a fenced raw block to the language named by its tag, so ```` ```rust ````
blocks get real Rust highlighting.

## Testing

Five tiers, cheapest and highest-yield first.

| Tier | What it checks | Why it exists |
| --- | --- | --- |
| Queries | Every `.scm` compiles against the current grammar | A query naming a renamed node fails silently in the editor — highlighting just stops |
| 1. Validity agreement | For every corpus file, typst accepts ⟺ we accept | Needs no node mapping, so it works from day one and scales to thousands of files |
| 2. Span agreement | Both trees flattened to `(start, end, kind)` and compared | Catches mis-*structuring* — files that parse cleanly but nest wrongly |
| 3. Golden corpus | Hand-checked `tree-sitter test` cases | The readable spec of intent, and the regression net |
| 4. Robustness | Fuzzing + incremental-reparse equivalence | Catches scanner crashes, hangs, and lost serialize/deserialize state |

Tier 1 reports two failure directions separately, because they mean opposite things:

- **false reject** — typst accepts it, we produce `ERROR`. A missing construct.
- **false accept** — typst rejects it, we parse it happily. Too permissive.

Both must reach zero. Tracking only one is how you end up with a grammar that either
can't parse real documents or accepts anything you throw at it.

Tier 4's incremental check applies a random edit, reparses incrementally, and requires
the result to be identical to a fresh parse of the edited text. Divergence there means
the external scanner is losing state across `serialize`/`deserialize` — the nastiest
class of tree-sitter bug, and the one editors hit constantly, since an editor only ever
parses incrementally. It compares only edits that leave the document *valid*: once a tree
contains `ERROR` nodes the two runs are comparing recovery heuristics, which tree-sitter
does not promise to make identical.

### Running the tests

```bash
npm install
npm run oracle:build      # builds tools/oracle (needs a Rust toolchain)
npm run corpus:fetch      # downloads ~3,700 real .typ files into corpus/ (gitignored)
npm test
```

Individual tiers:

```bash
npm run test:queries && npm run test:corpus && npm run test:valid && npm run test:diff && npm run test:fuzz && npm run test:incremental && npm run coverage
```

Useful flags: `--limit=N` caps files per group, `--rounds=N` sets fuzz/incremental
iterations, `--seed=N` reproduces a specific failing run.

Note that `--limit` changes which files are compared, so the scores move with it — the
floors below are calibrated against the full corpus.

### Score floors

`test/thresholds.json` holds the minimum each score must meet. They exist so the suite is
a regression detector rather than a permanently red light: demanding perfection from a
grammar at 98% would fail every run, and a check that always fails is one nobody reads.
Every run prints the delta in both directions, so it is obvious which way things moved.

The floors are checked against the **typst-suite** group only. That set is pinned to
`typst/typst@v0.15.1`, so its score is the same on every machine. The Universe corpus is
whatever the registry held on the day it was fetched and however many packages were
asked for — CI fetching 200 and a laptop fetching 600 do not produce the same number, so
gating on it would make the floor meaningless. It is still reported.

Ratchet them up as the numbers improve — never down to make a red build pass.

### Debugging a single file

```bash
node scripts/why.mjs path/to/file.typ
```

Prints our first error next to typst's view of the same spot. When the error node covers
most of the file — which one bad token usually causes — it instead reports the first
offset where the two token streams diverge, which is what actually localizes the problem.

```bash
node scripts/why.mjs --sample corpus 15
```

Groups every failing file by the source line that failed, so a shared root cause shows up
as one bucket rather than as N unrelated-looking files.

```bash
tools/oracle/target/release/typst-oracle dump path/to/file.typ
```

Dumps typst's own tree for comparison.

## Corpus

Fetched on demand into `corpus/`, never committed — it is third-party Apache-2.0 material
and would bloat the repo.

- **`typst/typst@v0.15.1 tests/suite`** (221 files) — the compiler's own test suite.
  Adversarial edge cases written by the people who designed the language, so it exercises
  exactly the corners a grammar gets wrong. Many files are *deliberately* invalid, which
  makes them just as useful: we must reject them too.
- **Typst Universe packages** (~3,500 files) — ordinary real-world documents, which catch
  the opposite failure mode: common constructs nobody thought to test.

## Known gaps

- Typst runs list and enum item bodies under `AtNewline::RequireColumn`, so an item
  continues onto following lines while they stay indented past the marker. We end the item
  at the first newline, leaving continuation lines as siblings. This costs structure, not
  validity.
- Typst splits a raw block's contents into one `Text` per line after computing a common
  dedent. We model the block as delimiters, an optional language tag and one content span
  — enough for injections, and the dedent is a presentation decision rather than syntax.
- Typst wraps an implicit function call — a variable directly followed by a delimited
  group, as in `$f(x)/2$` — in an extra `Math` node. We leave the pair as siblings.

  This was implemented and then reverted. Modelling it needs an adjacency assertion, since
  `a(b)` groups but `a (b)` does not, and `token.immediate` cannot express that here: it
  creates a second token for the same delimiter characters, and with both valid the lexer
  picks whichever it likes. A zero-width external token from the scanner does work — it
  already knows whether it skipped whitespace — but the resulting grammar cost 1.4 points
  of validity agreement (breaking math primes, delimiters and roots) to gain 1.3 points of
  span agreement. A false reject breaks highlighting for a whole file, so validity wins.
- A trailing `1.` with no digits after the dot (`#{1.}`) is a float in typst. Telling it
  apart from the method call `1.method()` needs lexer lookahead that tree-sitter does not
  have, and method calls are far more common.

## Version pinning

The grammar targets **Typst 0.15.1**. The oracle pins `typst-syntax = "=0.15.1"` to match.
Upgrading Typst means bumping both and re-baselining.

## License

MIT
