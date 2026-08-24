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
  'Not', 'And', 'Or', 'None', 'Auto', 'Let', 'Set', 'Show', 'Context',
  'If', 'Else', 'For', 'In', 'While', 'Break', 'Continue', 'Return',
  'Import', 'Include', 'As',

  // Structural markers that we fold into their parent node rather than name separately.
  'HeadingMarker', 'ListMarker', 'EnumMarker', 'TermMarker', 'RefMarker',
  'RawDelim', 'RawTrimmed',
]);

/**
 * The real mapping. Entries are filled in as each phase of the grammar lands; anything
 * still absent is reported by `npm run coverage` as outstanding work.
 */
export const KIND_MAP = {
  // ---- markup ------------------------------------------------------------
  // Phase 2. `Markup` is typst's wrapper around a run of markup content; whether we
  // emit a matching node is decided when that phase lands.
  // Markup, Text, Linebreak, Escape, Shorthand, SmartQuote, Strong, Emph,
  // Raw, RawLang, Link, Label, Ref, Heading, ListItem, EnumItem, TermItem,

  // ---- math --------------------------------------------------------------
  // Phase 3.
  // Equation, Math, MathText, MathIdent, MathFieldAccess, MathShorthand,
  // MathAlignPoint, MathCall, MathArgs, MathDelimited, MathAttach, MathPrimes,
  // MathFrac, MathRoot,

  // ---- code --------------------------------------------------------------
  // Phase 1.
  // Code, Ident, Bool, Int, Float, Numeric, Str, CodeBlock, ContentBlock,
  // Parenthesized, Array, Dict, Named, Keyed, Unary, Binary, FieldAccess,
  // FuncCall, Args, Spread, Closure, Params, LetBinding, SetRule, ShowRule,
  // Contextual, Conditional, WhileLoop, ForLoop, ModuleImport, ImportItems,
  // ImportItemPath, RenamedImportItem, ModuleInclude, LoopBreak, LoopContinue,
  // FuncReturn, Destructuring, DestructAssignment,
};
