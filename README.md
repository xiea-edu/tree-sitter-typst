# tree-sitter-typst

A [tree-sitter](https://tree-sitter.github.io) grammar for [Typst](https://typst.app).

Covers all three of Typst's syntax modes — markup, code and math — and is
differential-tested against `typst-syntax`, the parser from the real Typst compiler,
over ~3,800 real documents.

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
| Validity agreement with typst | **100%** of 3,831 corpus files — 0 false rejects, 0 false accepts |
| Span agreement | **98.1%** of files structurally identical to typst's tree |
| `SyntaxKind` coverage | **130 / 130** kinds the corpus produces |
| Golden tests | 61, all passing |
| Fuzz / incremental | clean |

Validity agreement is exact in both directions: every file the reference parser accepts,
this grammar accepts, and every file it rejects — including the deliberately-broken ones
in typst's own test suite — this grammar rejects too.

Span agreement is the stricter number: it requires every mapped node to land on exactly
the same byte range as typst's, so a single disagreement anywhere marks the whole file as
differing. Per group it is 100% on the pinned repositories, 98.5% on the Universe
packages, and 88.0% on typst's own suite — the suite is lowest because it is deliberately
full of syntax nobody writes on purpose.

What remains is listed under [Known gaps](#known-gaps). None of it costs validity.

## How it compares

Tier 1 is the only tier that ports across grammars unchanged — it asks nothing about node
names — so it can be run against the other Typst grammars directly:

```bash
node scripts/compare-parsers.mjs ../uben0-tree-sitter-typst ../SeniorMars-tree-sitter-typst
```

All three measured in one run over the same 3,831 files:

| grammar | overall | typst suite | false rejects | false accepts |
| --- | --- | --- | --- | --- |
| this grammar | **100.00%** | **100.00%** | **0** | **0** |
| [uben0](https://github.com/uben0/tree-sitter-typst) | 98.43% | 95.48% | 53 | 7 |
| [SeniorMars](https://github.com/SeniorMars/tree-sitter-typst) | 97.26% | 92.76% | 100 | 5 |

Two caveats belong with those numbers.

The version gap runs in uben0's favour. Its README lists `Update 0.13` as an unchecked
TODO ("Identify changes" also unchecked) and its last commit is from February 2025, so it
targets pre-0.13 while the corpus and oracle are 0.15.1. Three minor versions of syntax it
has never seen can only cost it false rejects.

And the false-accept column has a small denominator: only **37 of the 3,831 files are
invalid Typst**, so that is the entire population one can come from. Getting all 37 is
worth something, but it is 37, not 3,831.

The comparison is also only fair on what it measures. Nothing here compares tree
*structure*, which would need a hand-written kind map per grammar, and another grammar may
have different goals — one aiming only at highlighting can reasonably accept more than the
language does.

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

Both must reach zero, and both now are. Tracking only one is how you end up with a
grammar that either can't parse real documents or accepts anything you throw at it — and
the second failure is the easy one to miss, since a corpus of real documents is almost all
valid and a permissive grammar looks perfect on it. Typst's own suite is the antidote: it
is full of deliberately-invalid files, so being too permissive costs you there.

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
npm run corpus:fetch      # downloads ~3,800 real .typ files into corpus/ (gitignored)
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

`test/thresholds.json` holds the minimum each score must meet, so the suite is a
regression detector rather than a permanently red light. Every run prints the delta in
both directions, so it is obvious which way things moved.

Validity is pinned at 1.0 in both directions. That is no longer a floor to climb but a
property to defend: any regression, in either direction, fails the build. Span agreement
is the one still climbing, and its floor sits just under the current score.

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
node scripts/shrink.mjs path/to/file.typ
```

Delta-debugs the file down to a minimal reproduction, holding the failure itself as the
invariant: typst accepts it and we still `ERROR`. This is the tool that actually found the
last few bugs, because grammar failures do not localize — one bad pairing produces a
single `ERROR` node spanning the whole file, so every such file looks like "an error at
line 1" no matter where the cause is. Shrinking finds the cause by construction. A
1,700-line document came down to `**_(__)____e_`, which named the bug outright.

Add `--math` inside `$...# tree-sitter-typst

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
| Validity agreement with typst | **100%** of 3,740 corpus files — 0 false rejects, 0 false accepts |
| `SyntaxKind` coverage | **130 / 130** kinds the corpus produces |
| Span agreement | **84.1%** of files structurally identical to typst's tree |
| Golden tests | 61, all passing |
| Fuzz / incremental | clean |

Validity agreement is exact in both directions: every file the reference parser accepts,
this grammar accepts, and every file it rejects — including the deliberately-broken ones
in typst's own test suite — this grammar rejects too.

Span agreement is the strictest number here and the one still worth pushing: it requires
every mapped node to land on exactly the same byte range as typst's, so a single
disagreement anywhere marks the whole file as differing. The remaining gap is
concentrated in the three structural gaps listed under [Known gaps](#known-gaps).

## How it compares

Tier 1 is the only tier that ports across grammars unchanged — it asks nothing about node
names — so it can be run against the other Typst grammars directly:

```bash
node scripts/compare-parsers.mjs ../uben0-tree-sitter-typst ../SeniorMars-tree-sitter-typst
```

All three measured in one run over the same 3,740 files:

| grammar | overall | typst suite | false rejects | false accepts |
| --- | --- | --- | --- | --- |
| this grammar | **100.00%** | **100.00%** | **0** | **0** |
| [uben0](https://github.com/uben0/tree-sitter-typst) | 98.42% | 95.48% | 52 | 7 |
| [SeniorMars](https://github.com/SeniorMars/tree-sitter-typst) | 97.22% | 92.76% | 99 | 5 |

Two caveats belong with those numbers.

The version gap runs in uben0's favour. Its README lists `Update 0.13` as an unchecked
TODO ("Identify changes" also unchecked) and its last commit is from February 2025, so it
targets pre-0.13 while the corpus and oracle are 0.15.1. Three minor versions of syntax it
has never seen can only cost it false rejects.

And the false-accept column has a small denominator: only **37 of the 3,740 files are
invalid Typst**, so that is the entire population one can come from. Getting all 37 is
worth something, but it is 37, not 3,740.

The comparison is also only fair on what it measures. Nothing here compares tree
*structure*, which would need a hand-written kind map per grammar, and another grammar may
have different goals — one aiming only at highlighting can reasonably accept more than the
language does.

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

Both must reach zero, and both now are. Tracking only one is how you end up with a
grammar that either can't parse real documents or accepts anything you throw at it — and
the second failure is the easy one to miss, since a corpus of real documents is almost all
valid and a permissive grammar looks perfect on it. Typst's own suite is the antidote: it
is full of deliberately-invalid files, so being too permissive costs you there.

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

`test/thresholds.json` holds the minimum each score must meet, so the suite is a
regression detector rather than a permanently red light. Every run prints the delta in
both directions, so it is obvious which way things moved.

Validity is pinned at 1.0 in both directions. That is no longer a floor to climb but a
property to defend: any regression, in either direction, fails the build. Span agreement
is the one still climbing, and its floor sits just under the current score.

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

, where parens and braces are ordinary symbols and are not
expected to balance.

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
- **Pinned repositories** (91 files) — packages you actually write documents against,
  fetched in full from GitHub at a tag. The Universe sample below is the
  alphabetically-first N packages, which is reproducible but arbitrary — it stops around
  the letter *i* — so anything you depend on deserves to be listed in `PINNED_REPOS` in
  `scripts/fetch-corpus.mjs` whatever its name. GitHub rather than the registry, because a
  published tarball is only the library: the repository also carries examples, docs and
  tests, which is where the interesting syntax lives.

  Being version-pinned, this group's score is reproducible, so it is gated like the suite.
  It currently holds [touying](https://github.com/touying-typ/touying).
- **Typst Universe packages** (~3,500 files) — ordinary real-world documents, which catch
  the opposite failure mode: common constructs nobody thought to test.

  This is the one group that is *not* gated: it is whatever the registry held on the day it
  was fetched and however many packages were asked for, so CI fetching 200 and a laptop
  fetching 600 do not produce the same number.

## Known gaps

Roughly 70 of 3,831 files still differ from typst in tree *shape*. Every one of them
parses without error; the disagreements are about where nodes begin and end.

- **In-word `*` and `_`.** Typst ends a text run at one and starts a new one, so
  `Administrator*innen` is two `Text` nodes and `1_000_g` is three. We produce one.

  This is the single largest remaining cause, and it is architectural rather than an
  oversight. Whether such a delimiter is emphasis or literal text depends on the character
  *before* it, and at the start of a run the scanner cannot see backwards. Absorbing the
  delimiter into the run is what makes the decision possible at all — the run knows what it
  just consumed. Splitting the run would need the previous character to survive between
  scanner calls, and it cannot: tree-sitter persists scanner state only behind tokens that
  survive, so a remembered character outlives every token the built-in lexer produced in
  between. An earlier version of this scanner tried exactly that and could not be kept
  honest.

- **Raw block contents.** Typst splits them into one `Text` per line after computing a
  common dedent. We model the block as delimiters, an optional language tag and one content
  span — enough for injections, and the dedent is a presentation decision rather than
  syntax.

- **Unmatched opening delimiters in math.** `$(a$` wraps everything from the `(` to the end
  of the equation in a `Math` node in typst; we leave the bracket as a loose symbol. Adding
  the rule works, but an opener that may never close is ambiguous against nearly every math
  rule, and each declared conflict revealed another. Not worth the parse cost for seven
  files, all of them torture tests.

- **Single-element math arguments.** Typst puts a lone `MathText` straight into `MathArgs`
  and only wraps a run of several in `Math`. Modelling that gains half a point on the suite
  but costs a corpus file its parse, on a deeply nested unmatched-bracket case. Validity
  wins.

## Version pinning

The grammar targets **Typst 0.15.1**. The oracle pins `typst-syntax = "=0.15.1"` to match.
Upgrading Typst means bumping both and re-baselining.

## License

MIT
