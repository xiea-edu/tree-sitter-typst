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
  CODE_SEP,
  NUMBER_INT,
  NUMBER_FLOAT,
  NUMBER_NUMERIC,
  BLOCK_COMMENT,
  ESCAPE,
  LINEBREAK,
  ADJACENT_PRIME,
  LINK,
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

/**
 * A bare URL, per typst's `link_prefix`.
 *
 * The character set is fixed, but `[]` and `()` must BALANCE — a closer with no matching
 * opener ends the link. That is what makes `[https://typst.app/docs]` work: the `]`
 * belongs to the enclosing content block, not the URL. A regex cannot balance, which is
 * why this lives here; the previous regex version swallowed the bracket and left the
 * content block unterminated.
 *
 * Trailing `! , . : ; ? '` are excluded so `see https://typst.app.` keeps its full stop
 * as prose. Marking the end only after characters that may legally finish a link gets
 * that for free.
 */
static bool scan_link_body(TSLexer *lexer) {
  lexer->mark_end(lexer);

  uint8_t stack[32];
  unsigned depth = 0;

  for (;;) {
    int32_t c = lexer->lookahead;
    bool ok;

    if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
      ok = true;
    } else {
      switch (c) {
        case '!': case '#': case '$': case '%': case '&': case '*': case '+':
        case ',': case '-': case '.': case '/': case ':': case ';': case '=':
        case '?': case '@': case '_': case '~': case '\'':
          ok = true;
          break;
        case '[': case '(':
          ok = depth < sizeof(stack);
          if (ok) stack[depth++] = (uint8_t)c;
          break;
        case ']':
          ok = depth > 0 && stack[depth - 1] == '[';
          if (ok) depth--;
          break;
        case ')':
          ok = depth > 0 && stack[depth - 1] == '(';
          if (ok) depth--;
          break;
        default:
          ok = false;
      }
    }
    if (!ok) break;

    advance(lexer);
    if (!(c == '!' || c == ',' || c == '.' || c == ':' || c == ';' || c == '?' ||
          c == '\'')) {
      lexer->mark_end(lexer);
    }
  }

  // Typst reports unbalanced brackets as an error; declining lets the parser do the same.
  if (depth != 0) return false;

  lexer->result_symbol = LINK;
  return true;
}

/**
 * Numbers, per typst's `Lexer::number`.
 *
 * This is in the scanner rather than the grammar because typst *validates* the token it
 * lexed, and a malformed number is a hard error rather than a shorter match. A regex
 * would silently split `123.456e` into the float `123.456` and the identifier `e`, and
 * `0b1010pt` into an integer and an identifier — both of which then parse happily as two
 * expressions, which is why they showed up as false accepts.
 *
 * Declining here makes the parser report an error exactly where typst does.
 *
 * Returns the token kind through `*kind_out`; the caller sets `result_symbol`.
 */
