/**
 * @file Tree-sitter grammar for the Typst markup language
 * @license MIT
 *
 * Node names mirror `typst_syntax::SyntaxKind` in snake_case (`let_binding`,
 * `func_call`, `content_block`). That keeps the differential test's translation table
 * near-mechanical, so a disagreement with the reference parser means a real structural
 * bug rather than a naming difference.
 *
 * Whitespace is in `extras`, matching Typst's own model: its lexer emits `Space` and
 * `Parbreak` as *trivia* in every mode, including markup. Spacing that actually changes
 * meaning — `#f(x)` versus `#f (x)` — is handled with `token.immediate` instead.
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

// Binary operator precedence, copied from `BinOp::precedence` in typst-syntax. Higher
// binds tighter. Unary `+`/`-` are 7 and unary `not` is 4 (`UnOp::precedence`).
const PREC = {
  unary: 7,
  mul: 6,
  add: 5,
  cmp: 4,
  not: 4,
  and: 3,
  or: 2,
  assign: 1,
};

// Postfix access binds tighter than any operator. `args` outranks `func_call` so that a
// trailing content block is shifted into the *current* argument list rather than
// triggering a reduce that would start a second, nested call: `f(1)[x]` is one call.
const PREC_ARGS = 21;
const PREC_ACCESS = 20;
const PREC_CALL = 19;

// Math has its own precedence table (typst's `math_op`): `/` builds a fraction, `^`
// and `_` attachments, and a call or root binds tighter than either.
const PREC_MATH = {
  frac: 1,
  attach: 2,
  func: 2,
  root: 2,
};

// Delimiter pairs in math. Typst also accepts any Unicode character whose math class is
// Opening or Closing; these are the ones that occur in practice.
const MATH_OPEN = choice('(', '[', '{', '⟨', '⌊', '⌈', '|', '‖', '[|');
const MATH_CLOSE = choice(')', ']', '}', '⟩', '⌋', '⌉', '|', '‖', '|]');

module.exports = grammar({
  name: 'typst',

  extras: $ => [
    /\s/,
    // Non-ASCII whitespace is trivia in code and math but *content* in markup, where
    // typst gives a character like U+3000 its own one-character `Text` node. Only the
    // scanner can tell the two apart, so this is an external token rather than a regex.
    $._non_ascii_space,
    $.line_comment,
    $.block_comment,
  ],

  // Tokens the external scanner owns, because each needs either lookahead or knowledge
  // of the preceding character — neither of which a tree-sitter regex can express.
  // Order must match `enum TokenType` in src/scanner.c.
  externals: $ => [
    $.text,             // the stop table plus its continuation rules
    $.shorthand,        // `~ ... --- -- -?`, and `-` before a digit
    $._star,            // `*` only outside a word
    $._underscore,      // `_` only outside a word
    $.heading_marker,   // `=`+ at line start, followed by a space
    $.list_marker,      // `-` at line start, followed by a space
    $.enum_marker,      // `+` or `1.` at line start, followed by a space
    $.term_marker,      // `/` at line start, followed by a space
    $.raw_delim,        // a backtick fence; the closer must match the opener's count
    $.raw_lang,         // the language tag of a fenced block, for injections
    $.raw_content,      // everything between the fences, whitespace included
    $._atomic_end,      // an embedded value ends unless `.`, `(` or `[` follows
    $._stmt_end,        // an embedded statement ends at the newline
    $._heading_end,     // a heading ends at the newline, or at a label
    $._line_end,        // a heading or list item ends at the newline
    $._code_sep,        // zero-width: a line break separates two code expressions
    // Numbers come from the scanner because typst *validates* the token it lexed: it
    // reads the whole alphanumeric run and errors if the result is not a number, rather
    // than backing off to a shorter match. A regex splits `123.456e` into a float and an
    // identifier, and `0b1010pt` into an integer and an identifier — both of which then
    // parse cleanly as two expressions, so the error disappears.
    $._number_int,
    $._number_float,
    $._number_numeric,
    $._block_comment,   // `/* ... */`, which nests
    $._math_dot,        // the `.` of a math field access: a name must follow it
    $._math_adjacent,   // zero-width: a delimiter follows immediately, so it is a call
    $._escape,          // `\x`, or `\u{...}` with a codepoint that is a real character
    $._linebreak,       // `\` at the end of a line
    $._adjacent_prime,  // zero-width: a `'` follows immediately, so it attaches
    $.link,             // a bare URL, with `[]` and `()` balanced
    $._non_ascii_space, // whitespace outside markup, where typst skips it as trivia
    $._error_sentinel,  // never matched; signals error recovery to the scanner
  ],

  // Lets keyword tokens win over `ident` without a separate lexical state. Because `-`
  // is an identifier-continue character in Typst, `not-x` correctly lexes as the single
  // identifier `not-x` rather than `not` applied to `-x`.
  word: $ => $.ident,

  // A `(` in code mode is genuinely ambiguous until its contents have been read: it may
  // open a parenthesized expression, an array, a dictionary, a closure's parameter list,
  // or a destructuring pattern, and nothing before the matching `)` distinguishes them.
  // Typst's own parser resolves this by backtracking; the GLR parser explores the
  // alternatives in parallel instead. Every entry below is one of those genuine
  // ambiguities, not a workaround for a badly factored rule.
  conflicts: $ => [
    // `(a, b)` — array of values, or a pattern binding two names? And `(a: b)` is a
    // dictionary, a parameter list or a destructuring pattern depending on where it sits.
    [$.array, $.dict],
    [$.array, $.dict, $.destructuring],
    [$.array, $.dict, $.params],
    [$.dict, $.params],
    [$.array, $.dict, $.params, $.destructuring],
    [$.params, $.destructuring],

    // An identifier is a value in an expression and a binding site in a pattern.
    [$._postfixable, $._pattern],

    // `()` — an empty array, or an empty destructuring pattern?
    [$.array, $.destructuring],

    // `import "m": a.b • as c` — is `a.b` the whole item, or the path of a rename?
    [$.import_items],
    [$.import_items, $.renamed_import_item],

    // `#set foo • [` — a set rule whose arguments are a content block, or the
    // identifier `foo` followed by a separate content block?
    [$._postfixable, $.set_rule],

    // `#if c [x]` — a conditional embedded in markup ends there, or continues as the
    // target of a field access. Only what follows the block says which.
    [$._hash_value, $._postfixable],
    [$._value, $._postfixable],

    // `/ a: b` — a term item, or ordinary text that happens to contain a colon? The
    // colon is plain text in markup, and only a term item gives it a second meaning.
    [$._markup_expr, $.term_item],

    // A run of markup can always be extended or closed.
    [$.markup],

    // `let f • (` again, now that the function form builds a closure.
    [$._let_closure],

    // Math delimiters double as symbols: `(` opens a group but also renders as a
    // parenthesis, and a closing brace with no opener is simply a symbol. Whether a run
    // of math is finished or still open is likewise undecidable until the closer appears.
    [$._math_expr, $.math_delimited],
    [$._math_operand, $.math_delimited],
    // `x^(a)` — grouping parens in a script slot, against the same parens read as a
    // delimited group. Only the position tells them apart.
    [$._math_operand, $.math_delimited, $._math_group],
    [$._math_expr, $.math_delimited, $._math_group],
    [$.math_delimited, $._math_group],
    [$.math],

    // `f(size: 2)` — is `size` the start of a math expression, or the name of an
    // argument? Only the colon says, and it comes later.
    [$._math_expr, $._math_args],
    [$._math_expr, $._math_named_arg],
    [$._math_named_arg],
    [$._math_spread_arg],

    [$._math_operand, $._math_args],
  ],

  rules: {
    // -----------------------------------------------------------------------
    // markup
    // -----------------------------------------------------------------------
    //
    // Most markup tokens come from the external scanner, which reproduces typst's
    // `Lexer::markup` — see src/scanner.c for why they cannot be regexes.

    source_file: $ => repeat($._markup_expr),

    _markup_expr: $ => markupExpr($, { label: true }),

    // A heading's body stops at a label, so in `= Real <real>` the label is a sibling of
    // the heading rather than part of it. Typst spells this as a stop set on the
    // heading's markup: `syntax_set!(Label, RightBracket, End)`.
    _markup_expr_unlabelled: $ => markupExpr($, { label: false }),
    _markup_unlabelled: $ => repeat1($._markup_expr_unlabelled),

    // Brackets are ordinary text in markup — `a [b] c` is five text nodes, not a content
    // block. Typst's `markup_expr` tracks a nesting counter and converts both brackets to
    // `Text`; modelling the balance in the grammar has the same effect, and leaves an
    // *unbalanced* `]` free to close an enclosing content block.
    _bracket_text: $ => seq(
      alias('[', $.text),
      optional($.markup),
      alias(']', $.text),
    ),

    /*
     * `\u{1f600}` or `\` plus any single character; a `\` before whitespace or end of line
     * is a linebreak instead.
     *
     * Both come from the scanner, and they have to come from it together. Typst validates
     * the codepoint — `\u{FFFFFF}` is past the last one and `\u{D800}` is a surrogate, so
     * neither is a character — and a regex cannot check that. But declining the escape is
     * only half the job: with `linebreak` left as a plain `\` token, the backslash would
     * simply match that instead and the invalid escape would still parse. Owning both is
     * what makes an invalid codepoint an error, exactly as in `Lexer::escape`.
     */
    escape: $ => $._escape,
    linebreak: $ => $._linebreak,

    // Typst does not decide opening versus closing here; that is a rendering concern.
    smart_quote: _ => choice('\'', '"'),

    // `` `code` `` or a fenced block with a language tag. The pieces are separate nodes
    // so `queries/injections.scm` can point `raw_lang` at `raw_content` and get the
    // embedded language highlighted.
    raw: $ => seq(
      $.raw_delim,
      optional($.raw_lang),
      optional($.raw_content),
      $.raw_delim,
    ),

    /*
     * Typst never nests a delimiter inside its own kind. `strong` runs `markup` with the
     * stop set `{Star, Parbreak, RightBracket, End}`, so the very next `*` closes it:
     * `*a *b* c*` is two separate strongs with the text `b` between them, not one
     * containing another. Excluding the delimiter from its own body says exactly that.
     *
     * That also removes the ambiguity outright. The `[$.strong]` and `[$.emph]` conflicts
     * this replaces let GLR choose any pairing it liked, and on a dense run it would pick
     * one that could not close — failing the whole file rather than just nesting oddly.
     *
     * The other kind still nests: `*a _b_ c*` is a strong containing an emph, because
     * only `Star` is in strong's stop set.
     */
    strong: $ => seq($._star, optional(alias($._markup_no_strong, $.markup)), $._star),
    emph: $ => seq($._underscore, optional(alias($._markup_no_emph, $.markup)), $._underscore),

    _markup_no_strong: $ => repeat1(markupExpr($, { label: true, strong: false })),
    _markup_no_emph: $ => repeat1(markupExpr($, { label: true, emph: false })),

    // `<name>` — identifier characters plus `:` and `.`.
    label: _ => token(seq('<', /[_\-:.\p{XID_Continue}]+/u, '>')),

    // `@name` or `@name[supplement]`. The marker excludes a trailing `.` or `:` so that
    // `see @thm.` ends the reference before the sentence's full stop.
    ref: $ => seq(
      $.ref_marker,
      optional(alias($._content_block_immediate, $.content_block)),
    ),
    ref_marker: _ => token(seq(
      '@',
      /[_\-\p{XID_Continue}]/u,
      optional(/[_\-:.\p{XID_Continue}]*[_\-\p{XID_Continue}]/u),
    )),


    // Each of these ends at the end of its line; `_line_end` is a zero-width token the
    // scanner emits when the body is over.
    heading: $ => seq(
      $.heading_marker,
      optional(alias($._markup_unlabelled, $.markup)),
      $._heading_end,
    ),
    list_item: $ => seq($.list_marker, optional($.markup), $._line_end),
    enum_item: $ => seq($.enum_marker, optional($.markup), $._line_end),
    term_item: $ => seq(
      $.term_marker,
      field('term', optional($.markup)),
      ':',
      field('description', optional($.markup)),
      $._line_end,
    ),

    // -----------------------------------------------------------------------
    // math
    // -----------------------------------------------------------------------
    //
    // Math is its own mode with its own tokens: `*` is a symbol rather than bold, a
    // multi-character run is a symbol name while a single character is a variable, and
    // `/`, `^`, `_` are operators. Typst distinguishes inline `$x$` from display `$ x $`
    // by the spacing inside the dollars, but that is a layout decision — both produce the
    // same `Equation` node.

    equation: $ => seq('$', optional($.math), '$'),

    math: $ => repeat1($._math_expr),

    _math_expr: $ => mathExpr($, { operators: true }),

    // What an attachment may take as base or script. Excluding the operators is what
    // keeps `x_i^2` a single flat attachment with both scripts, as typst produces,
    // rather than a subscript whose script is itself a superscript.
    _math_operand: $ => mathExpr($, { operators: false }),

    // A run of two or more characters names a symbol (`sum`, `alpha`); a single
    // character is a variable. That is why `$sum$` is the summation sign but `$s u m$`
    // is three variables. Note there is no `_` here — unlike code identifiers, since `_`
    // is the subscript operator in math.
    math_ident: _ => token(/[\p{XID_Start}][\p{XID_Start}\p{Mn}\p{Mc}\p{Nd}]+/u),

    /*
     * A single grapheme, or a number kept whole.
     *
     * Split in two because only a *letter* may begin an implicit call: typst wraps
     * `$f(x)$` in an extra `Math` node but leaves `$2(x)$` and `$+(x)$` alone. The two
     * halves match disjoint character sets, so the lexer is never choosing between two
     * tokens for the same text — the trap that sinks `token.immediate` here. Both are
     * aliased back to `math_text` at every use, so the node name is unchanged.
     */
    _math_letter: _ => token(/\p{L}/u),
    _math_other: _ => token(choice(
      /[0-9]+(\.[0-9]+)?/,
      /[^\s\\"\-:!.,;#_$/^&'()\[\]{}|<>=~*+\p{L}]/u,
    )),

    // `a.b` — built by typst's lexer rather than its parser, so the dot is not a general
    // field access here.
    /*
     * `$angle.l$` is a field access, but `$ab.$` is an identifier followed by a text dot —
     * a sentence-ending period after a symbol name is extremely common. Only the character
     * *after* the dot separates the two, and `token.immediate('.')` cannot look there: it
     * wins whenever the dot touches the identifier, so the parser committed to a field
     * access and then had no name to finish it. The scanner supplies a dot that exists
     * only when a name follows.
     */
    math_field_access: $ => prec.left(seq(
      choice($.math_ident, $.math_field_access),
      alias($._math_dot, '.'),
      alias(token.immediate(/[\p{XID_Start}][\p{XID_Start}\p{Mn}\p{Mc}\p{Nd}]*/u), $.math_ident),
    )),

    // `sum(x)` — a call needs the parenthesis directly adjacent, like in code.
    math_call: $ => prec.left(PREC_MATH.func, seq(
      field('item', choice($.math_ident, $.math_field_access)),
      field('args', alias($._math_args, $.math_args)),
    )),
    // Math arguments are comma- or semicolon-separated, and each one may be named
    // (`lr(}, size: #h)`) or spread. Each argument's contents are wrapped in `math`,
    // which is what typst's `math_exprs` does per argument.
    /*
     * The separators carry a dynamic precedence because `,` and `;` have a second
     * reading: `mathExpr` also offers them as `math_text`, which is what they are
     * everywhere outside an argument list. Left evenly matched, every separator doubles
     * the number of parses, and a call holding two sibling calls of two rows each — the
     * shape at the heart of Mozilla's MathML torture test — never resolves.
     *
     * Only `prec.dynamic` states this. A static precedence has no effect here: the two
     * readings are separate parses GLR is choosing between, not competing rules within
     * one.
     */
    _math_args: $ => seq(
      token.immediate('('),
      sepBy(prec.dynamic(30, choice(',', ';')), optional($._math_arg)),
      ')',
    ),

    _math_arg: $ => choice(
      alias($._math_named_arg, $.named),
      alias($._math_spread_arg, $.spread),
      $.math,
    ),

    // The name is a code identifier rather than a math one — typst lexes it with
    // `maybe_math_named_arg`, which is why `size` here is not a math symbol.
    // The name is aliased rather than parsed as a code `ident`: in math the lexer has
    // already produced a math token for `size`, and a second token cannot be chosen for
    // the same characters. Typst reports the node as `Ident`, so that is what we call it.
    _math_named_arg: $ => prec.dynamic(2, seq(
      field('name', alias(choice($.math_ident, mathText($)), $.ident)),
      ':',
      optional($.math),
    )),
    _math_spread_arg: $ => seq('..', optional($.math)),

    // `(x + y)`, `[|v|]` and the Unicode bracket pairs. Typst re-labels the delimiters as
    // math text, since they render as symbols rather than acting as grouping syntax.
    math_delimited: $ => seq(
      alias(MATH_OPEN, $.math_text),
      optional($.math),
      alias(MATH_CLOSE, $.math_text),
    ),


    // `x^2`, `x_i`, `x_i^2`. Right-associative, and `^` and `_` chain into a single
    // attachment so `x_i^2` is one node with both a subscript and a superscript.
    math_attach: $ => prec.left(PREC_MATH.attach, seq(
      field('base', $._math_operand),
      repeat1(seq(
        field('operator', choice('^', '_')),
        field('attachment', choice(alias($._math_group, $.math), $._math_operand)),
      )),
    )),

    /*
     * Round parens in an attachment slot are *grouping*, not a delimited group: typst
     * emits `Math` with real `LeftParen`/`RightParen` tokens for `x_(a+b)`, so the parens
     * disappear from the rendered output instead of showing as symbols.
     *
     * Only round parens, and only in that slot. Square and curly brackets stay
     * `math_delimited` with the brackets as visible text, and a base like `(a+b)^2` is
     * delimited too — it is the script position that asks for grouping, not the
     * parentheses themselves.
     */
    _math_group: $ => prec.dynamic(5, seq('(', optional($.math), ')')),

    /*
     * `$f(x)$` — a single-letter variable directly followed by a delimited group. Typst
     * wraps the pair in an extra `Math` node; `$f (x)$` with a space is two siblings, and
     * `$2(x)$` and `$+(x)$` never wrap at all, since only a letter is continuable.
     *
     * The adjacency comes from a zero-width scanner token. `token.immediate` cannot
     * express it: the delimiters already have a token, and a second one for the same
     * characters leaves the lexer free to pick either. The scanner decides before skipping
     * whitespace, so "nothing in between" is simply whether the next character opens a
     * group — the same trick as the prime in `a'`.
     */
    math_implicit_call: $ => prec.left(PREC_MATH.func, seq(
      alias($._math_letter, $.math_text),
      $._math_adjacent,
      $.math_delimited,
    )),

    /*
     * Primes bind like an attachment but take no right operand, and only when directly
     * adjacent: `a'` attaches while `a '` is `a` followed by a standalone prime. A bare
     * `$'$` is a prime with nothing to attach to at all.
     *
     * Adjacency comes from a zero-width scanner token rather than `token.immediate`,
     * which would need a second token for `'` — and with both valid the lexer picks
     * whichever it likes, so the immediate one never matches. That is what broke
     * `f("x", ')`, where the space before the quote left it unmatchable.
     */
    math_primes: $ => prec.left(PREC_MATH.attach, seq(
      field('base', $._math_operand),
      $._adjacent_prime,
      $.math_primes_marker,
    )),

    math_primes_marker: _ => token(/'+/),

    // Both slots group round parens, the same way a script slot does — see `_math_group`.
    math_frac: $ => prec.left(PREC_MATH.frac, seq(
      field('numerator', choice(alias($._math_group, $.math), $._math_expr)),
      '/',
      field('denominator', choice(alias($._math_group, $.math), $._math_expr)),
    )),

    math_root: $ => prec.right(PREC_MATH.root, seq(
      field('operator', choice('√', '∛', '∜')),
      field('radicand', choice(alias($._math_group, $.math), $._math_operand)),
    )),

    math_align_point: _ => '&',

    // The full shorthand set from typst's math lexer, longest first so that `<==>` is
    // not read as `<=` followed by `=>`.
    math_shorthand: _ => token(choice(
      '<==>', '<-->', '<--', '<-<', '<->', '<<-', '<<<', '<=>', '<==', '<~~',
      '>->', '>>>', '=>>', '|->', '|=>', '~~>', '::=', '-->', '->>', '...',
      '<=', '<<', '<-', '<~', '>=', '>>', '=>', '=:', ':=', '!=', '||', '~>',
      '->', '*', '-', '~',
    )),

    // A `#` in markup escapes into code mode for exactly one expression. Typst emits the
    // `Hash` as a sibling of the expression rather than a parent, so the expression node
    // must span only the expression itself — hence a hidden rule with an anonymous `#`.
    // Typst treats the two kinds of embedded expression differently, so they get
    // different terminators — see the comment in src/scanner.c. Both terminators are
    // required, which is what keeps markup from resuming in the middle of a code
    // expression.
    _hash_expr: $ => choice(
      seq('#', $._postfixable, $._atomic_end),
      seq('#', $._hash_value, $._atomic_end),
      seq('#', $._hash_statement, choice(';', $._stmt_end)),
    ),

    /*
     * Only these six are statements in Typst — `set::STMT` is exactly
     * `{Let, Set, Show, Import, Include, Return}`. A statement must be followed by a
     * semicolon or a line break, which is what `_stmt_end` enforces.
     */
    _hash_statement: $ => choice(
      $.let_binding,
      $.set_rule,
      $.show_rule,
      $.module_import,
      $.module_include,
      $.func_return,
    ),

    /*
     * `context`, `if`, `while` and `for` are NOT statements, despite reading like them.
     * They end as soon as their body does, and markup may resume immediately on the same
     * line: `#context counter(page).display() of #context ...` is ordinary Typst.
     */
    _hash_value: $ => choice(
      $.contextual,
      $.conditional,
      $.while_loop,
      $.for_loop,
      $.loop_break,
      $.loop_continue,
    ),


    // -----------------------------------------------------------------------
    // code
    // -----------------------------------------------------------------------

    // Split in two so the postfixable subset is named exactly once. Listing the same
    // alternatives in both `_expr` and `_postfixable` would make every `ident` ambiguous
    // between the two wrappers.
    _expr: $ => choice($._value, $._statement_expr),

    /**
     * Expressions that may be an operand.
     *
     * Statement forms are excluded, and that matters: with `let_binding` available as an
     * operand, `let f(x) = { ... }` parsed as `(let f(x)) = { ... }` — a binary
     * assignment whose left side was the binding — instead of attaching the block as the
     * function's body. Conditionals and loops stay, because they really do produce
     * values: `let x = if c { 1 } else { 2 }` is ordinary Typst.
     */
    _value: $ => choice(
      $._postfixable,
      $.unary,
      $.binary,
      $.closure,
      $.contextual,
      $.conditional,
      $.while_loop,
      $.for_loop,
    ),

    _statement_expr: $ => choice(
      $.let_binding,
      $.set_rule,
      $.show_rule,
      $.module_import,
      $.module_include,
      $.loop_break,
      $.loop_continue,
      $.func_return,
      // `destructuring` is deliberately absent: typst only ever produces it as the
      // left side of a destructuring assignment or as a `let` pattern, never as a
      // standalone expression. Listing it here made every `(a: 1)` ambiguous with a
      // dictionary, and the parser resolved it the wrong way.
      $.destruct_assignment,
    ),

    code_block: $ => seq('{', optional($.code), '}'),

    // Typst wraps the contents of `{ ... }` in a `Code` node, distinct from the block.
    /*
     * Typst requires a `;` or a line break *between* code expressions — `{ 1 2 }` is
     * "expected semicolon or line break", not two expressions. Leaving the separator
     * optional was how `{123.456e}` slipped through: it lexes as a float and an
     * identifier, which an unseparated sequence happily accepts.
     *
     * The terminator is required rather than optional, which is what makes it bite: the
     * scanner supplies it at a line break and at the closing brace, and declines before
     * a `.` or an `else`, since those two continue the previous expression across a
     * newline (`a\n.b()` is one method call).
     */
    code: $ => repeat1(seq($._expr, choice(';', $._code_sep))),

    content_block: $ => seq('[', optional($.markup), ']'),

    // A content block only counts as an argument when it is *immediately* adjacent to
    // what precedes it: `f[x]` is a call, `f [x]` is an identifier followed by a
    // separate content block. Aliased so both spellings surface as `content_block`.
    _content_block_immediate: $ => seq(
      token.immediate('['),
      optional($.markup),
      ']',
    ),

    // Typst wraps the contents of a content block in a `Markup` node, separate from the
    // brackets. It emits one even when empty (a zero-width node); tree-sitter does not
    // produce zero-width named nodes, and the span comparison ignores them.
    markup: $ => repeat1($._markup_expr),

    // A run of adjacent content-block arguments, written with explicit right recursion
    // rather than `repeat1`. tree-sitter compiles `repeat` into a separate generated
    // rule that does *not* inherit the enclosing `prec.right`, so the parser would
    // happily reduce after the first block and read `f[a][b]` as two nested calls.
    // Typst produces one call with both blocks in a single argument list.
    _content_blocks: $ => prec.right(seq(
      alias($._content_block_immediate, $.content_block),
      optional($._content_blocks),
    )),

    // ---- literals ---------------------------------------------------------

    _literal: $ => choice(
      $.none,
      $.auto,
      $.bool,
      // All three are lexed and validated by the scanner, which mirrors `Lexer::number`.
      // Three tokens rather than one keeps the node names in step with typst's `Int` /
      // `Float` / `Numeric` kinds.
      alias($._number_int, $.int),
      alias($._number_float, $.float),
      alias($._number_numeric, $.numeric),
      $.str,
    ),

    none: _ => 'none',
    auto: _ => 'auto',
    bool: _ => choice('true', 'false'),

    // No interpolation; `\` escapes the next character.
    // `[\s\S]` rather than `.` after the backslash: a string may be escaped across a line
    // break, and tree-sitter's `.` does not match one.
    str: _ => token(seq('"', repeat(choice(/[^"\\]/, /\\[\s\S]/)), '"')),

    // XID_Start plus `_` to begin; XID_Continue plus `_` and `-` to continue. The
    // trailing hyphen rule is why `my-var` is one identifier and `a - b` is subtraction.
    ident: _ => /[_\p{XID_Start}][-_\p{XID_Continue}]*/u,

    // ---- operators --------------------------------------------------------

    unary: $ => choice(
      prec.left(PREC.unary, seq(field('operator', choice('+', '-')), field('operand', $._value))),
      prec.left(PREC.not, seq(field('operator', 'not'), field('operand', $._value))),
    ),

    binary: $ => {
      const left = [
        [PREC.mul, choice('*', '/')],
        [PREC.add, choice('+', '-')],
        // `not in` is one token, not two. As `seq('not', 'in')` a bare `not` beginning a
        // fresh expression looks like the start of this operator, so
        //   1
        //   not b
        // commits to the binary reading and then fails. One token cannot be entered
        // without the `in` actually being there.
        [PREC.cmp, choice('==', '!=', '<', '<=', '>', '>=', 'in',
                          // Exactly one space: typst's lexer does `eat_if(" in")`, so a
                          // newline between the two words is an error, not an operator.
                          'not in')],
        [PREC.and, 'and'],
        [PREC.or, 'or'],
      ];
      const right = [
        [PREC.assign, choice('=', '+=', '-=', '*=', '/=')],
      ];
      return choice(
        ...left.map(([p, op]) => prec.left(p, seq(
          field('lhs', $._value), field('operator', op), field('rhs', $._value),
        ))),
        ...right.map(([p, op]) => prec.right(p, seq(
          field('lhs', $._value), field('operator', op), field('rhs', $._value),
        ))),
      );
    },

    // ---- access and calls -------------------------------------------------

    // Only a *value* can be the target of postfix `.field` or a call. Allowing any
    // expression here lets the parser read `let f` as a complete binding and then treat
    // it as the callee of `(a, b)`, which silently turns `let f(a, b) = ...` into
    // nonsense. Typst has the same split: statement forms come back from `code_primary`
    // and are not postfixed.
    _postfixable: $ => choice(
      $._literal,
      $.ident,
      $.code_block,
      $.content_block,
      $.parenthesized,
      $.array,
      $.dict,
      $.field_access,
      $.func_call,
      // Content literals are ordinary values in code mode: `query(<intro>)`,
      // `t(auto, `auto`)` and `f($x$)` are all valid.
      $.label,
      $.raw,
      $.equation,
      // A branch or loop is a value too, so `if a { b } else { c }.filter(f)` field-
      // accesses the whole conditional rather than just its else block — typst nests
      // `FieldAccess(Conditional, ...)`. Real code does this to a comprehension often
      // enough that six corpus files depend on it.
      $.conditional,
      $.while_loop,
      $.for_loop,
    ),

    field_access: $ => prec.left(PREC_ACCESS, seq(
      field('target', $._postfixable),
      '.',
      field('field', $.ident),
    )),

    // In markup a call's parentheses must follow the callee with no space — `#f(x)` is a
    // call, `#f (x)` is a variable followed by literal text. `token.immediate` expresses
    // exactly that.
    func_call: $ => prec.left(PREC_CALL, seq(
      field('item', $._postfixable),
      field('args', $.args),
    )),

    // Consecutive content blocks all belong to one `args`: `f[a][b]` is a single call
    // with two content arguments, not nested calls. `prec.left` makes the repeat greedy.
    args: $ => prec.right(PREC_ARGS, choice(
      seq(
        token.immediate('('),
        sepBy(',', choice($.named, $.spread, $._expr)),
        optional(','),
        ')',
        optional($._content_blocks),
      ),
      $._content_blocks,
    )),

    named: $ => seq(field('name', $.ident), ':', field('value', $._expr)),
    // A dictionary key may be any expression that computes to one — a string, something
    // parenthesized, or a call such as `(a.keys().first(): "")`. A bare identifier is
    // deliberately absent: `k: v` is a `named` argument, which typst keeps distinct.
    keyed: $ => seq(
      field('key', choice(
        $.str,
        $.parenthesized,
        $.func_call,
        $.field_access,
        $.array,
        $.dict,
      )),
      ':',
      field('value', $._expr),
    ),
    spread: $ => seq('..', optional($._expr)),

    // ---- parenthesized forms ---------------------------------------------
    //
    // `()` is an empty array, `(1)` is parenthesized, `(1,)` and `(1, 2)` are arrays,
    // and `(a: 1)` is a dictionary. Only the contents distinguish them.

    parenthesized: $ => seq('(', $._expr, ')'),

    // `()` is an empty array, so the contents are optional. A single element with no
    // trailing comma is `parenthesized` instead, which is why every non-empty branch
    // here requires either a trailing comma or a second element.
    array: $ => seq(
      '(',
      optional(choice(
        seq(sepBy1(',', choice($.spread, $._expr)), ','),
        seq($._expr, repeat1(seq(',', choice($.spread, $._expr))), optional(',')),
        seq($.spread, repeat(seq(',', choice($.spread, $._expr))), optional(',')),
      )),
      ')',
    ),

    /*
     * The leading `:` is a marker, not a shorthand for the empty dictionary. `(:)` is the
     * empty dict, but `(:..a, k: 1)` is a dict with items — typst emits `Colon` followed
     * by the items either way. Treating the colon as an alternative *to* the items is
     * what made `(:..base, ..overrides)` fail to parse.
     *
     * It is needed whenever nothing else marks the parens as a dictionary: with only
     * spreads inside, `(..a)` is an array.
     */
    dict: $ => seq(
      '(',
      choice(
        seq(':', optional(dictItems($))),
        dictItems($),
      ),
      ')',
    ),

    // ---- closures ---------------------------------------------------------

    // A single unparenthesized parameter still gets a `params` node in typst: `x => y`
    // produces `Closure(Params(Ident), Arrow, Ident)`, not a bare identifier.
    closure: $ => prec.right(seq(
      field('params', choice($.params, alias($._bare_param, $.params))),
      '=>',
      field('body', $._expr),
    )),

    // `_ => value` is a closure that ignores its argument.
    _bare_param: $ => choice($.ident, $.underscore),

    params: $ => seq(
      '(',
      sepBy(',', choice($.named, $.spread, $._pattern)),
      optional(','),
      ')',
    ),

    // ---- patterns ---------------------------------------------------------

    _pattern: $ => choice($.ident, $.underscore, $.destructuring),

    underscore: _ => '_',

    destructuring: $ => seq(
      '(',
      sepBy(',', choice(alias($._destructuring_named, $.named), $.spread, $._pattern)),
      optional(','),
      ')',
    ),

    // The value of a named entry in a destructuring pattern is itself a PATTERN, not an
    // expression: `let (drawables: _) = f()` discards that field, and `_` is not an
    // expression anywhere else.
    _destructuring_named: $ => seq(
      field('name', $.ident),
      ':',
      field('pattern', $._pattern),
    ),

    // `_ = f()` discards a result, and typst models it as a destructuring assignment
    // whose pattern is the placeholder.
    destruct_assignment: $ => prec.right(PREC.assign, seq(
      field('pattern', choice($.destructuring, $.underscore)),
      '=',
      field('value', $._expr),
    )),

    // ---- bindings and rules ----------------------------------------------

    let_binding: $ => prec.right(seq(
      'let',
      choice(
        // `let f(x) = ...` declares a function, and typst models that as a *closure*
        // named `f` sitting inside the binding — `LetBinding(Let, Closure(Ident, Params,
        // Eq, body))` — rather than as fields of the binding itself.
        //
        // The branch also outranks the plain-pattern one, so that on `let f • (` the
        // parser shifts the parameter list instead of reducing `f` to a complete pattern
        // and ending the binding there.
        alias($._let_closure, $.closure),
        seq(field('pattern', $._pattern), optional(seq('=', field('value', $._expr)))),
      ),
    )),

    _let_closure: $ => prec.dynamic(1, seq(
      field('name', $.ident),
      field('params', $.params),
      optional(seq('=', field('body', $._expr))),
    )),

    // The target of `set` is a dotted path, never a general expression: typst's
    // `set_rule` accepts `Ident ('.' Ident)*` and then parses the argument list itself.
    // Allowing a full expression here would let `text(size: 10pt)` be swallowed whole as
    // a `func_call`, leaving the set rule with no arguments.
    set_rule: $ => prec.right(seq(
      'set',
      field('target', choice($.ident, $.field_access)),
      field('args', $.args),
      optional(seq('if', field('condition', $._expr))),
    )),

    show_rule: $ => prec.right(seq(
      'show',
      optional(field('selector', $._expr)),
      ':',
      field('transform', $._expr),
    )),

    contextual: $ => prec.right(seq('context', field('body', $._expr))),

    // ---- control flow -----------------------------------------------------

    /*
     * The body of a branch or loop is a *block*, never a bare expression: typst rejects
     * `if a 1`, `while a 1` and `for x in y 1` outright. Accepting an expression there
     * was both too permissive and the reason `a * if c {1} else {2} + b` nested wrongly —
     * the else branch would swallow `{2} + b` as a binary, leaving the outer `+` inside
     * the conditional instead of applying to the whole product.
     */
    _block: $ => choice($.code_block, $.content_block),

    conditional: $ => prec.right(seq(
      'if',
      field('condition', $._expr),
      field('then', $._block),
      // `else if` chains, so the else branch takes another conditional as well as a block.
      optional(seq('else', field('else', choice($._block, $.conditional)))),
    )),

    while_loop: $ => prec.right(seq(
      'while',
      field('condition', $._expr),
      field('body', $._block),
    )),

    for_loop: $ => prec.right(seq(
      'for',
      field('pattern', $._pattern),
      'in',
      field('iterable', $._expr),
      field('body', $._block),
    )),

    loop_break: _ => 'break',
    loop_continue: _ => 'continue',
    func_return: $ => prec.right(seq('return', optional(field('value', $._expr)))),

    // ---- modules ----------------------------------------------------------

    module_import: $ => prec.right(seq(
      'import',
      field('source', $._expr),
      optional(seq('as', field('alias', $.ident))),
      optional(seq(':', field('items', choice(
        '*',
        $.import_items,
        // Parenthesized lists let an import span several lines. The parentheses are
        // siblings of `import_items` rather than wrapping it, matching typst.
        seq('(', optional($.import_items), ')'),
      )))),
    )),

    // The trailing comma belongs *inside* the item list: typst ends `ImportItems` after
    // it and leaves only the closing paren outside.
    import_items: $ => seq(
      sepBy1(',', choice($.import_item_path, $.renamed_import_item)),
      optional(','),
    ),

    import_item_path: $ => sepBy1('.', $.ident),

    renamed_import_item: $ => seq(
      field('path', $.import_item_path),
      'as',
      field('new_name', $.ident),
    ),

    module_include: $ => prec.right(seq('include', field('source', $._expr))),

    // -----------------------------------------------------------------------
    // trivia
    // -----------------------------------------------------------------------

    line_comment: _ => token(seq('//', /[^\r\n]*/)),

    // Typst's block comments nest — `/* /* */ */` is a single comment, and the first
    // `*/` does not end it. Nesting is not a regular language, so the scanner counts
    // the depth. See `Lexer::block_comment`.
    block_comment: $ => $._block_comment,
  },
});

/** One or more `rule`, separated by `sep`. */
function sepBy1(sep, rule) {
  return seq(rule, repeat(seq(sep, rule)));
}

/** Zero or more `rule`, separated by `sep`. */
function sepBy(sep, rule) {
  return optional(sepBy1(sep, rule));
}

/**
 * The markup alternatives, with the pieces that some contexts exclude made optional.
 *
 * Typst expresses these exclusions as a "stop set" passed to its `markup` parser — a
 * heading's body stops at a `Label`, for instance. Generating the choice lets us say the
 * same thing once instead of maintaining two nearly identical lists.
 */
function markupExpr($, { label, strong = true, emph = true }) {
  return choice(
    $.text,
    $.escape,
    $.linebreak,
    $.shorthand,
    $.smart_quote,
    // Dropped from a delimiter's own body — see `strong` and `emph`.
    ...(strong ? [$.strong] : []),
    ...(emph ? [$.emph] : []),
    $.raw,
    $.link,
    ...(label ? [$.label] : []),
    $.ref,
    $.heading,
    $.list_item,
    $.enum_item,
    $.term_item,
    $.equation,
    $._hash_expr,
    $._bracket_text,
    // A bare colon is plain text; `term_item` claims it as a separator where one fits.
    alias(':', $.text),
  );
}

/**
 * The math alternatives, with the infix operators made optional.
 *
 * Typst drives this with precedence: an attachment parses its operands at a level that
 * excludes further attachments, then chains any following `^`/`_` into the same node.
 * Dropping the operators from the operand rule expresses the same thing, which is what
 * keeps `x_i^2` one flat attachment carrying both scripts.
 */
function mathExpr($, { operators }) {
  return choice(
    mathText($),
    $.math_ident,
    $.math_field_access,
    $.math_shorthand,
    $.math_align_point,
    $.math_primes,
    $.math_primes_marker,
    $.math_delimited,
    alias($.math_implicit_call, $.math),
    $.math_root,
    $.math_call,
    $.str,
    $.escape,
    $.linebreak,
    $._hash_expr,
    ...(operators ? [$.math_attach, $.math_frac] : []),
    // Typst lexes these as punctuation or as the start of a shorthand, then falls
    // through to math text when no shorthand matched. `=`, `+`, `<`, `>` and `|` are
    // ordinary symbols in math; only multi-character forms like `<=` or `|->` are
    // shorthands, and longest-match already prefers those.
    // A closing delimiter with no opener is a symbol, not a syntax error: `lr(}, ..)`
    // passes a brace as an argument. Typst converts these back to math text too.
    alias(choice('.', ',', ';', '!', '=', '+', '<', '>', ':'), $.math_text),

    // An unmatched delimiter is a symbol, not an error: `$<($` and `$=)$` are both valid
    // Typst, because `math_delimited` falls back to a plain sequence when it finds no
    // closer and a lone closer is converted to math text.
    //
    // The precedence has to be DYNAMIC rather than static. Both readings are complete
    // parses of the same tokens, so the choice happens at runtime; a static `prec(-1)`
    // resolves conflicts at generation time instead and cost validity both times it was
    // tried here.
    alias(prec.dynamic(-20, choice(MATH_OPEN, MATH_CLOSE)), $.math_text),
  );
}

/**
 * The items of a dictionary literal.
 *
 * A plain function rather than a grammar rule so that it inlines at both use sites: a
 * real rule would introduce a fresh `array`/`dict` ambiguity for the conflict list to
 * carry, when the ambiguity is already declared against `dict` itself.
 */
function dictItems($) {
  return seq(sepBy1(',', choice($.named, $.keyed, $.spread)), optional(','));
}

/**
 * A single math grapheme, as one node named `math_text`.
 *
 * A function rather than a rule so the two underlying tokens — letter and non-letter —
 * inline at every use site. They are split only so the implicit-call rule can require a
 * letter on its left; everywhere else the distinction does not exist.
 */
function mathText($) {
  return choice(alias($._math_letter, $.math_text), alias($._math_other, $.math_text));
}
