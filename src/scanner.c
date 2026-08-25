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
  RAW,
  ATOMIC_END,
  STMT_END,
  LINE_END,
  ERROR_SENTINEL,
};

/*
 * The scanner is stateless.
 *
 * It began with a remembered previous character for the `in_word` test, but that state
 * could not be kept honest: tree-sitter only persists scanner state after a successful
 * external token, and an incremental reparse restores it from an arbitrary earlier
 * point. Deciding `in_word` inside the text run instead — where the preceding character
 * is simply the one just consumed — removes the state and with it a whole class of
 * incremental-parse bugs.
 */

// ---------------------------------------------------------------------------
// character classes
// ---------------------------------------------------------------------------

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
static bool scan_raw(TSLexer *lexer) {
  unsigned backticks = 0;
  while (lexer->lookahead == '`') {
    advance(lexer);
    backticks++;
  }
  if (backticks == 0) return false;

  if (backticks == 2) {  // ``
    lexer->mark_end(lexer);
    lexer->result_symbol = RAW;
    return true;
  }

  unsigned found = 0;
  while (found < backticks) {
    if (lexer->eof(lexer)) return false;  // unclosed
    if (lexer->lookahead == '`') found++;
    else found = 0;
    advance(lexer);
  }

  lexer->mark_end(lexer);
  lexer->result_symbol = RAW;
  return true;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

static bool scan_impl(TSLexer *lexer, const bool *valid_symbols);

bool tree_sitter_typst_external_scanner_scan(void *payload, TSLexer *lexer,
                                             const bool *valid_symbols) {
  (void)payload;
  return scan_impl(lexer, valid_symbols);
}

static bool scan_impl(TSLexer *lexer, const bool *valid_symbols) {

  // In an error-recovery state tree-sitter marks every token valid; producing our
  // whitespace-sensitive tokens there does more harm than letting the built-in lexer
  // resynchronize.
  if (valid_symbols[ERROR_SENTINEL]) return false;

  /*
   * A heading, list item or term item ends at the end of its line. Check for that
   * *before* skipping the newline, so the zero-width terminator lands on the newline
   * rather than after it — otherwise every such node's span would swallow the line
   * break and disagree with typst.
   */
  if (valid_symbols[LINE_END]) {
    while (!lexer->eof(lexer) &&
           (lexer->lookahead == ' ' || lexer->lookahead == '\t' || lexer->lookahead == '\r')) {
      skip(lexer);
    }
    if (lexer->eof(lexer) || lexer->lookahead == '\n' || lexer->lookahead == ']') {
      lexer->mark_end(lexer);
      lexer->result_symbol = LINE_END;
      return true;
    }
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

  int32_t c = lexer->lookahead;
  uint32_t column = lexer->get_column(lexer);
  bool at_line_start = saw_newline || column == 0;


  /*
   * A `#` expression in markup runs under `AtNewline::Stop`: it ends at the newline.
   *
   * The terminator is *optional* in the grammar, and that is what makes this work. On
   * the same line the scanner simply declines, the built-in lexer supplies the next
   * token and the expression carries on. At a newline the scanner returns CODE_END, and
   * because a scanner that returns a token is the only source of one at that position,
   * the parser has no way to continue the expression across the line break.
   */
  /*
   * Terminating a `#` expression. There are two of these because Typst treats the two
   * kinds of embedded expression differently, and collapsing them into one token cannot
   * be made correct:
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
    // Mark the zero-width position up front so the lookahead below cannot extend it.
    lexer->mark_end(lexer);

    if (!saw_space) {
      if (c == '(' || c == '[') return false;  // a call, or a content argument
      if (c == '.') {
        // Only a field access continues the expression. A sentence-ending period does
        // not: in `#it.prefix().]` the final `.` is markup text, and typst likewise
        // requires an identifier after the dot before treating it as an access.
        advance(lexer);
        if (iswalpha((wint_t)lexer->lookahead) || lexer->lookahead == '_') return false;
      }
    }

    lexer->result_symbol = ATOMIC_END;
    return true;
  }

  if (valid_symbols[STMT_END]) {
    if (saw_newline || lexer->eof(lexer) || c == ']') {
      lexer->mark_end(lexer);
      lexer->result_symbol = STMT_END;
      return true;
    }
    return false;  // same line: the statement's body may still continue
  }

  if (lexer->eof(lexer)) return false;

  if (valid_symbols[RAW] && c == '`') return scan_raw(lexer);

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
  // Stateless, but tree-sitter still wants a non-NULL payload.
  return calloc(1, 1);
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
  (void)payload;
  (void)buffer;
  return 0;
}

void tree_sitter_typst_external_scanner_deserialize(void *payload, const char *buffer,
                                                    unsigned length) {
  (void)payload;
  (void)buffer;
  (void)length;
}