static bool scan_number(TSLexer *lexer, int32_t first, unsigned *kind_out) {
  char buf[64];
  unsigned len = 0;
  bool overflow = false;

#define PUSH(c) do { if (len < sizeof(buf) - 1) buf[len++] = (char)(c); else overflow = true; } while (0)

  unsigned base = 10;

  // `first` has already been consumed by the caller.
  PUSH(first);

  if (first == '0') {
    switch (lexer->lookahead) {
      case 'b': base = 2; break;
      case 'o': base = 8; break;
      case 'x': base = 16; break;
      default: break;
    }
    if (base != 10) {
      PUSH(lexer->lookahead);
      advance(lexer);
    }
  }

  // Digits. Hex takes any alphanumeric so that a bad digit lands inside the number and
  // is reported, rather than being split off as a separate identifier.
  if (base == 16) {
    while (iswalnum((wint_t)lexer->lookahead)) { PUSH(lexer->lookahead); advance(lexer); }
  } else {
    while (lexer->lookahead >= '0' && lexer->lookahead <= '9') {
      PUSH(lexer->lookahead);
      advance(lexer);
    }
  }

  bool is_float = (first == '.');
  bool exponent_digits = true;
  bool ended_early = false;

  // The suffix runs to the end of the alphanumeric run, so `1hello` is rejected whole
  // rather than becoming the integer `1` and an identifier.
  char suffix[16];
  unsigned slen = 0;

  if (base == 10) {
    if (!is_float && lexer->lookahead == '.') {
      // `1..2` is a spread and `1.method()` a field access, so the dot only belongs to
      // the number when neither follows. Deciding that needs a look past the dot, and
      // the lexer cannot rewind — so mark the end here first. If the dot turns out not
      // to be ours the token still ends before it, and `1` is returned as an integer.
      lexer->mark_end(lexer);
      advance(lexer);
      int32_t after = lexer->lookahead;
      if (after == '.' || iswalpha((wint_t)after) || after == '_') {
        // The number is finished. Nothing more can be consumed — we are already past
        // the dot — so jump straight to validation with the end marked before it.
        ended_early = true;
        goto finish;
      }
      is_float = true;
      PUSH('.');
      while (lexer->lookahead >= '0' && lexer->lookahead <= '9') {
        PUSH(lexer->lookahead);
        advance(lexer);
      }
    }

    // `1em` is a length, not an exponent. Those two characters belong to the suffix, so
    // they must not enter the number buffer — `1em` is Numeric, not Float.
    if (lexer->lookahead == 'e' || lexer->lookahead == 'E') {
      int32_t marker = lexer->lookahead;
      advance(lexer);
      if (marker == 'e' && lexer->lookahead == 'm') {
        suffix[slen++] = 'e';
        suffix[slen++] = 'm';
        advance(lexer);
      } else {
        is_float = true;
        PUSH(marker);
        if (lexer->lookahead == '+' || lexer->lookahead == '-') {
          PUSH(lexer->lookahead);
          advance(lexer);
        }
        exponent_digits = false;
        while (lexer->lookahead >= '0' && lexer->lookahead <= '9') {
          PUSH(lexer->lookahead);
          advance(lexer);
          exponent_digits = true;
        }
      }
    }
  }

  while (iswalnum((wint_t)lexer->lookahead) || lexer->lookahead == '%') {
    if (slen < sizeof(suffix) - 1) suffix[slen++] = (char)lexer->lookahead;
    else overflow = true;
    advance(lexer);
  }

finish:
  suffix[slen] = '\0';
  buf[len] = '\0';

  if (overflow) return false;

  // An incomplete exponent (`1e`, `2E+`) is not a number at all.
  if (!exponent_digits) return false;

  bool has_suffix = slen > 0;
  if (has_suffix) {
    static const char *const UNITS[] = {"pt", "mm", "cm", "in", "deg", "rad", "em", "fr", "%"};
    bool known = false;
    for (unsigned i = 0; i < sizeof(UNITS) / sizeof(UNITS[0]); i++) {
      if (strcmp(suffix, UNITS[i]) == 0) { known = true; break; }
    }
    if (!known) return false;
    // Only decimal numbers carry units: `0b1010pt` is an error in typst.
    if (base != 10) return false;
  }

  if (base != 10) {
    // Every digit must be legal for the base, and there must be at least one.
    if (len <= 2) return false;
    for (unsigned i = 2; i < len; i++) {
      unsigned d;
      char ch = buf[i];
      if (ch >= '0' && ch <= '9') d = (unsigned)(ch - '0');
      else if (ch >= 'a' && ch <= 'f') d = (unsigned)(ch - 'a' + 10);
      else if (ch >= 'A' && ch <= 'F') d = (unsigned)(ch - 'A' + 10);
      else return false;
      if (d >= base) return false;
    }
  }

  // A decimal integer too large for an i64 is a float in typst, not an error.
  if (base == 10 && !is_float && !has_suffix) {
    unsigned i = 0;
    while (i + 1 < len && buf[i] == '0') i++;
    unsigned digits = len - i;
    if (digits > 19 || (digits == 19 && strcmp(buf + i, "9223372036854775807") > 0)) {
      is_float = true;
    }
  }

  // When the scan stopped at a dot that turned out to belong to a field access, the end
  // is already marked before it and must not be extended.
  if (!ended_early) lexer->mark_end(lexer);
  *kind_out = has_suffix ? NUMBER_NUMERIC : (is_float ? NUMBER_FLOAT : NUMBER_INT);
  return true;

#undef PUSH
}

