/**
 * Maps Typst's `SyntaxKind` names onto our tree-sitter node names.
 *
 * This file is both the translation table for the span-agreement test (tier 2) and the
 * coverage checklist: every one of the reference parser's 137 kinds must end up either
 * in `KIND_MAP` or in `UNMAPPED_OK`, or `npm run coverage` reports it as unhandled.
 *
 * Values:
 *   'node_name'            our node with the identical span
 *   ['a', 'b']             we produce several nodes covering that span; all must exist
 *   null                   deliberately not modelled, and not worth listing separately
 *   undefined (absent)     NOT YET IMPLEMENTED — reported by the coverage ledger
 *
 * Node names mirror typst's kinds in snake_case. That is deliberate: it keeps this table
 * near-mechanical, so a structural bug shows up as a real disagreement rather than as an
 * artifact of two different naming philosophies.
 */

/**
 * Kinds we intentionally do not emit as *named* nodes.
 *
 * Punctuation and keywords are anonymous tokens in tree-sitter — they appear in the tree
 * as literal strings rather than named nodes, so there is nothing for the span
 * comparison to match. That is the normal, idiomatic choice; queries match them via
 * their literal text.
 */
export const UNMAPPED_OK = new Set([
  // Sentinels.
  'End', 'Error',

  // Trivia. The oracle filters these out before we ever see them (typst counts Space,
  // Parbreak, LineComment, BlockComment and Shebang as trivia). We still model comments
  // as `extras` in the grammar so they can be highlighted.
  'Shebang', 'LineComment', 'BlockComment', 'Space', 'Parbreak',

  // Punctuation and operators — anonymous tokens.
  'Hash', 'LeftBrace', 'RightBrace', 'LeftBracket', 'RightBracket',
  'LeftParen', 'RightParen', 'Comma', 'Semicolon', 'Colon',
  'Star', 'Underscore', 'Dollar', 'Plus', 'Minus', 'Slash', 'Hat', 'Dot',
  'Eq', 'EqEq', 'ExclEq', 'Lt', 'LtEq', 'Gt', 'GtEq',
  'PlusEq', 'HyphEq', 'StarEq', 'SlashEq', 'Dots', 'Arrow', 'Root', 'Bang',

  // Keywords — anonymous tokens.
  'Not', 'And', 'Or', 'Let', 'Set', 'Show', 'Context',
  'If', 'Else', 'For', 'In', 'While', 'Break', 'Continue', 'Return',
  'Import', 'Include', 'As',

  // Structural markers that we fold into their parent node rather than name separately.
  'RefMarker',

  // Whitespace typst strips from a raw block when computing its dedent. That is a
  // presentation decision — how the block will be laid out — not syntax, and it is the
  // reason the inner contents of a raw block are excluded from the span comparison.
  'RawTrimmed',
]);

/**
 * The real mapping. Entries are filled in as each phase of the grammar lands; anything
 * still absent is reported by `npm run coverage` as outstanding work.
 */
export const KIND_MAP = {
  // ---- markup ------------------------------------------------------------

  // Typst wraps every run of markup content in `Markup`: at the root, and again inside
  // each content block, heading, list item and so on. Ours is `source_file` at the root
  // and `markup` when nested.
  Markup: ['source_file', 'markup'],
  Text: 'text',

  Linebreak: 'linebreak',
  Escape: 'escape',
  Shorthand: 'shorthand',
  SmartQuote: 'smart_quote',
  Strong: 'strong',
  Emph: 'emph',
  HeadingMarker: 'heading_marker',
  ListMarker: 'list_marker',
  EnumMarker: 'enum_marker',
  TermMarker: 'term_marker',

  Raw: 'raw',
  RawDelim: 'raw_delim',
  RawLang: 'raw_lang',
  Link: 'link',
  Label: 'label',
  Ref: 'ref',
  Heading: 'heading',
  ListItem: 'list_item',
  EnumItem: 'enum_item',
  TermItem: 'term_item',

  // ---- math --------------------------------------------------------------
  Equation: 'equation',

  Math: 'math',
  MathText: 'math_text',
  MathIdent: 'math_ident',
  MathFieldAccess: 'math_field_access',
  MathShorthand: 'math_shorthand',
  MathAlignPoint: 'math_align_point',
  MathCall: 'math_call',
  MathArgs: 'math_args',
  MathDelimited: 'math_delimited',
  MathAttach: 'math_attach',
  MathFrac: 'math_frac',
  MathRoot: 'math_root',

  // Typst's `MathPrimes` is the `'` run itself, wrapped by a `MathAttach`. Ours names
  // the run `math_primes_marker` and the pairing `math_primes`.
  MathPrimes: 'math_primes_marker',

  // ---- code --------------------------------------------------------------

  Code: 'code',
  CodeBlock: 'code_block',
  ContentBlock: 'content_block',

  // Literals. `None` and `Auto` are keyword-spelled but behave as value literals, and
  // typst emits them as leaf nodes just like `Int`, so they belong here and not in the
  // keyword list.
  None: 'none',
  Auto: 'auto',
  Bool: 'bool',
  Int: 'int',
  Float: 'float',
  Numeric: 'numeric',
  Str: 'str',
  Ident: 'ident',

  Parenthesized: 'parenthesized',
  Array: 'array',
  Dict: 'dict',
  Named: 'named',
  Keyed: 'keyed',
  Spread: 'spread',

  Unary: 'unary',
  Binary: 'binary',
  FieldAccess: 'field_access',
  FuncCall: 'func_call',
  Args: 'args',

  Closure: 'closure',
  Params: 'params',
  Destructuring: 'destructuring',
  DestructAssignment: 'destruct_assignment',

  LetBinding: 'let_binding',
  SetRule: 'set_rule',
  ShowRule: 'show_rule',
  Contextual: 'contextual',

  Conditional: 'conditional',
  WhileLoop: 'while_loop',
  ForLoop: 'for_loop',
  LoopBreak: 'loop_break',
  LoopContinue: 'loop_continue',
  FuncReturn: 'func_return',

  ModuleImport: 'module_import',
  ImportItems: 'import_items',
  ImportItemPath: 'import_item_path',
  RenamedImportItem: 'renamed_import_item',
  ModuleInclude: 'module_include',
};
