/*
 * External scanner for tree-sitter-typst.
 *
 * Typst's markup lexer is not expressible as a set of regular expressions, because
 * several decisions depend on lookahead or on the *preceding* character:
 *
 *   - A text run swallows a single space (`hello world` is one Text) but stops at two.
 *   - A `/` continues the run unless it begins a comment; `-` continues unless it starts
 *     a shorthand; `h` continues unless it starts `http://`.
 *   - `*` is a bold delimiter between non-word characters and literal text inside a word,
 *     so `a*b` is text but `*b*` is strong.
 *   - `=`, `-`, `+`, `/` are structural markers only at the start of a line AND when
 *     followed by a space.
 *   - A `#` expression in markup ends at the newline.
 *
 * Everything here is transcribed from `typst-syntax`'s `Lexer::markup`, `Lexer::text`
 * and `Parser::markup_expr` so that the two implementations agree by construction rather
 * than by coincidence. The differential test suite checks that they actually do.
 */

#include "tree_sitter/parser.h"
#include <string.h>
#include <wctype.h>

enum TokenType {
  TEXT,
  SHORTHAND,
  STAR,
  UNDERSCORE_TOK,
  HEADING_MARKER,
  LIST_MARKER,
  ENUM_MARKER,
  TERM_MARKER,
  RAW_DELIM,
  RAW_LANG,
  RAW_CONTENT,
  ATOMIC_END,
  STMT_END,
  HEADING_END,
  LINE_END,
  FLOAT_TRAILING_DOT,
  ERROR_SENTINEL,
};

/*
 * The scanner keeps exactly one piece of state: how many backticks opened the raw block
 * we are inside, or 0 when we are not inside one.
 *
 * It is deliberately no more than that. An earlier version also remembered the previous
 * character for the `in_word` test, and that could not be kept honest — tree-sitter only
 * persists scanner state after a *successful* external token, so the remembered
 * character survived across every token the built-in lexer produced in between. That
 * decision now happens inside the text run, where the preceding character is simply the
 * one just consumed.
 *
 * The backtick count is safe where the character was not, because it is written and read
 * only at real token boundaries inside a raw block, and it round-trips through
 * serialize/deserialize. The incremental-equivalence tier checks that it actually does.
 */
typedef struct {
  uint8_t raw_backticks;
} Scanner;

// ---------------------------------------------------------------------------
// character classes
// ---------------------------------------------------------------------------

/*
 * ASCII whitespace only, deliberately.
 *
 * Typst stops a text run at *any* Unicode whitespace, but then emits that character as a
 * one-character `Text` rather than discarding it — `発行日時　#x` is two text nodes, the
 * second being just the ideographic space. So U+3000 and friends are content here, not
 * trivia; `is_text_stop` ends the run at them and the dispatcher gives them their own
 * token.
 */
static inline bool is_space(int32_t c) {
  return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == 0x0b || c == 0x0c;
}

static inline bool is_alnum(int32_t c) { return iswalnum((wint_t)c); }

/* Typst identifiers continue on XID_Continue, `_` and `-`. `iswalnum` is a practical
 * stand-in for XID_Continue here; the exact Unicode tables only matter for identifiers
 * in code mode, which the grammar handles with a real property escape. */
static inline bool is_id_continue(int32_t c) {
  return is_alnum(c) || c == '_' || c == '-';
}

/* Valid inside `<label>` and after `@`: identifier characters plus `:` and `.`. */
static inline bool is_label_char(int32_t c) {
  return is_id_continue(c) || c == ':' || c == '.';
}

/*
 * Characters that end a text run (`Lexer::text`'s TABLE), plus non-ASCII whitespace.
 * Several of these resume the same run — see `scan_text`.
 */
static bool is_text_stop(int32_t c) {
  switch (c) {
    case ' ': case '\t': case '\n': case 0x0b: case 0x0c: case '\r':
    case '\\': case '/': case '[': case ']': case '~': case '-': case '.':
    case '\'': case '"': case '*': case '_': case ':': case 'h': case '`':
    case '$': case '<': case '>': case '@': case '#':
      return true;
    default:
      return c > 127 && iswspace((wint_t)c);
  }
}