/*
 * Separating two expressions inside `{ }`.
 *
 * Typst's code loop demands a `;` or a line break after every expression, so `{ 1 2 }` is
 * an error. What counts as a line break is narrower than "contains a newline":
 *
 *   - A line comment gives one, because the newline that ends it is real trivia.
 *   - A *block* comment does not, even when it spans lines: typst emits it as a single
 *     trivia token, so two expressions with only a multi-line block comment between them
 *     are still an error. Its newlines are skipped over here rather than counted.
 *   - `.` and `else` carry the previous expression across a line break (typst's
 *     `AtNewline::ContextualContinue`), so `a\n.b()` is one method call and
 *     `if c {}\nelse {}` one conditional.
 *
 * Three outcomes rather than two. `SEP_NONE` means "no separator, and nothing but blanks
 * was consumed", which lets the caller fall through to the rest of the dispatch instead
 * of returning. That matters because `return` makes an expression's end coincide with the
 * start of another one: after `return`, both this token and a number are valid, and a
 * bare `return false` here would starve `return 0pt` of its numeric token entirely.
 */
typedef enum {
  SEP_NONE,       // not a separator; only blanks consumed, so the caller may continue
  SEP_YES,        // emit the separator
  SEP_CONTINUES,  // the expression carries on; decline outright
} SepVerdict;

static SepVerdict scan_code_sep(TSLexer *lexer) {
  bool newline = false;

  for (;;) {
    while (!lexer->eof(lexer) &&
           (lexer->lookahead == ' ' || lexer->lookahead == '\t' || lexer->lookahead == '\r')) {
      skip(lexer);
    }
    if (lexer->eof(lexer)) return SEP_YES;

    int32_t ch = lexer->lookahead;
    if (ch == '\n') { newline = true; skip(lexer); continue; }

    // The closing brace ends the block; its last expression needs no separator.
    if (ch == '}') return SEP_YES;

    if (ch == '/') {
      advance(lexer);
      if (lexer->lookahead == '/') {
        while (!lexer->eof(lexer) && lexer->lookahead != '\n') advance(lexer);
        continue;
      }
      if (lexer->lookahead == '*') {
        advance(lexer);
        unsigned depth = 1;
        int32_t prev = 0;
        while (depth > 0 && !lexer->eof(lexer)) {
          int32_t c2 = lexer->lookahead;
          advance(lexer);
          if (prev == '*' && c2 == '/') { depth--; prev = 0; }
          else if (prev == '/' && c2 == '*') { depth++; prev = 0; }
          else prev = c2;
        }
        continue;
      }
      // A bare `/` is division, which continues the expression on the same line but
      // cannot reach back across a line break.
      return newline ? SEP_YES : SEP_CONTINUES;
    }

    if (!newline) return SEP_NONE;

    if (ch == '.') {
      advance(lexer);
      // `.5` is a float, so only a field name continues the expression.
      if (iswalpha((wint_t)lexer->lookahead) || lexer->lookahead == '_') return SEP_CONTINUES;
      return SEP_YES;
    }
    if (ch == 'e' && eat_str(lexer, "else") && !is_id_continue(lexer->lookahead)) {
      return SEP_CONTINUES;
    }
    return SEP_YES;
  }
}

