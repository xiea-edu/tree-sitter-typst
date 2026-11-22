/**
 * Maps Typst's `SyntaxKind` names onto our tree-sitter node names.
 *
 * This file is both the translation table for the span-agreement test (tier 2) and the
 * coverage checklist: every one of the reference parser's 137 kinds must end up either
 * in `KIND_MAP` or in `UNMAPPED_OK`, or `npm run coverage` reports it as unhandled.
 *
 * Values:
 *   'node_name'            corresponding editor node
 *   ['a', 'b']             context selects the corresponding editor node
 *   null                   deliberately not modelled, and not worth listing separately
 *   undefined (absent)     NOT YET IMPLEMENTED — reported by the coverage ledger
 *
 * The major mode owns the public node names. Context-dependent spans and
 * parent changes are projected from the oracle in spans.mjs.
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
  // each content block, heading and list item. The mode exposes nested markup directly.
  Markup: 'source_file',
  Text: 'text',

  Linebreak: 'linebreak',
  Escape: 'escape',
  Shorthand: 'shorthand',
  SmartQuote: 'quote',
  Strong: 'strong',
  Emph: 'emph',
  HeadingMarker: null,
  ListMarker: null,
  EnumMarker: 'enum_marker',
  TermMarker: null,

  Raw: ['raw_span', 'raw_blck'],
  RawDelim: null,
  RawLang: 'ident',
  Link: 'url',
  Label: 'label',
  Ref: 'ref',
  RefMarker: 'ref_marker',
  Heading: 'heading',
  ListItem: 'item',
  EnumItem: 'item',
  TermItem: 'term',

  // ---- math --------------------------------------------------------------
  Equation: 'math',

  Math: ['formula', 'fac'],
  MathText: ['symbol', 'letter'],
  MathIdent: 'ident',
  MathFieldAccess: 'field',
  MathShorthand: 'math_shorthand',
  MathAlignPoint: 'align',
  MathCall: 'call',
  MathArgs: 'group',
  MathDelimited: 'math_delimited',
  MathAttach: 'attach',
  MathFrac: 'fraction',
  MathRoot: 'math_root',

  // Typst's `MathPrimes` is the `'` run itself, wrapped by a `MathAttach`. Ours names
  // the run `math_primes` and lets `attach` be the pairing.
  MathPrimes: 'math_primes',

  // ---- code --------------------------------------------------------------

  Code: null,
  CodeBlock: 'block',
  ContentBlock: 'content',

  // Literals. `None` and `Auto` are keyword-spelled but behave as value literals, and
  // typst emits them as leaf nodes just like `Int`, so they belong here and not in the
  // keyword list.
  None: 'none',
  Auto: 'auto',
  Bool: 'bool',
  Int: 'number',
  Float: 'number',
  Numeric: 'number',
  Str: 'string',
  Ident: 'ident',

  Parenthesized: 'group',
  Array: 'group',
  Dict: 'group',
  Named: 'tagged',
  Keyed: 'keyed',
  Spread: 'spread',

  Unary: ['sign', 'not'],
  Binary: ['add', 'sub', 'mul', 'div', 'in', 'cmp', 'and', 'or', 'assign'],
  FieldAccess: 'field',
  FuncCall: 'call',
  Args: 'group',

  Closure: 'closure',
  Params: 'params',
  Destructuring: 'group',
  DestructAssignment: 'destruct_assignment',

  LetBinding: 'let',
  SetRule: 'set',
  ShowRule: 'show',
  Contextual: 'context',

  Conditional: 'branch',
  WhileLoop: 'while',
  ForLoop: 'for',
  LoopBreak: 'flow',
  LoopContinue: 'flow',
  FuncReturn: 'return',

  ModuleImport: 'import',
  ImportItems: 'import_items',
  ImportItemPath: 'import_item_path',
  RenamedImportItem: 'as',
  ModuleInclude: 'include',
};