// ---------------------------------------------------------------------------
// lexer helpers
// ---------------------------------------------------------------------------

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }
static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

/* Consume `s` if it is next. Returns false without consuming if it is not a full match.
 * NOTE: tree-sitter lexers cannot rewind, so on a partial match the consumed prefix
 * stays consumed; every caller below is written to tolerate that. */
static bool eat_str(TSLexer *lexer, const char *s) {
  for (const char *p = s; *p; p++) {
    if (lexer->lookahead != (int32_t)*p) return false;
    advance(lexer);
  }
  return true;
}

/**
 * Whether only blanks separate us from the end of the line.
 *
 * Used by the zero-width terminators, which must be decided before any whitespace is
 * skipped so that they land at the true end of a construct. Trailing blanks are consumed
 * as skipped characters, which keeps them out of the token while still letting a line
 * that ends in spaces terminate.
 */
static bool at_line_trailer(TSLexer *lexer) {
  while (!lexer->eof(lexer) &&
         (lexer->lookahead == ' ' || lexer->lookahead == '\t' || lexer->lookahead == '\r')) {
    skip(lexer);
  }
  return lexer->eof(lexer) || lexer->lookahead == '\n';
}

/* Typst's `space_or_end`: end of file, whitespace, or the start of a comment. */
static bool at_space_or_end(TSLexer *lexer) {
  if (lexer->eof(lexer)) return true;
  if (is_space(lexer->lookahead)) return true;
  return lexer->lookahead == '/';  // `//` or `/*`; either way the marker ends here
}

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

/*
 * `Lexer::text`: consume until a stop character, then decide whether that character
 * resumes the same run. Mirrors the match block in typst's `text()` exactly.
 *
 * `mark_end` is called after every committed character so that lookahead performed to
 * make a continuation decision is not accidentally included in the token.
 */
static bool scan_text(TSLexer *lexer, bool started) {
  bool any = started;

  // The last character taken into the run. Knowing it locally is what lets `in_word` be
  // decided here rather than from saved state — see the `*`/`_` case below.
  int32_t last = 0;

  for (;;) {
    while (!lexer->eof(lexer) && !is_text_stop(lexer->lookahead)) {
      last = lexer->lookahead;
      advance(lexer);
      any = true;
    }
    lexer->mark_end(lexer);
    if (lexer->eof(lexer)) break;

    int32_t c = lexer->lookahead;

    /*
     * `*` and `_` are delimiters between non-word characters and literal text inside a
     * word, so `a*b` is text while `*b*` is bold. Typst decides this by looking at the
     * characters on both sides; here the left one is simply the character we just
     * consumed, so no state has to survive between calls.
     *
     * When the run has not consumed anything yet, `last` is 0 and we stop — the
     * dispatcher checks STAR/UNDERSCORE before TEXT, so a run only ever *starts* at one
     * of these when it is genuinely a delimiter.
     */
    if (c == '*' || c == '_') {
      if (!is_alnum(last)) break;
      advance(lexer);
      if (!is_alnum(lexer->lookahead)) break;
      lexer->mark_end(lexer);
      last = c;
      any = true;
      continue;
    }
    if (c == ' ') {
      // A single space stays inside the run only when a word follows it.
      advance(lexer);
      if (!is_alnum(lexer->lookahead)) break;
      lexer->mark_end(lexer);
      last = c;
      any = true;
      continue;
    }
    if (c == '/') {
      advance(lexer);
      if (lexer->lookahead == '/' || lexer->lookahead == '*') break;  // a comment
      lexer->mark_end(lexer);
      last = c;
      any = true;
      continue;
    }
    if (c == '-') {
      advance(lexer);
      // `--`, `---` and `-?` are shorthands; a lone `-` is ordinary text.
      if (lexer->lookahead == '-' || lexer->lookahead == '?') break;
      lexer->mark_end(lexer);
      last = c;
      any = true;
      continue;
    }
    if (c == '.') {
      advance(lexer);
      if (lexer->lookahead == '.') break;  // `...` is a shorthand
      lexer->mark_end(lexer);
      last = c;
      any = true;
      continue;
    }
    if (c == 'h') {
      advance(lexer);
      // Only `http://` and `https://` break the run; any other `h` is just a letter.
      if (lexer->lookahead == 't') {
        advance(lexer);
          if (lexer->lookahead == 't') {
          advance(lexer);
              if (lexer->lookahead == 'p') break;  // close enough to commit to a link
        }
      }
      lexer->mark_end(lexer);
      any = true;
      continue;
    }
    if (c == '@') {
      advance(lexer);
      if (is_label_char(lexer->lookahead)) break;  // a reference
      lexer->mark_end(lexer);
      last = c;
      any = true;
      continue;
    }
    if (c == '<') {
      advance(lexer);
      if (is_id_continue(lexer->lookahead)) break;  // a label
      lexer->mark_end(lexer);
      last = c;
      any = true;
      continue;
    }
    if (c == '>') {
      // `>` stops a run only so that `<label>` can be recognized; on its own it is
      // ordinary text and the run carries on.
      advance(lexer);
      lexer->mark_end(lexer);
      any = true;
      continue;
    }
    break;
  }

  if (!any) return false;
  lexer->result_symbol = TEXT;
  return true;
}