/*
 * `Lexer::escape`: `\` plus one character, or `\u{...}` with a codepoint that names a
 * real character. `\` before whitespace or end of file is a linebreak instead.
 *
 * Both live here rather than in the grammar, and they have to live here together. Typst
 * validates the codepoint, which a regex cannot do — `\u{FFFFFF}` is past the last one
 * and `\u{D800}` is a surrogate half, so neither is a character. Declining the escape is
 * only half of it: if the grammar still had a plain `\` token for the linebreak, the
 * backslash would match that and the invalid escape would parse anyway.
 *
 * Assumes the caller has checked that lookahead is a backslash.
 */
static bool scan_escape(TSLexer *lexer, const bool *valid_symbols) {
  advance(lexer);

  // `\` at the end of a line — or of the file — is a linebreak.
  if (lexer->eof(lexer) || is_space(lexer->lookahead)) {
    if (!valid_symbols[LINEBREAK]) return false;
    lexer->mark_end(lexer);
    lexer->result_symbol = LINEBREAK;
    return true;
  }

  if (!valid_symbols[ESCAPE]) return false;

  if (lexer->lookahead == 'u') {
    advance(lexer);
    // Only `\u{` begins a codepoint escape; a bare `\u` escapes the letter itself.
    if (lexer->lookahead == '{') {
      advance(lexer);

      // Typst reads the whole alphanumeric run and *then* parses it, so `\u{zz}` is a bad
      // codepoint rather than a `\u` escape followed by text.
      uint32_t cp = 0;
      bool any = false, bad = false;
      while (iswalnum((wint_t)lexer->lookahead)) {
        int32_t ch = lexer->lookahead;
        unsigned d;
        if (ch >= '0' && ch <= '9') d = (unsigned)(ch - '0');
        else if (ch >= 'a' && ch <= 'f') d = (unsigned)(ch - 'a' + 10);
        else if (ch >= 'A' && ch <= 'F') d = (unsigned)(ch - 'A' + 10);
        else { d = 0; bad = true; }
        if (cp > 0x10FFFF) bad = true;  // saturate rather than wrap
        else cp = cp * 16 + d;
        any = true;
        advance(lexer);
      }

      if (lexer->lookahead != '}') return false;  // unclosed
      advance(lexer);

      // Must name an actual character: in range, and not a surrogate half.
      if (!any || bad || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return false;

      lexer->mark_end(lexer);
      lexer->result_symbol = ESCAPE;
      return true;
    }
  } else {
    advance(lexer);
  }

  lexer->mark_end(lexer);
  lexer->result_symbol = ESCAPE;
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
   * Zero-width: a `'` follows with nothing in between, which is what makes it attach.
   * `a'` is a prime on `a`; `a '` is `a` and then a standalone prime.
   *
   * Checked before any whitespace is skipped, so "nothing in between" is simply whether
   * the very next character is the quote. Expressing it with `token.immediate` instead
   * would create a second token for `'`, and with both valid the lexer picks whichever
   * it likes — the same trap that defeated the math delimiters.
   */
  // Falls through rather than declining when the next character is not a quote. Nothing
  // has been consumed at this point, so continuing is safe — and necessary: returning
  // false here would be the scanner's answer for the whole call, starving every other
  // external token in math of its turn. That is what broke `$a \ b$`, where the prime is
  // valid after `a` and the linebreak never got asked.
  if (valid_symbols[ADJACENT_PRIME] && !lexer->eof(lexer) && lexer->lookahead == '\'') {
    lexer->mark_end(lexer);
    lexer->result_symbol = ADJACENT_PRIME;
    return true;
  }

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

  // Decided before any whitespace is skipped, like the terminators above, so the
  // zero-width token lands at the true end of the expression it closes.
  if (valid_symbols[CODE_SEP]) {
    lexer->mark_end(lexer);
    switch (scan_code_sep(lexer)) {
      case SEP_YES:       lexer->result_symbol = CODE_SEP; return true;
      case SEP_CONTINUES: return false;
      case SEP_NONE:      break;  // only blanks consumed; carry on with the dispatch
    }
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
   * Numbers. Typst validates the token it lexed rather than backing off to a shorter
   * match, so a malformed number has to be *declined* here — see `scan_number`.
   */
  if (valid_symbols[NUMBER_INT] || valid_symbols[NUMBER_FLOAT] ||
      valid_symbols[NUMBER_NUMERIC]) {
    int32_t first = lexer->lookahead;
    bool start = first >= '0' && first <= '9';
    if (!start && first == '.') {
      // Only `.5` is a number; a bare `.` is field access, which the grammar owns.
      advance(lexer);
      if (lexer->lookahead < '0' || lexer->lookahead > '9') return false;
      start = true;
    } else if (start) {
      advance(lexer);
    }
    if (start) {
      unsigned kind = 0;
      if (!scan_number(lexer, first, &kind)) return false;
      // Declining when the grammar did not ask for this particular kind keeps the
      // number out of positions that only accept, say, an integer.
      if (!valid_symbols[kind]) return false;
      lexer->result_symbol = (enum TokenType)kind;
      return true;
    }
  }

  int32_t c = lexer->lookahead;
  uint32_t column = lexer->get_column(lexer);
  bool at_line_start = saw_newline || column == 0;


  if (lexer->eof(lexer)) return false;

  if (valid_symbols[RAW_DELIM] && c == '`') return scan_raw_open(lexer, scanner);

  /*
   * A word starting with `h` might be a URL. If the scheme does not pan out, whatever we
   * consumed is ordinary text and the run simply continues — returning false here
   * instead would leave `here.` with no token at all, since TEXT never gets its turn.
   */
  if (valid_symbols[LINK] && c == 'h') {
    if (eat_str(lexer, "http")) {
      if (lexer->lookahead == 's') advance(lexer);
      if (eat_str(lexer, "://")) return scan_link_body(lexer);
    }
    if (!valid_symbols[TEXT]) return false;
    return scan_text(lexer, true);
  }

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

    /*
     * `Lexer::block_comment`: block comments nest, so the first inner terminator does not
     * close the outer one. Nesting is not regular, so the depth is counted here.
     *
     * This has to live inside the `/` dispatch rather than in a check of its own. A
     * scanner cannot rewind, so an earlier check that consumed the `/` and then declined
     * would leave every other `/` token — the term-item marker, division, a slash inside
     * a text run — with no way to be produced at all.
     */
    if (lexer->lookahead == '*') {
      if (!valid_symbols[BLOCK_COMMENT]) return false;
      advance(lexer);

      unsigned depth = 1;
      int32_t prev = 0;
      while (depth > 0) {
        // Unterminated is not an error in typst; the comment just runs to end of file.
        if (lexer->eof(lexer)) break;
        int32_t ch = lexer->lookahead;
        advance(lexer);
        // A shared character cannot both close one level and open the next.
        if (prev == '*' && ch == '/') { depth--; prev = 0; }
        else if (prev == '/' && ch == '*') { depth++; prev = 0; }
        else prev = ch;
      }

      lexer->mark_end(lexer);
      lexer->result_symbol = BLOCK_COMMENT;
      return true;
    }

    // `//` opens a line comment, which the built-in lexer matches. Bailing out lets it;
    // returning false discards what we consumed either way.
    if (lexer->lookahead == '/') return false;
    if (at_space_or_end(lexer)) {
      return emit_marker_or_text(lexer, TERM_MARKER, valid_symbols,
                                 at_line_start);
    }
    if (!valid_symbols[TEXT]) return false;
    return scan_text(lexer, true);
  }

  // `\` is either an escape or a linebreak, and only the scanner can tell which — see
  // `scan_escape`. Checked before the text fallback because `\` ends a text run.
  if (c == '\\' && (valid_symbols[ESCAPE] || valid_symbols[LINEBREAK])) {
    return scan_escape(lexer, valid_symbols);
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
