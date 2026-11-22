/**
 * @file Tree-sitter grammar for the Typst markup language
 * @license MIT
 *
 * The public tree supplies the nodes and fields read by typst-ts-mode.
 * Typst's parser supplies the syntax and operator precedence.
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

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6];

// Postfix access binds tighter than any operator. argument lists outrank calls so that a
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

// Opening and closing classes from typst-syntax's Lexer::math and
// typst_utils::default_math_class (including its overrides for ⎰⎱ and ⟅⟆).
const MATH_OPEN = choice('(', '[', '{', token(prec(1, /[⌈⌊⌜⌞⎰❲⟅⟦⟨⟪⟬⟮⦃⦅⦇⦉⦋⦍⦏⦑⦓⦕⦗⧘⧚⧼]/u)));
const UNICODE_MATH_CLOSE = /[⌉⌋⌝⌟⎱❳⟆⟧⟩⟫⟭⟯⦄⦆⦈⦊⦌⦎⦐⦒⦔⦖⦘⧙⧛⧽]/u;
const MATH_CLOSE = choice(')', ']', '}', token(prec(1, UNICODE_MATH_CLOSE)));

module.exports = grammar({
  name: 'typst',

  inline: $ => [$._math_open, $._math_close],

  extras: $ => [
    /[ \t\v\f]/,
    $._newline,
    // Non-ASCII whitespace is trivia in code and math but *content* in markup, where
    // typst gives a character like U+3000 its own one-character `Text` node. Only the
    // scanner can tell the two apart, so this is an external token rather than a regex.
    $._non_ascii_space,
    $.comment,
  ],

  // Tokens the external scanner owns, because each needs either lookahead or knowledge
  // of the preceding character — neither of which a tree-sitter regex can express.
  // Order must match `enum TokenType` in src/scanner.c.
  externals: $ => [
    $.text,             // the stop table plus its continuation rules
    $.shorthand,        // `~ ... --- -- -?`, and `-` before a digit
    $._star,            // `*` only outside a word
    $._underscore,      // `_` only outside a word
    ...HEADING_LEVELS.map(n => $['_head' + n]), // `=`+ at line start, followed by a space
    $.list_marker,      // `-` at line start, followed by a space
    $.enum_marker,      // `+` or `1.` at line start, followed by a space
    $.term_marker,      // `/` at line start, followed by a space
    $._raw_inline, $._raw_fence, // a backtick fence; the closer must match the opener's count
    $.raw_lang,         // the language tag of a fenced block, for injections
    $.raw_content,      // everything between the fences, whitespace included
    $._atomic_end,      // an embedded value ends unless `.`, `(` or `[` follows
    $._stmt_end,        // an embedded statement ends at the newline
    $._bare_return,     // zero-width: `return` has no value before its terminator
    $._not_in,          // `not` only if `in` follows after trivia
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
    $._block_comment_body, // `/* ... */`, which nests
    $._math_dot,        // the `.` of a math field access: a name must follow it
    $._math_adjacent,   // zero-width: a delimiter follows immediately, so it is a call
    $._math_bang,       // zero-width: a `!` follows immediately, so it is a factorial
    // The same markers at the start of a fresh markup context, including item bodies.
    ...HEADING_LEVELS.map(n => $['_start_head' + n]),
    $._list_marker_start,
    $._enum_marker_start,
    $._term_marker_start,
    $.escape,          // `\x`, or `\u{...}` with a codepoint that is a real character
    $.linebreak,       // `\` at the end of a line
    $._adjacent_prime,  // zero-width: a `'` follows immediately, so it attaches
    $.url,             // a bare URL, with `[]` and `()` balanced
    $._math_named_ident,
    $._math_spread_dots,
    $._math_name_head,  // first grapheme of a longer named argument
    $._math_alpha_cluster,
    $._math_other_cluster,
    $.shebang,
    $._document_start,
    $._let_name_ahead,  // the binding name touches an opening parenthesis
    $._non_ascii_space, // whitespace outside markup, where typst skips it as trivia
    $._math_adjacent_brace, // implicit call after an identifier; ( starts explicit arguments
    $._math_symbol_end, // commit an identifier before trivia can separate it from a call
    $._after_line_comments, // replay leading comment extras with fresh markup context
    $._text_before_scheme,
    $._heading_more, $._heading_stop, $._item_more, $._item_stop,
    $._newline,         // code can reject a line break before another required operand
    $._code_continues,  // a field or else branch continues a code-block expression

    $._block_ahead,     // the condition is followed by its block on this line
    $._same_line,
    $._bare_let,
    $._args_paren, $._args_bracket,
    $._ref_end,         // finish before a separated supplement
    $._detached_args,
    $._hash,            // the next character must begin code without intervening trivia
    ...HEADING_LEVELS.map(n => $['_before_heading' + n]),
    $._section_newline,   // include the trailing line break in a section edit
    $._error_sentinel,  // never matched; signals error recovery to the scanner
  ],

  // Lets keyword tokens win over `ident` without a separate lexical state. Because `-`
  // is an identifier-continue character in Typst, `not-x` correctly lexes as the single
  // identifier `not-x` rather than `not` applied to `-x`.
  word: $ => $.ident,
  reserved: {
    global: $ => [
      $.none, $.auto, 'true', 'false', 'not', 'and', 'or', 'let', 'set', 'show', 'context',
      'if', 'else', 'for', 'in', 'while', 'break', 'continue', 'return', 'import', 'include', 'as',
    ],
    field: _ => [],
  },

  // A `(` in code mode is genuinely ambiguous until its contents have been read: it may
  // open a parenthesized expression, an array, a dictionary, a closure's parameter list,
  // or a destructuring pattern, and nothing before the matching `)` distinguishes them.
  // Typst's own parser resolves this by backtracking; the GLR parser explores the
  // alternatives in parallel instead. Every entry below is one of those genuine
  // ambiguities, not a workaround for a badly factored rule.
  conflicts: $ => [
    // The comma, colon, equals sign, or closure arrow following a group
    // resolves the overlap between collections, parameters, and patterns.
    [$.array, $.dict],
    [$.array, $._empty_destructuring],
    [$.dict, $.params],
    [$.params, $.destructuring],
    [$._postfixable, $._pattern],
    [$._postfixable, $._assign_pattern],
    [$._parenthesized_pattern, $._assign_pattern],
    [$.destructuring, $._assign_pattern],
    [$._assign_pattern, $._destructuring_named],
    [$.params, $._parenthesized_pattern, $._assign_pattern],
    [$.params, $.destructuring, $._assign_pattern],
    [$.params, $._assign_pattern],
    [$._postfixable, $._reassignment_sink],
    [$._postfixable, $._sink, $._reassignment_sink],
    [$._sink, $._reassignment_sink],
    [$._postfixable, $._sink],

    // A control expression can itself be the target of a field access or call.
    [$._hash_value, $._line_postfixable],
    [$._value, $._postfixable],
    [$._line_value, $._line_postfixable],
    [$._block_value, $._block_postfixable],
    [$._postfixable, $._set_target],
    [$._line_postfixable, $._line_set_target],
    [$._block_postfixable, $._block_set_target],

    [$.import_items],
    [$.import_items, $.as],

    // Round parentheses in an operand can be unwrapped by math_unparen.
    [$.math_delimited, $._math_group],

  ],

  rules: withCodeModes({
    // -----------------------------------------------------------------------
    // markup
    // -----------------------------------------------------------------------
    //
    // Most markup tokens come from the external scanner, which reproduces typst's
    // `Lexer::markup` — see src/scanner.c for why they cannot be regexes.

    source_file: $ => seq(choice($.shebang, $._document_start), optional($._block_markup)),

    _plain_markup_expr: $ => markupExpr($, { label: true }),
    _markup_expr: $ => choice(
      $._plain_markup_expr,
      seq($._after_line_comments, choice($._block_first, $._plain_markup_expr)),
    ),

    // A heading's body stops at a label, so in `= Real <real>` the label is a sibling of
    // the heading rather than part of it. Typst spells this as a stop set on the
    // heading's markup: `syntax_set!(Label, RightBracket, End)`.
    _markup_expr_unlabelled: $ => markupExpr($, { label: false, bracket: $._heading_bracket }),
    _term_markup: $ => repeat1(markupExpr($, { label: true, colon: false, bracket: $._heading_bracket })),
    _markup_unlabelled: $ => repeat1($._markup_expr_unlabelled),

    // Brackets are ordinary text in markup — `a [b] c` is five text nodes, not a content
    // block. Typst's `markup_expr` tracks a nesting counter and converts both brackets to
    // `Text`; modelling the balance in the grammar has the same effect, and leaves an
    // *unbalanced* `]` free to close an enclosing content block.
    _bracket_text: $ => seq(
      alias('[', $.text),
      repeat($._markup_expr),
      alias(']', $.text),
    ),

    // Typst does not decide opening versus closing here; that is a rendering concern.
    quote: _ => choice('\'', '"'),

    // The mode uses the fence's lang field and blob span for indirect editing.
    _raw: $ => choice($.raw_span, $.raw_blck),
    raw_span: $ => seq(alias($._raw_inline, '`'), optional(alias($.raw_content, $.blob)), alias($._raw_inline, '`')),
    raw_blck: $ => seq(alias($._raw_fence, '```'), optional(field('lang', alias($.raw_lang, $.ident))),
      optional(alias($.raw_content, $.blob)), alias($._raw_fence, '```')),

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
    strong: $ => seq(alias($._star, '*'), optional($._markup_no_strong), alias($._star, '*')),
    emph: $ => seq(alias($._underscore, '_'), optional($._markup_no_emph), alias($._underscore, '_')),

    _markup_no_strong: $ => repeat1(markupExpr($, { label: true, strong: false })),
    _markup_no_emph: $ => repeat1(markupExpr($, { label: true, emph: false })),

    // `<name>` — identifier characters plus `:` and `.`.
    label: _ => token(seq('<', /[_\-:.\p{XID_Continue}]+/u, '>')),

    // `@name` or `@name[supplement]`. The marker excludes a trailing `.` or `:` so that
    // `see @thm.` ends the reference before the sentence's full stop.
    ref: $ => seq(
      $.ref_marker,
      choice(alias($._content_block_immediate, $.content), $._ref_end),
    ),
    ref_marker: _ => token(seq(
      '@',
      /[_\-\p{XID_Continue}]/u,
      optional(/[_\-:.\p{XID_Continue}]*[_\-\p{XID_Continue}]/u),
    )),


    // Each of these ends at the end of its line; `_line_end` is a zero-width token the
    // scanner emits when the body is over.
    ...headingRules(),
    _list_item: $ => seq(alias($.list_marker, '-'), optional($._item_markup), $._line_end),
    _enum_item: $ => seq($.enum_marker, optional($._item_markup), $._line_end),
    term: $ => seq(
      alias($.term_marker, '/'),
      field('term', optional($._term_markup)),
      ':',
      field('description', optional($._item_markup)),
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

    math: $ => seq(
      '$', optional(choice($.formula, alias($._math_unclosed_sequence, $.formula))), '$',
    ),

    _math_unclosed_sequence: $ => seq(repeat($._math_expr), $._math_unclosed_expr),

    formula: $ => repeat1($._math_expr),

    _math_expr: $ => mathExpr($, { operators: true }),

    // What an attachment may take as base or script. Excluding the operators is what
    // keeps `x_i^2` a single flat attachment with both scripts, as typst produces,
    // rather than a subscript whose script is itself a superscript.
    _math_operand: $ => mathExpr($, { operators: false }),

    // A run of two or more characters names a symbol (`sum`, `alpha`); a single
    // character is a variable. That is why `$sum$` is the summation sign but `$s u m$`
    // is three variables. Note there is no `_` here — unlike code identifiers, since `_`
    // is the subscript operator in math.
    _math_ident: _ => token(new RustRegex(String.raw`\p{XID_Start}[\p{XID_Continue}&&[^_]]+`)),

    /*
     * A single grapheme, or a number kept whole.
     *
     * Split math text so a letter can begin an implicit call. Typst wraps
     * `$f(x)$` in an extra `Math` node but leaves `$2(x)$` and `$+(x)$` alone. The two
     * halves match disjoint character sets, so the lexer is never choosing between two
     * tokens for the same text — the trap that sinks `token.immediate` here. Both are
     * exposed as letter or symbol for the mode's math highlighting.
     */
    _math_letter: _ => token(/\p{Alphabetic}/u),
    _math_other: _ => token(choice(
      /\p{N}+(\.\p{N}+)?/u,
      /[^\s\\"\-:!.,;#_$/^&'()\[\]{}|<>=~*+\p{Alphabetic}]/u,
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
    _math_field: $ => prec.left(seq(
      choice(alias($._math_ident, $.ident), alias($._math_field, $.field)),
      alias($._math_dot, '.'),
      field('field', alias(token.immediate(new RustRegex(String.raw`\p{XID_Start}[\p{XID_Continue}&&[^_]]*`)), $.ident)),
    )),

    // `sum(x)` — a call needs the parenthesis directly adjacent, like in code.
    _math_call: $ => prec.left(PREC_MATH.func, seq(
      field('item', choice(alias($._math_ident, $.ident), alias($._math_field, $.field))),
      field('args', alias($._math_args, $.group)),
    )),
    // Math arguments are comma- or semicolon-separated, and each one may be named
    // (`lr(}, size: #h)`) or spread. Only multi-expression arguments need a Math wrapper.
    _math_args: $ => seq(
      token.immediate('('),
      sepBy(choice(',', ';'), optional($._math_arg)),
      ')',
    ),

    _math_arg: $ => choice(
      alias($._math_named_arg, $.tagged),
      alias($._math_spread_arg, $.spread),
      $._math_arg_value,
    ),

    // typst-syntax's math_arg stops at a comma, semicolon or right parenthesis.
    // Nested delimited groups still use ordinary math, including its punctuation.
    _math_arg_value: $ => choice(prec(1, $._math_arg_expr), alias($._math_arg_body, $.formula)),
    _math_arg_body: $ => prec.left(seq($._math_arg_expr, repeat1($._math_arg_expr))),
    _math_arg_expr: $ => mathExpr($, { operators: true, inArgs: true }),

    // The name is a code identifier rather than a math one — typst lexes it with
    // `maybe_math_named_arg`, which is why `size` here is not a math symbol.
    // The name is aliased rather than parsed as a code `ident`: in math the lexer has
    // already produced a math token for `size`, and a second token cannot be chosen for
    // the same characters. The scanner emits this token only when the following colon
    // proves that the run is a name, keeping ordinary math identifiers out of this path.
    // Typst reports the node as `Ident`, so that is what we call it.
    math_named_ident: $ => choice($._math_named_ident,
      seq($._math_name_head, token.immediate(/[-_\p{XID_Continue}]+/u))),
    _math_named_arg: $ => prec.dynamic(2, seq(
      field('field', alias($.math_named_ident, $.ident)),
      ':',
      $._math_arg_value,
    )),
    _math_spread_arg: $ => seq(alias($._math_spread_dots, '..'), $._math_arg_value),

    // typst-syntax's math_delimited accepts the first closer, even across shapes: [(x]}.
    math_delimited: $ => seq(
      $._math_open,
      optional($.formula),
      $._math_close,
    ),

    _math_open: $ => choice(alias(MATH_OPEN, $.symbol), alias('[|', $.math_shorthand)),
    _math_close: $ => choice(alias(MATH_CLOSE, $.symbol), alias(token(prec(1, '|]')), $.math_shorthand)),

    // typst-syntax's math_delimited wraps the opener and its expressions together
    // in Math when it reaches the end of the equation before a closer.
    _math_unclosed: $ => seq($._math_open, repeat($._math_expr), optional($._math_unclosed_expr)),

    // Only the final expression in an equation can contain an unmatched opener.
    // Thread it through the right operand of an operator so trailing operators
    // stay inside the group (including the ! in $a[+!$).
    _math_unclosed_expr: $ => choice(
      $._math_unclosed_operand,
      alias($._math_unclosed_attach, $.attach),
      alias($._math_unclosed_frac, $.fraction),
    ),
    _math_unclosed_operand: $ => choice(
      alias($._math_unclosed, $.formula),
      alias($._math_unclosed_implicit_call, $.formula),
      alias($._math_unclosed_root, $.math_root),
    ),

    _math_unclosed_implicit_call: $ => mathImplicitCall($, alias($._math_unclosed, $.formula)),
    _math_unclosed_root: $ => mathRoot(choice(
      $._math_unclosed_operand, alias($._math_unclosed_attach, $.attach),
    )),
    _math_unclosed_frac: $ => mathFrac($, $._math_unclosed_expr),

    _math_unclosed_attach: $ => mathUnclosedAttach($, choice(
      $._math_unclosed_sub_scripts, $._math_unclosed_sup_scripts,
    )),
    _math_unclosed_sub_scripts: $ => choice(
      $._math_unclosed_sub, seq($._math_sub, mathScript('^', $._math_unclosed_last)),
    ),
    _math_unclosed_sup_scripts: $ => choice(
      $._math_unclosed_sup, seq($._math_sup, mathScript('_', $._math_unclosed_last)),
    ),
    _math_unclosed_last: $ => choice(
      $._math_unclosed_operand, alias($._math_unclosed_attach, $.attach),
    ),
    _math_unclosed_sub: $ => mathScript('_', choice(
      $._math_unclosed_operand, alias($._math_unclosed_sub_rebased, $.attach),
    )),
    _math_unclosed_sup: $ => mathScript('^', choice(
      $._math_unclosed_operand, alias($._math_unclosed_sup_rebased, $.attach),
    )),
    _math_unclosed_sub_rebased: $ => mathUnclosedAttach($, $._math_unclosed_sub_scripts),
    _math_unclosed_sup_rebased: $ => mathUnclosedAttach($, $._math_unclosed_sup_scripts),

    // `x^2`, `x_i`, `x_i^2`. Right-associative, and `^` and `_` chain into a single
    // attachment so `x_i^2` is one node with both a subscript and a superscript.
    /*
     * `x^2`, `x_i`, `x_i^2`, and primes. Right-associative, and `^` and `_` chain into a
     * single attachment so `x_i^2` is one node carrying both scripts.
     *
     * Primes belong here rather than in a rule of their own: typst wraps `c'` in a
     * `MathAttach` whose child is a `MathPrimes`, and folds primes and scripts into the
     * *same* attachment, so `c'_1` is one node with three children rather than an attach
     * nested inside another. They take no right operand, and attach only when directly
     * adjacent — `a'` attaches while `a '` is `a` followed by a standalone prime. That
     * adjacency is a zero-width scanner token rather than `token.immediate`, which would
     * need a second token for `'`; with both valid the lexer picks whichever it likes,
     * and the immediate one never matches.
     */
    attach: $ => prec.left(PREC_MATH.attach, seq(
      field('base', $._math_operand),
      choice(
        seq($._adjacent_prime, $.math_primes, optional($._math_scripts)),
        $._math_scripts,
      ),
    )),

    /*
     * At most one subscript and one superscript, in either order.
     *
     * That limit is what shapes a chain: `$a_b'^c'^d'$` puts `_b'` and `^c'` on the same
     * attachment, and the *second* `^` cannot join it, so it re-bases onto `c'` instead.
     * math_expr_prec consumes the other script before returning. Shifting here keeps
     * the subscript in a^b'^c_d on the inner primed base.
     * With an unbounded repeat every script flattened into the outermost node.
     */
    _math_scripts: $ => prec.right(PREC_MATH.attach, choice(
      seq($._math_sub, optional($._math_sup_last)),
      seq($._math_sup, optional($._math_sub_last)),
    )),

    /*
     * The second script's operand may re-base a script of *either* kind, because by then
     * the enclosing attachment holds one of each and has no room left: `$l_0^e_a$` nests
     * the trailing `_a` onto `e`. The first script's operand re-bases only a repeat of
     * its own kind, since the enclosing node can still take the other one.
     */
    _math_sub_last: $ => seq(field('operator', '_'), field('attachment', choice(
      alias($._math_group, $.formula),
      alias($._math_primed, $.attach),
      alias($._math_any_rebased, $.attach),
      $._math_operand,
    ))),

    _math_sup_last: $ => seq(field('operator', '^'), field('attachment', choice(
      alias($._math_group, $.formula),
      alias($._math_primed, $.attach),
      alias($._math_any_rebased, $.attach),
      $._math_operand,
    ))),

    _math_any_rebased: $ => prec.left(PREC_MATH.attach,
      seq(field('base', $._math_operand), $._math_scripts)),

    /*
     * A script's operand re-bases when the *same* kind of script follows it, because the
     * enclosing attachment already holds one and has no room for another: `$2^2^x$` nests
     * rightwards. A script of the other kind does not re-base — the enclosing node can
     * still hold it, so `$a_b^c$` stays a single attachment carrying both.
     *
     * Spelling that out per kind is what makes it exact. Allowing any attachment as an
     * operand instead left the two readings genuinely ambiguous, and no precedence
     * separated them.
     */
    _math_sub: $ => seq(field('operator', '_'), field('attachment', choice(
      alias($._math_group, $.formula),
      alias($._math_primed, $.attach),
      alias($._math_sub_rebased, $.attach),
      $._math_operand,
    ))),

    _math_sup: $ => seq(field('operator', '^'), field('attachment', choice(
      alias($._math_group, $.formula),
      alias($._math_primed, $.attach),
      alias($._math_sup_rebased, $.attach),
      $._math_operand,
    ))),

    _math_sub_rebased: $ => prec.left(PREC_MATH.attach,
      seq(field('base', $._math_operand), $._math_sub)),
    _math_sup_rebased: $ => prec.left(PREC_MATH.attach,
      seq(field('base', $._math_operand), $._math_sup)),

    // Complete the primed base before an adjacent factorial wraps it.
    _math_primed: $ => prec.left(PREC_MATH.attach + 1, seq(
      field('base', $._math_operand), $._adjacent_prime, $.math_primes,
      optional($._math_scripts),
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
    _math_group: $ => prec.dynamic(5, seq('(', optional($.formula), ')')),

    // math_op wraps adjacent factorials in Math, including digit operands ($2!$).
    fac: $ => prec.left(PREC_MATH.attach, seq(
      field('base', choice($._math_operand, alias($._math_primed, $.attach))),
      $._math_bang,
      '!',
    )),

    // math_expr_prec wraps the continuable token and its adjacent group together.
    // The scanner checks adjacency before skipping any whitespace.
    math_implicit_call: $ => mathImplicitCall($, $.math_delimited),

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
    // The `'` run itself, which typst calls `MathPrimes`. The node that *wraps* a base
    // with its primes is `math_attach`, not this — see the attachment rule above.
    math_primes: _ => token(/'+/),

    // Both slots group round parens, the same way a script slot does — see `_math_group`.
    fraction: $ => mathFrac($, choice(alias($._math_group, $.formula), $._math_expr)),
    math_root: $ => mathRoot(choice(alias($._math_group, $.formula), $.attach, $._math_operand)),

    align: _ => '&',

    // The full shorthand set from typst's math lexer, longest first so that `<==>` is
    // not read as `<=` followed by `=>`.
    math_shorthand: _ => token(choice(
      '<==>', '<-->', '<--', '<-<', '<->', '<<-', '<<<', '<=>', '<==', '<~~',
      '>->', '>>>', '==>', '|->', '|=>', '~~>', '::=', '-->', '->>', '...',
      '<=', '<<', '<-', '<~', '>=', '>>', '=>', '=:', ':=', '!=', '||', '~>',
      '->', '*', '-', '~',
    )),

    // The code node records where embedded code begins and markup or math resumes.
    // Values and statements use different terminators (see the scanner).
    code: $ => choice(
      // A directly adjacent `;` ends the expression, exactly as it does for a statement:
      // typst reads `a#f;b` as three markup children with the semicolon its own token,
      // while `a #f ;b` — with a space — leaves `;b` as ordinary text.
      seq(alias($._hash, '#'), $._line_postfixable, choice(';', $._atomic_end)),
      seq(alias($._hash, '#'), $._hash_value, choice(';', $._atomic_end)),
      seq(alias($._hash, '#'), $._hash_statement, choice(';', $._stmt_end)),
    ),

    /*
     * Only these six are statements in Typst — `set::STMT` is exactly
     * `{Let, Set, Show, Import, Include, Return}`. A statement must be followed by a
     * semicolon or a line break, which is what `_stmt_end` enforces.
     */
    _hash_statement: $ => choice(
      alias($._line_let, $.let),
      alias($._line_set, $.set),
      alias($._line_show, $.show),
      alias($._line_import, $.import),
      alias($._line_include, $.include),
      alias($._line_return, $.return),
    ),

    /*
     * `context`, `if`, `while` and `for` are NOT statements, despite reading like them.
     * They end as soon as their body does, and markup may resume immediately on the same
     * line: `#context counter(page).display() of #context ...` is ordinary Typst.
     */
    _atomic_context: $ => seq('context', $._same_line,
      field('body', choice($._line_postfixable, $._hash_value, $._hash_statement))),
    _hash_value: $ => choice(
      alias($._atomic_context, $.context),
      alias($._line_branch, $.branch),
      alias($._line_while, $.while),
      alias($._line_for, $.for),
      $.flow,
    ),


    // -----------------------------------------------------------------------
    // code
    // -----------------------------------------------------------------------

    // Split in two so the postfixable subset is named exactly once. Listing the same
    // alternatives in both `_expr` and `_postfixable` would make every `ident` ambiguous
    // between the two wrappers.
    _expr: ($, code) => choice(code._value, code._statement_expr),

    /**
     * Expressions that may be an operand.
     *
     * Statement forms are excluded, and that matters: with `let_binding` available as an
     * operand, `let f(x) = { ... }` parsed as `(let f(x)) = { ... }` — a binary
     * assignment whose left side was the binding — instead of attaching the block as the
     * function's body. Conditionals and loops stay, because they really do produce
     * values: `let x = if c { 1 } else { 2 }` is ordinary Typst.
     */
    _value: ($, code) => choice(
      code._finished_value,
      code._unary,
      code._binary,
      code.closure,
      code.context,
      code.branch,
      code.while,
      code.for,
    ),

    _statement_expr: ($, code) => choice(
      code.let,
      code.set,
      code.show,
      code.import,
      code.include,
      code.return,
      // `destructuring` is deliberately absent: typst only ever produces it as the
      // left side of a destructuring assignment or as a `let` pattern, never as a
      // standalone expression. Listing it here made every `(a: 1)` ambiguous with a
      // dictionary, and the parser resolved it the wrong way.
      code.destruct_assignment,
    ),

    block: $ => seq('{', optional($._block_code), '}'),

    // Keep expressions directly under block for indentation in the major mode.
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
    _block_code: $ => repeat1(seq($._block_expr, choice(';', alias($._code_sep, 'sep')))),

    /*
     * A content block starts a fresh markup context, so its first character counts as the
     * start of a line: typst reads `f([= H])` as a Heading, not as text. The markers are
     * gated on column elsewhere, and no column test can see that — but the *grammar* knows
     * exactly where a block begins, so the scanner is offered a separate set of marker
     * tokens that are only valid in that one position and ignore the column entirely.
     */
    content: $ => seq('[', optional($._block_markup), ']'),

    _block_markup: $ => seq(choice($._first_section, $._comment_section, $._first_item, $._document_expr),
      repeat(choice($._section, $._document_expr, $._comment_section))),
    _document_expr: $ => choice($._document_leaf, seq($._after_line_comments,
      choice($._first_item, $._document_leaf))),
    _document_leaf: $ => markupExpr($, { label: true, heading: false }),

    // In restricted markup, only a possible marker causes a comment replay.
    // A digit or hyphen can still be ordinary text or shorthand after lookahead.
    _commented_marker: $ => seq($._after_line_comments, choice($._block_first, $._markup_text, $.shorthand)),

    // With only one mark_end, the scanner must keep the boundary before a
    // possible link until it has read both slashes. Rejoin the scheme word
    // with its prefix when the lookahead finds an ordinary markup colon.
    _markup_text: $ => choice($.text, alias($._text_with_scheme, $.text)),
    _text_with_scheme: $ => seq($._text_before_scheme, token.immediate(/https?/)),

    // Keep any leading comment outside the extent of the first body expression.
    _item_markup: $ => seq(optional($._after_line_comments), $._item_body),
    _item_plain: $ => markupExpr($, { label: true, bracket: $._item_bracket }),
    _item_body: $ => seq(choice($._block_first, $._item_plain),
      repeat(choice($._item_plain, seq($._after_line_comments, choice($._block_first, $._item_plain))))),

    _heading_bracket: $ => scopedBracket($, $._heading_bracket, $._heading_more, $._heading_stop),
    _item_bracket: $ => scopedBracket($, $._item_bracket, $._item_more, $._item_stop),

    /*
     * The item forms again, for the one position where a marker needs no column. Each
     * mirrors its ordinary counterpart exactly; only the marker token differs, and every
     * node is aliased back to the usual name so the tree is indistinguishable.
     *
     * Real rules rather than inline sequences: `alias` renames a rule, it does not wrap
     * one — aliasing a bare `seq` yields an empty node with the children hoisted beside
     * it, which is what happened first time round.
     */
    _block_first: $ => choice($._first_heading, $._first_item),
    _first_item: $ => choice(
      alias($._block_list_item, $.item),
      alias($._block_enum_item, $.item),
      alias($._block_term_item, $.term),
    ),

    _block_list_item: $ => seq(
      alias($._list_marker_start, '-'), optional($._item_markup), $._line_end,
    ),

    _block_enum_item: $ => seq(
      alias($._enum_marker_start, $.enum_marker), optional($._item_markup), $._line_end,
    ),

    _block_term_item: $ => seq(
      alias($._term_marker_start, '/'),
      field("term", optional($._term_markup)),
      ":",
      field("description", optional($._item_markup)),
      $._line_end,
    ),

    // A content block only counts as an argument when it is *immediately* adjacent to
    // what precedes it: `f[x]` is a call, `f [x]` is an identifier followed by a
    // separate content block. Aliased so both spellings surface as `content`.
    _content_block_immediate: $ => seq(
      $._args_bracket, token.immediate('['),
      // The same fresh-context markup as `content`: `#f[= B]` is a heading too.
      optional($._block_markup),
      ']',
    ),

    // Typst wraps the contents of a content block in a `Markup` node, separate from the
    // brackets. It emits one even when empty (a zero-width node); tree-sitter does not
    // produce zero-width named nodes, and the span comparison ignores them.

    // A run of adjacent content-block arguments, written with explicit right recursion
    // rather than `repeat1`. tree-sitter compiles `repeat` into a separate generated
    // rule that does *not* inherit the enclosing `prec.right`, so the parser would
    // happily reduce after the first block and read `f[a][b]` as two nested calls.
    // Typst produces one call with both blocks in a single argument list.
    _content_blocks: $ => prec.right(seq(
      alias($._content_block_immediate, $.content),
      optional($._content_blocks),
    )),

    // ---- literals ---------------------------------------------------------

    _literal: $ => choice(
      $.none,
      $.auto,
      $.bool,
      // Keep lexical validation of all three numeric forms and expose the mode's number node.
      alias($._number_int, $.number),
      alias($._number_float, $.number),
      alias($._quantity, $.number),
      $.string,
    ),

    none: _ => 'none',
    auto: _ => 'auto',
    bool: _ => choice('true', 'false'),

    // The grid commands distinguish a column count from a length by its unit child.
    _quantity: $ => seq($._number_numeric, $.unit),
    unit: _ => token.immediate(/[a-z]+|%/),

    // No interpolation; `\` escapes the next character.
    // `[\s\S]` rather than `.` after the backslash: a string may be escaped across a line
    // break, and tree-sitter's `.` does not match one.
    // The mode follows a local path by asking for the parent of the token at
    // point. Lex the whole literal atomically so comment-looking text stays inside.
    string: $ => alias($._string_literal, 'string_literal'),
    _string_literal: _ => token(seq('"', repeat(choice(/[^"\\]/, /\\[\s\S]/)), '"')),

    // XID_Start plus `_` to begin; XID_Continue plus `_` and `-` to continue. The
    // trailing hyphen rule is why `my-var` is one identifier and `a - b` is subtraction.
    ident: _ => /[_\p{XID_Start}][-_\p{XID_Continue}]*/u,

    // ---- operators --------------------------------------------------------

    _unary: ($, code) => choice(code.sign, code.not),
    sign: ($, code) => prec.left(PREC.unary, seq(choice('+', '-'), code.next(code._value))),
    not: ($, code) => prec.right(PREC.not, seq('not', code.next(code._value))),

    _binary: ($, code) => choice(code.mul, code.div, code.add, code.sub, code.cmp,
      code.in, code.and, code.or, code.assign),
    mul: ($, code) => binary(code, PREC.mul, '*'),
    div: ($, code) => binary(code, PREC.mul, '/'),
    add: ($, code) => binary(code, PREC.add, '+'),
    sub: ($, code) => binary(code, PREC.add, '-'),
    cmp: ($, code) => binary(code, PREC.cmp, choice('==', '!=', '<', '<=', '>', '>=')),
    in: ($, code) => binary(code, PREC.cmp, choice('in', seq(alias($._not_in, 'not'), 'in'))),
    and: ($, code) => binary(code, PREC.and, 'and'),
    or: ($, code) => binary(code, PREC.or, 'or'),
    assign: ($, code) => prec.right(PREC.assign, seq(field('pattern', code._value),
      alias(choice('=', '+=', '-=', '*=', '/='), 'assign'), code.next(field('value', code._value)))),


    // ---- access and calls -------------------------------------------------

    // Only a *value* can be the target of postfix `.field` or a call. Allowing any
    // expression here lets the parser read `let f` as a complete binding and then treat
    // it as the callee of `(a, b)`, which silently turns `let f(a, b) = ...` into
    // nonsense. Typst has the same split: statement forms come back from `code_primary`
    // and are not postfixed.
    _postfixable: ($, code) => choice(
      $._literal,
      $.ident,
      $.block,
      $.content,
      alias($.parenthesized, $.group),
      alias($.array, $.group),
      alias($.dict, $.group),
      code.field,
      code.call,
      // Content literals are ordinary values in code mode: `query(<intro>)`,
      // `t(auto, `auto`)` and `f($x$)` are all valid.
      $.label,
      $._raw,
      $.math,
      // A branch or loop is a value too, so `if a { b } else { c }.filter(f)` field-
      // accesses the whole conditional rather than just its else block — typst nests
      // `FieldAccess(Conditional, ...)`. Real code does this to a comprehension often
      // enough that six corpus files depend on it.
      code.branch,
      code.while,
      code.for,
      $.flow,
    ),

    _finished_value: ($, code) => seq(code._postfixable, optional($._detached_args)),

    field: ($, code) => prec.left(PREC_ACCESS, seq(
      field('target', code._finished_value),
      code.continuation('.'),
      field('field', reserved('field', $.ident)),
    )),

    // Call openers require adjacency even across named comment and newline extras.
    call: ($, code) => prec.left(PREC_CALL, seq(
      field('item', code._postfixable),
      field('args', $.group),
    )),

    // Consecutive content blocks all belong to one `args`: `f[a][b]` is a single call
    // with two content arguments, not nested calls. `prec.left` makes the repeat greedy.
    group: $ => prec.right(PREC_ARGS, choice(
      seq(
        $._args_paren, token.immediate('('),
        optional(seq(sepBy1(',', choice($.tagged, $.spread, $._expr)), optional(','))),
        ')',
        optional($._content_blocks),
      ),
      $._content_blocks,
    )),

    tagged: $ => seq(field('field', $.ident), ':', field('value', $._expr)),
    // A dictionary key may be any expression that computes to one — a string, something
    // parenthesized, or a call such as `(a.keys().first(): "")`. A bare identifier is
    // deliberately absent: `k: v` is a `named` argument, which typst keeps distinct.
    keyed: $ => seq(
      field('key', choice(
        $._literal,
        alias($.parenthesized, $.group),
        $.call,
        $.field,
        alias($.array, $.group),
        alias($.dict, $.group),
        $._binary,
        $.context,
      )),
      ':',
      field('value', $._expr),
    ),
    spread: $ => seq('..', $._expr),
    _sink: $ => seq('..', optional($.ident)),
    _reassignment_sink: $ => seq('..', optional(choice($.ident, $.field, $.call))),

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
        seq(repeat(seq($.spread, ',')), choice($.tagged, $.keyed),
          repeat(seq(',', choice($.tagged, $.keyed, $.spread))), optional(',')),
      ),
      ')',
    ),

    // ---- closures ---------------------------------------------------------

    // A single unparenthesized parameter still gets a `params` node in typst: `x => y`
    // produces `Closure(Params(Ident), Arrow, Ident)`, not a bare identifier.
    closure: ($, code) => prec.right(seq(
      field('params', choice($.params, alias($._bare_param, $.params))),
      '=>',
      code.next(field('body', code._expr)),
    )),

    // `_ => value` is a closure that ignores its argument.
    _bare_param: $ => choice($.ident, $.wildcard),

    params: $ => seq(
      '(', optional(itemsWithSink(choice($.tagged, $._pattern), alias($._sink, $.spread))), ')',
    ),

    // ---- patterns ---------------------------------------------------------

    // `parenthesized` is a pattern too, now that a lone name in parentheses is one:
    // typst reads `let (a) = b` and `for (a) in b` as `Parenthesized`, keeping
    // `Destructuring` for groups that actually destructure.
    _pattern: $ => choice($.ident, $._non_ident_pattern),
    _non_ident_pattern: $ => choice(
      $.wildcard, alias($.destructuring, $.group),
      alias($._empty_destructuring, $.group),
      // Its own rule rather than `parenthesized`, whose contents are an expression:
      // `for ((_)) in o {}` nests a pattern, and `_` is not an expression anywhere.
      alias($._parenthesized_pattern, $.group),
    ),

    _parenthesized_pattern: $ => seq('(', $._pattern, ')'),

    _empty_destructuring: _ => seq('(', ')'),

    wildcard: _ => '_',

    /*
     * A parenthesized group is a destructuring only if something inside says so: a comma,
     * a named entry, or a spread. A lone name in parentheses is just parenthesized — typst
     * reads `let (a) = b` and `for (a) in b` as `Parenthesized`, and only `(a,)` with the
     * trailing comma as a one-element `Destructuring`.
     */
    destructuring: $ => patternGroup($._pattern, alias($._destructuring_named, $.tagged),
      alias($._sink, $.spread)),

    _assign_destructuring: $ => patternGroup($._assign_pattern, alias($._assign_named, $.tagged),
      alias($._reassignment_sink, $.spread)),
    _assign_pattern: $ => choice($._pattern, $.field, $.call,
      alias($._assign_destructuring, $.group),
      alias($._assign_parens, $.group)),
    _assign_parens: $ => seq('(', $._assign_pattern, ')'),
    _assign_named: $ => seq(field('field', $.ident), ':', field('pattern', $._assign_pattern)),

    // The value of a named entry in a destructuring pattern is itself a PATTERN, not an
    // expression: `let (drawables: _) = f()` discards that field, and `_` is not an
    // expression anywhere else.
    _destructuring_named: $ => seq(
      field('field', $.ident),
      ':',
      field('pattern', $._pattern),
    ),

    // `_ = f()` discards a result, and typst models it as a destructuring assignment
    // whose pattern is the placeholder.
    destruct_assignment: ($, code) => prec.dynamic(3, prec.right(PREC.assign, seq(
      field('pattern', choice(
        alias($._assign_destructuring, $.group),
        alias($._empty_destructuring, $.group),
        $.wildcard,
      )),
      '=',
      code.next(field('value', code._expr)),
    ))),

    // ---- bindings and rules ----------------------------------------------

    let: ($, code) => prec.right(seq(
      code.keyword('let'),
      choice(
        // Imenu finds a function by looking for this call in the pattern field.
        seq(field('pattern', alias($._function_signature, $.call)), '=', code.next(field('value', code._expr))),
        seq(field('pattern', $.ident), code.initializer(seq('=', code.next(field('value', code._expr))))),
        seq(field('pattern', $._non_ident_pattern), '=', code.next(field('value', code._expr))),
      ),
    )),

    _function_signature: $ => seq(
      $._let_name_ahead, field('item', $.ident), alias($.params, $.group),
    ),

    // The target of `set` is a dotted path, never a general expression: typst's
    // `set_rule` accepts `Ident ('.' Ident)*` and then parses the argument list itself.
    // Allowing a full expression here would let `text(size: 10pt)` be swallowed whole as
    // a `func_call`, leaving the set rule with no arguments.
    set: ($, code) => prec.right(seq(
      'set',
      alias(code._set_target, $.call),
      optional(seq('if', code.next(field('condition', code._expr)))),
    )),

    _set_target: ($, code) => seq(field('item', choice($.ident, code.field)), field('args', $.group)),

    show: ($, code) => prec.right(seq(
      'show',
      optional(field('selector', code._expr)),
      ':',
      code.next(field('transform', code._expr)),
    )),

    context: ($, code) => prec.right(seq('context', code.next(field('body', code._expr)))),

    // ---- control flow -----------------------------------------------------

    /*
     * The body of a branch or loop is a *block*, never a bare expression: typst rejects
     * `if a 1`, `while a 1` and `for x in y 1` outright. Accepting an expression there
     * was both too permissive and the reason `a * if c {1} else {2} + b` nested wrongly —
     * the else branch would swallow `{2} + b` as a binary, leaving the outer `+` inside
     * the conditional instead of applying to the whole product.
     */
    _block: $ => choice($.block, $.content),

    branch: ($, code) => prec.right(seq(
      'if', code.next(field('condition', code._expr)),
      code.block(field('then', $._block)),
      optional(seq(code.continuation('else'), field('else', choice($._block, code.branch)))),
    )),

    while: ($, code) => prec.right(seq(
      'while', code.next(field('condition', code._expr)), code.block(field('body', $._block)),
    )),

    for: ($, code) => prec.right(seq(
      code.keyword('for'), field('pattern', $._pattern), 'in',
      code.next(field('iterable', code._expr)), code.block(field('body', $._block)),
    )),

    flow: _ => choice('break', 'continue'),
    return: ($, code) => prec.right(seq(
      'return',
      choice(field('value', code._expr), $._bare_return),
    )),

    // ---- modules ----------------------------------------------------------

    import: ($, code) => prec.right(seq(
      'import',
      code.next(field('source', code._expr)),
      optional(alias($._module_alias, $.as)),
      optional(seq(':', optional(field('items', choice(
          alias('*', $.wildcard),
          $.import_items,
          // Parenthesized lists let an import span several lines. The parentheses are
          // siblings of `import_items` rather than wrapping it, matching typst.
          seq('(', optional($.import_items), ')'),
        ))))),
    )),

    _module_alias: $ => seq('as', $.ident),

    // The trailing comma belongs inside the item list.

    import_items: $ => seq(
      sepBy1(',', choice($.import_item_path, $.as)),
      optional(','),
    ),

    import_item_path: $ => sepBy1('.', $.ident),

    as: $ => seq(
      field('path', $.import_item_path),
      'as',
      field('new_name', $.ident),
    ),

    include: ($, code) => prec.right(seq('include', code.next(field('source', code._expr)))),

    // -----------------------------------------------------------------------
    // trivia
    // -----------------------------------------------------------------------

    // Typst's block comments nest — `/* /* */ */` is a single comment, and the first
    // `*/` does not end it. Nesting is not a regular language, so the scanner counts
    // the depth. See `Lexer::block_comment`.
    comment: $ => choice(token(seq('//', /[^\r\n]*/)), seq('/*', $._block_comment_body)),
  }),
});

// Give Emacs a range for a heading and all its subsections. The context-start
// tokens also recognize a heading immediately inside a content block.
function headingRules() {
  const rules = {};
  for (const first of [false, true]) {
    const prefix = first ? '_first_' : '_';
    rules[prefix + 'heading'] = $ => choice(...HEADING_LEVELS.map(n => alias($[prefix + 'heading' + n], $.heading)));
    rules[prefix + 'section'] = $ => choice(...HEADING_LEVELS.map(n => alias($[prefix + 'section' + n], $.section)));
    for (const n of HEADING_LEVELS) {
      rules[prefix + 'heading' + n] = $ => seq(
        alias($[(first ? '_start_head' : '_head') + n], '='.repeat(n)),
        optional($._markup_unlabelled), $._heading_end);
      rules[prefix + 'section' + n] = $ => prec.right(seq(alias($[prefix + 'heading' + n], $.heading),
        optional(alias($['_section_body' + n], $.content))));
    }
  }
  const commentSection = ($, n) => seq($['_before_heading' + n], alias($['_first_section' + n], $.section));
  rules._comment_section = $ => choice(...HEADING_LEVELS.map(n => commentSection($, n)));
  for (const n of HEADING_LEVELS) {
    rules['_section_body' + n] = $ => prec.right(repeat1(choice($._section_newline, $._document_expr,
      ...HEADING_LEVELS.filter(m => m > n).map(m => choice(alias($['_section' + m], $.section),
        commentSection($, m))))));
  }
  return rules;
}

function binary(code, precedence, operator) {
  return prec.left(precedence, seq(field('lhs', code._value),
    field('operator', operator), code.next(field('rhs', choice(code._value, code._statement_expr)))));
}

// Embedded code and code blocks stop at a newline. Parentheses and argument
// lists allow newlines throughout. A code block also continues before a field
// or an else branch. Rules taking ($, code) inherit the surrounding mode via
// code.*; references through $ enter a fixed syntax context (e.g. arguments).
function withCodeModes(rules) {
  const result = { ...rules };
  const expressions = Object.entries(rules).filter(([, define]) => define.length === 2);
  for (const mode of ['continue', 'line', 'block']) {
    const stopped = mode !== 'continue';
    const key = name => stopped ? '_' + mode + '_' + name.replace(/^_/, '') : name;
    for (const [name, define] of expressions) {
      result[key(name)] = $ => {
        const code = {};
        for (const [other] of expressions) {
          const symbol = $[key(other)];
          code[other] = stopped && !other.startsWith('_') ? alias(symbol, $[other]) : symbol;
        }
        code.continuation = token => mode === 'block' ? seq(optional($._code_continues), token) : token;
        code.block = rule => stopped ? seq($._block_ahead, rule) : rule;
        code.initializer = rule => stopped ? choice(rule, $._bare_let) : optional(rule);
        code.next = rule => stopped ? seq($._same_line, rule) : rule;
        code.keyword = word => stopped ? seq(word, $._same_line) : word;
        return define($, code);
      };
    }
  }
  return result;
}

/** Comma-separated items with at most one sink, including a trailing comma. */
function itemsWithSink(item, sink) {
  const last = choice(item, seq(sink, repeat(seq(',', item)), optional(',')));
  return choice(last, seq(repeat1(seq(item, ',')), optional(last)));
}

function sepBy1(sep, rule) {
  return seq(rule, repeat(seq(sep, rule)));
}

/** Zero or more `rule`, separated by `sep`. */
function sepBy(sep, rule) {
  return optional(sepBy1(sep, rule));
}

// A literal opening bracket can outlive the current heading or indented item.
function scopedBracket($, bracket, more, stop) {
  return seq(alias('[', $.text),
    repeat(seq(more, markupExpr($, { label: true, bracket }))),
    choice(seq(more, alias(']', $.text)), stop));
}

/**
 * The markup alternatives, with the pieces that some contexts exclude made optional.
 *
 * Typst expresses these exclusions as a "stop set" passed to its `markup` parser — a
 * heading's body stops at a `Label`, for instance. Generating the choice lets us say the
 * same thing once instead of maintaining two nearly identical lists.
 */
function markupExpr($, { label, heading = true, strong = true, emph = true, colon = true, bracket = $._bracket_text }) {
  return choice(
    $._markup_text,
    $.escape,
    $.linebreak,
    $.shorthand,
    $.quote,
    // Dropped from a delimiter's own body — see `strong` and `emph`.
    ...(strong ? [$.strong] : []),
    ...(emph ? [$.emph] : []),
    $._raw,
    $.url,
    ...(label ? [$.label] : []),
    $.ref,
    ...(heading ? [$._heading] : []),
    alias($._list_item, $.item),
    alias($._enum_item, $.item),
    ...(!label || !strong || !emph ? [$._commented_marker] : []),
    $.term,
    $.math,
    $.code,
    bracket,
    // A bare colon is plain text; `term_item` claims it as a separator where one fits.
    ...(colon ? [alias(':', $.text)] : []),
  );
}

function mathImplicitCall($, group) {
  // math_expr_prec allows explicit arguments only after an identifier or field.
  return prec.left(PREC_MATH.func, seq(
    choice(
      seq(choice(mathLetter($), $.string, $.math_primes, $.escape), $._math_adjacent),
      seq(choice(alias($._math_ident, $.ident), alias($._math_field, $.field)), $._math_adjacent_brace),
    ),
    group,
  ));
}

function mathRoot(operand) {
  return prec.right(PREC_MATH.root, seq(
    field('operator', choice('√', '∛', '∜')),
    field('radicand', operand),
  ));
}

function mathFrac($, denominator) {
  return prec.left(PREC_MATH.frac, seq(
    field('numerator', choice(alias($._math_group, $.formula), $._math_expr)),
    '/',
    field('denominator', denominator),
  ));
}

function mathUnclosedAttach($, scripts) {
  return prec.left(PREC_MATH.attach, seq(
    field('base', $._math_operand),
    optional(seq($._adjacent_prime, $.math_primes)),
    scripts,
  ));
}

function mathScript(operator, operand) {
  return seq(field('operator', operator), field('attachment', operand));
}

/**
 * The math alternatives, with the infix operators made optional.
 *
 * Typst drives this with precedence: an attachment parses its operands at a level that
 * excludes further attachments, then chains any following `^`/`_` into the same node.
 * Dropping the operators from the operand rule expresses the same thing, which is what
 * keeps `x_i^2` one flat attachment carrying both scripts.
 */
function mathExpr($, { operators, inArgs = false }) {
  return choice(
    mathText($),
    seq(choice(alias($._math_ident, $.ident), alias($._math_field, $.field)), optional($._math_symbol_end)),
    $.math_shorthand,
    $.align,
    $.math_primes,
    $.math_delimited,
    alias($.math_implicit_call, $.formula),
    $.fac,
    $.math_root,
    alias($._math_call, $.call),
    $.string,
    $.escape,
    $.linebreak,
    $.code,
    ...(operators ? [
      $.attach,
      $.fraction,
    ] : []),
    // A loose closer is a symbol, as in lr(}, ..). Where a group or argument
    // list can close, its literal token (or higher-priority Unicode/shorthand
    // token) wins over this fallback. This keeps the first closer with its opener.
    alias(token(choice(/[\]}]/, UNICODE_MATH_CLOSE)), $.symbol),
    ...(inArgs ? [] : [alias(token(prec(-1, /\)/)), $.symbol)]),
    alias('|]', $.math_shorthand),
    // Typst lexes these as punctuation or as the start of a shorthand, then falls
    // through to math text when no shorthand matched. `=`, `+`, `<`, `>` and `|` are
    // ordinary symbols in math; only multi-character forms like `<=` or `|->` are
    // shorthands, and longest-match already prefers those.
    // `|` sits here rather than among the delimiters: it never groups, so it is only ever
    // a symbol. The `math_text` character class excludes it, hence the explicit entry.
    alias(choice('.', '!', '=', '+', '<', '>', ':', '|'), $.symbol),
    ...(inArgs ? [] : [alias(choice(',', ';'), $.symbol)]),
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
  return seq(sepBy1(',', choice($.tagged, $.keyed, $.spread)), optional(','));
}

/**
 * A single math grapheme, as one node named `math_text`.
 *
 * A function rather than a rule so the two underlying tokens — letter and non-letter —
 * inline at every use site. They are split only so the implicit-call rule can require a
 * letter when its left operand is math text.
 */
function mathLetter($) {
  return choice(alias($._math_letter, $.letter), alias($._math_alpha_cluster, $.letter));
}

function mathText($) {
  return choice(mathLetter($),
    alias($._math_other_cluster, $.symbol), alias($._math_other, $.symbol));
}

// A comma, a keyed pattern, or a sink distinguishes a destructuring from
// ordinary parentheses. Each group permits one sink in any position.
function patternGroup(pattern, named, sink) {
  const item = choice(pattern, named);
  return seq('(', choice(
    named,
    seq(item, ',', optional(itemsWithSink(item, sink))),
    seq(sink, repeat(seq(',', item)), optional(',')),
  ), ')');
}