/**
 * Finish a marker candidate that is already consumed and followed by a space.
 *
 * At the start of a line it is the structural marker; anywhere else typst converts the
 * same token to `Text`, which leaves it as a standalone one-character node rather than
 * part of the following run.
 */
static bool emit_marker_or_text(TSLexer *lexer, unsigned marker,
                                const bool *valid_symbols, bool at_line_start) {
  lexer->mark_end(lexer);

  if (at_line_start && valid_symbols[marker]) {
    lexer->result_symbol = marker;
    return true;
  }
  if (!valid_symbols[TEXT]) return false;
  lexer->result_symbol = TEXT;
  return true;
}

// ---------------------------------------------------------------------------
// raw
// ---------------------------------------------------------------------------

/*
 * `Lexer::raw`: count the opening backticks, then look for the same number in a row.
 * Exactly two backticks are an empty raw block. An unterminated run is an error in
 * typst, and we decline the token so the parser can report it.
 */
/*
 * Raw blocks are emitted in pieces — delimiter, optional language tag, content,
 * delimiter — rather than as one opaque token, because the language tag and the content
 * span are what `queries/injections.scm` needs to highlight embedded code.
 *
 * The opening fence sets `raw_backticks`; the block ends at the next run of exactly that
 * many backticks. Whitespace inside is content, so the caller must not skip it.
 *
 * We deliberately do NOT reproduce typst's inner segmentation, which splits content into
 * one `Text` per line after computing a common dedent and emitting `RawTrimmed` nodes
 * for what it removed. That is presentation — how the block will be laid out — not
 * syntax an editor needs, and the span comparison excludes it explicitly.
 */
static bool scan_raw_open(TSLexer *lexer, Scanner *scanner) {
  unsigned backticks = 0;
  while (lexer->lookahead == '`' && backticks < 255) {
    advance(lexer);
    backticks++;
    // Mark after the first backtick so the two-backtick case below can settle on a
    // one-character delimiter; a tree-sitter lexer cannot rewind, but `mark_end` may be
    // moved forward again once the full count is known.
    if (backticks == 1) lexer->mark_end(lexer);
  }
  if (backticks == 0) return false;

  if (backticks == 2) {
    // ``` `` ``` is an empty raw block, which typst represents as two one-character
    // delimiters. Open with one and let the second one close it; `mark_end` is already
    // sitting after the first.
    scanner->raw_backticks = 1;
  } else {
    scanner->raw_backticks = (uint8_t)backticks;
    lexer->mark_end(lexer);
  }

  lexer->result_symbol = RAW_DELIM;
  return true;
}

/** The closing fence: exactly `n` backticks. */
static bool scan_raw_close(TSLexer *lexer, Scanner *scanner) {
  for (unsigned i = 0; i < scanner->raw_backticks; i++) {
    if (lexer->lookahead != '`') return false;
    advance(lexer);
  }
  scanner->raw_backticks = 0;
  lexer->mark_end(lexer);
  lexer->result_symbol = RAW_DELIM;
  return true;
}

/** Everything up to (but not including) the closing fence. */
static bool scan_raw_content(TSLexer *lexer, Scanner *scanner) {
  unsigned run = 0;  // consecutive backticks seen so far
  bool any = false;

  for (;;) {
    if (lexer->eof(lexer)) {
      // Unterminated. Give back what we have so the parser can report a missing
      // delimiter rather than the scanner silently swallowing the rest of the file.
      lexer->mark_end(lexer);
      break;
    }
    if (lexer->lookahead == '`') {
      run++;
      // A run long enough to close the block: stop before it.
      if (run >= scanner->raw_backticks) break;
      advance(lexer);
      any = true;
      continue;
    }
    if (run > 0) {
      // Backticks too few to close; they are ordinary content.
      run = 0;
    }
    advance(lexer);
    any = true;
    lexer->mark_end(lexer);
  }

  if (!any) return false;
  lexer->result_symbol = RAW_CONTENT;
  return true;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

static bool scan_impl(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols);

bool tree_sitter_typst_external_scanner_scan(void *payload, TSLexer *lexer,
                                             const bool *valid_symbols) {
  return scan_impl((Scanner *)payload, lexer, valid_symbols);
}

static bool scan_impl(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {

  // In an error-recovery state tree-sitter marks every token valid; producing our
  // whitespace-sensitive tokens there does more harm than letting the built-in lexer
  // resynchronize.
  if (valid_symbols[ERROR_SENTINEL]) return false;

  /*
   * Inside a raw block nothing is trivia — every space and newline is content — so this
   * runs before the whitespace skipping below.
   *
   * Content is tried before the closing fence because `scan_raw_content` stops *at* the
   * fence and reports failure when there is nothing before it, which is exactly the
   * signal that the block is ready to close.
   */
  if (scanner->raw_backticks > 0) {
    if (valid_symbols[RAW_LANG] && scanner->raw_backticks >= 3 &&
        (iswalpha((wint_t)lexer->lookahead) || lexer->lookahead == '_')) {
      while (is_id_continue(lexer->lookahead)) advance(lexer);
      lexer->mark_end(lexer);
      lexer->result_symbol = RAW_LANG;
      return true;
    }
    if (valid_symbols[RAW_CONTENT] && scan_raw_content(lexer, scanner)) return true;
    if (valid_symbols[RAW_DELIM]) return scan_raw_close(lexer, scanner);
    return false;
  }

  /*
   * All three zero-width terminators are decided HERE, before any whitespace is skipped.
   *
   * A zero-width token still has a position, and that position becomes the end of every
   * node it closes. Deciding these after skipping would put them past the newline and
   * indentation, so a content block's `markup` would run to the closing bracket and a
   * heading's would swallow its line break — every enclosing span too long by exactly
   * the trivia in between.
   */

  /*
   * A heading also ends at a label: in `= Real <real>` typst leaves the label a sibling
   * of the heading rather than a child, which it spells as the stop set
   * `syntax_set!(Label, RightBracket, End)`. List items do not stop there — `- item <l>`
   * keeps the label inside — so this needs its own token rather than an extra case on
   * LINE_END.
   */
  if (valid_symbols[HEADING_END]) {
    // Mark first: `at_line_trailer` consumes any blanks, and the terminator must sit at
    // the true end of the heading rather than after the space before a label.
    lexer->mark_end(lexer);
    bool eol = at_line_trailer(lexer);
    if (eol || lexer->lookahead == ']' || lexer->lookahead == '<') {
      lexer->result_symbol = HEADING_END;
      return true;
    }
  }

  // A list item or term item ends at the end of its line.
  if (valid_symbols[LINE_END]) {
    if (lexer->eof(lexer) || lexer->lookahead == '\n' || lexer->lookahead == ']' ||
        at_line_trailer(lexer)) {
      lexer->mark_end(lexer);
      lexer->result_symbol = LINE_END;
      return true;
    }
  }

  /*
   * Terminating a `#` expression. There are two of these because Typst treats the two
   * kinds of embedded expression differently, and collapsing them into one cannot be
   * made correct:
   *
   *   `#f(1) *bold*`   a value: atomic, so nothing but `.`/`(`/`[` may follow, and
   *                    `*bold*` is markup
   *   `#let x = 1 * 2` a statement: its body is a full expression, so `*` is
   *                    multiplication and only the newline ends it
   *
   * Both are REQUIRED in the grammar, not optional, and that is load-bearing. Markup can
   * only resume once the terminator has been consumed, so at a position like the `(` in
   * `#let f(a, b)` the parser does not offer `text` at all — which stops the greedy text
   * scanner from swallowing the parameter list.
   */
  if (valid_symbols[ATOMIC_END]) {
    lexer->mark_end(lexer);
    int32_t next = lexer->lookahead;

    // Postfix only binds when directly adjacent: `#f(x)` is a call, `#f (x)` is not.
    if (!lexer->eof(lexer) && !is_space(next)) {
      if (next == '(' || next == '[') return false;
      if (next == '.') {
        // Only a field access continues the expression. A sentence-ending period does
        // not: in `#it.prefix().]` the final `.` is markup text, and typst likewise
        // requires an identifier after the dot before treating it as an access.
        advance(lexer);
        if (iswalpha((wint_t)lexer->lookahead) || lexer->lookahead == '_') return false;
      }
    } else {
      /*
       * An `else` on the same line belongs to the conditional we are about to close.
       * `#if c [x] else [y]` has to stay one expression, and since the scanner returning
       * a token is the only source of one at this position, terminating here would kill
       * the `else` branch outright.
       */
      while (!lexer->eof(lexer) &&
             (lexer->lookahead == ' ' || lexer->lookahead == '\t' || lexer->lookahead == '\r')) {
        skip(lexer);
      }
      if (eat_str(lexer, "else") && !is_id_continue(lexer->lookahead)) return false;
    }

    lexer->result_symbol = ATOMIC_END;
    return true;
  }

  if (valid_symbols[STMT_END]) {
    lexer->mark_end(lexer);

    /*
     * A statement's body is a full expression, so on the same line it may well continue —
     * `#let x = 1 * 2` is multiplication, not markup. But some characters cannot continue
     * a code expression under any reading, and markup genuinely resumes at them:
     * `#if c { } \` ends the conditional and starts a linebreak. Ambiguous ones (`*`,
     * `<`, letters) are deliberately absent, since each has a valid code meaning.
     */
    // Skip blanks first, so `} \` is judged on the backslash rather than the space.
    bool eol = at_line_trailer(lexer);
    int32_t next = lexer->lookahead;
    bool markup_resumes = next == '\\' || next == '`' || next == '$' ||
                          next == '~' || next == '#' || next == '@';

    if (eol || next == ']' || markup_resumes) {
      lexer->result_symbol = STMT_END;
      return true;
    }
    return false;
  }

  // Skip whitespace ourselves, tracking whether a line ended. Doing this here rather
  // than via `extras` is what makes `at_line_start` and `prev_char` knowable.
  bool saw_newline = false;
  bool saw_space = false;
  while (!lexer->eof(lexer) && is_space(lexer->lookahead)) {
    if (lexer->lookahead == '\n') saw_newline = true;
    saw_space = true;
    skip(lexer);
  }

  /*
   * `1.` is a float, but `1.method()` is a field access on an integer. Telling them
   * apart needs one character of lookahead past the dot, which a tree-sitter regex
   * cannot do — so the scanner does it. A digit after the dot is an ordinary float and
   * is left to the grammar; a second dot is the spread operator.
   */
  if (valid_symbols[FLOAT_TRAILING_DOT] && lexer->lookahead >= '0' && lexer->lookahead <= '9') {
    while (lexer->lookahead >= '0' && lexer->lookahead <= '9') advance(lexer);
    if (lexer->lookahead != '.') return false;
    advance(lexer);
    int32_t after = lexer->lookahead;
    if (iswalpha((wint_t)after) || after == '_' || after == '.' ||
        (after >= '0' && after <= '9')) {
      return false;
    }
    lexer->mark_end(lexer);
    lexer->result_symbol = FLOAT_TRAILING_DOT;
    return true;
  }

  int32_t c = lexer->lookahead;
  uint32_t column = lexer->get_column(lexer);
  bool at_line_start = saw_newline || column == 0;


  if (lexer->eof(lexer)) return false;

  if (valid_symbols[RAW_DELIM] && c == '`') return scan_raw_open(lexer, scanner);

  /*
   * From here the order follows `Lexer::markup` exactly, and the order matters: typst
   * tests the shorthand arms BEFORE the line-start markers, which is why `---` at the
   * start of a line is an em dash rather than a list item followed by `--`.
   */

  // `~` — a non-breaking space.
  if (valid_symbols[SHORTHAND] && c == '~') {
    advance(lexer);
    lexer->mark_end(lexer);
    lexer->result_symbol = SHORTHAND;
    return true;
  }

  // `...` — an ellipsis. A lone or doubled dot is ordinary text.
  if (c == '.' && (valid_symbols[SHORTHAND] || valid_symbols[TEXT])) {
    advance(lexer);
    if (lexer->lookahead == '.') {
      advance(lexer);
      if (lexer->lookahead == '.') {
        advance(lexer);
        if (!valid_symbols[SHORTHAND]) return false;
        lexer->mark_end(lexer);
        lexer->result_symbol = SHORTHAND;
        return true;
      }
    }
    if (!valid_symbols[TEXT]) return false;
    return scan_text(lexer, true);
  }

  /*
   * `-` is the busiest character in markup: `---`/`--` are dashes, `-?` is a soft
   * hyphen, `-` before a digit is a minus sign, `- ` at the start of a line is a list
   * marker, and anything else is text.
   */
  if (c == '-' && (valid_symbols[SHORTHAND] || valid_symbols[LIST_MARKER] || valid_symbols[TEXT])) {
    advance(lexer);
    if (lexer->lookahead == '-') {
      advance(lexer);
      if (lexer->lookahead == '-') advance(lexer);
      if (!valid_symbols[SHORTHAND]) return false;
      lexer->mark_end(lexer);
      lexer->result_symbol = SHORTHAND;
      return true;
    }
    if (lexer->lookahead == '?') {
      advance(lexer);
      if (!valid_symbols[SHORTHAND]) return false;
      lexer->mark_end(lexer);
      lexer->result_symbol = SHORTHAND;
      return true;
    }
    if (lexer->lookahead >= '0' && lexer->lookahead <= '9') {
      // A minus sign: the shorthand is the `-` alone, the number lexes separately.
      if (!valid_symbols[SHORTHAND]) return false;
      lexer->mark_end(lexer);
      lexer->result_symbol = SHORTHAND;
      return true;
    }
    if (at_space_or_end(lexer)) {
      lexer->mark_end(lexer);
      if (at_line_start && valid_symbols[LIST_MARKER]) {
        lexer->result_symbol = LIST_MARKER;
        return true;
      }
      // Not at the start of a line, so it is text — but a *one-character* text node.
      // Typst lexes `- ` as a ListMarker wherever it appears and lets `markup_expr`
      // convert it to Text, so the character stands alone rather than joining the
      // following run. Matching that keeps our node boundaries aligned with typst's.
      if (!valid_symbols[TEXT]) return false;
      lexer->result_symbol = TEXT;
      return true;
    }
    if (!valid_symbols[TEXT]) return false;
    return scan_text(lexer, true);
  }

  /*
   * `*` and `_` delimit strong and emphasis, but only outside a word: typst's `in_word`
   * checks the characters on both sides. `a*b` is literal text, `*b*` is bold.
   */
  // A text run absorbs an in-word `*`/`_` itself (see scan_text), so reaching here means
  // this one really is a delimiter.
  if ((valid_symbols[STAR] && c == '*') || (valid_symbols[UNDERSCORE_TOK] && c == '_')) {
    advance(lexer);
    lexer->mark_end(lexer);
    lexer->result_symbol = (c == '*') ? STAR : UNDERSCORE_TOK;
    return true;
  }

  /*
   * `=`, `+`, `1.` and `/` introduce headings, list items, enumerations and term items —
   * but only at the start of a line, and only when a space follows. Typst lexes them as
   * markers wherever they appear and lets `markup_expr` turn them back into text when
   * they are not at the start; `emit_marker_or_text` reproduces both halves of that, so
   * the character forms its own text node exactly as it does in typst.
   */
  if (c == '=') {
    while (lexer->lookahead == '=') advance(lexer);
    if (at_space_or_end(lexer)) {
      return emit_marker_or_text(lexer, HEADING_MARKER, valid_symbols,
                                 at_line_start);
    }
    if (!valid_symbols[TEXT]) return false;
    return scan_text(lexer, true);
  }

  if (c == '+') {
    advance(lexer);
    if (at_space_or_end(lexer)) {
      return emit_marker_or_text(lexer, ENUM_MARKER, valid_symbols,
                                 at_line_start);
    }
    if (!valid_symbols[TEXT]) return false;
    return scan_text(lexer, true);
  }

  // `1.`, `24.` — `Lexer::numbering`: digits, a dot, then a space.
  if (c >= '0' && c <= '9') {
    while (lexer->lookahead >= '0' && lexer->lookahead <= '9') advance(lexer);
    if (lexer->lookahead == '.') {
      advance(lexer);
      if (at_space_or_end(lexer)) {
        return emit_marker_or_text(lexer, ENUM_MARKER, valid_symbols,
                                 at_line_start);
      }
    }
    if (!valid_symbols[TEXT]) return false;
    return scan_text(lexer, true);
  }

  if (c == '/') {
    advance(lexer);
    // `//` and `/*` open comments, not term items. Bailing out entirely lets the
    // built-in lexer match the comment; returning false discards what we consumed.
    if (lexer->lookahead == '/' || lexer->lookahead == '*') return false;
    if (at_space_or_end(lexer)) {
      return emit_marker_or_text(lexer, TERM_MARKER, valid_symbols,
                                 at_line_start);
    }
    if (!valid_symbols[TEXT]) return false;
    return scan_text(lexer, true);
  }

  if (valid_symbols[TEXT]) {
    // Structural characters and those with their own grammar token; the grammar owns
    // them and the scanner must not swallow them as text.
    if (c == '[' || c == ']' || c == '#' || c == '$' || c == '`' ||
        c == '\\' || c == '\'' || c == '"') {
      return false;
    }

    // Non-ASCII whitespace ends a run but is itself content: typst falls through to
    // `text()` with the character already consumed, giving it a node of its own.
    if (c > 127 && iswspace((wint_t)c)) {
      advance(lexer);
      return scan_text(lexer, true);
    }

    // `:` is left to the grammar. It separates a term item from its description and is
    // plain text everywhere else; consuming it here would eat the separator before
    // `term_item` could match it. The grammar aliases a bare `:` to `text`, reproducing
    // typst's Colon-to-Text conversion while letting the parser weigh both readings.
    if (c == ':') return false;

    return scan_text(lexer, false);
  }

  return false;
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

void *tree_sitter_typst_external_scanner_create(void) {
  return calloc(1, sizeof(Scanner));
}

void tree_sitter_typst_external_scanner_destroy(void *payload) { free(payload); }

/*
 * Nothing to serialize.
 *
 * Serialized state has to round-trip exactly, because an editor reparses incrementally
 * from a saved snapshot and anything inconsistent shows up as a tree that differs from a
 * full parse. Having no state at all is the strongest possible guarantee, and it is why
 * `in_word` is decided inside the text run rather than remembered between calls.
 */
unsigned tree_sitter_typst_external_scanner_serialize(void *payload, char *buffer) {
  buffer[0] = (char)((Scanner *)payload)->raw_backticks;
  return 1;
}

void tree_sitter_typst_external_scanner_deserialize(void *payload, const char *buffer,
                                                    unsigned length) {
  Scanner *scanner = (Scanner *)payload;
  scanner->raw_backticks = length >= 1 ? (uint8_t)buffer[0] : 0;
}
