; Highlighting for Typst.
;
; Capture names follow the tree-sitter standard that stock Neovim consumes, so this file
; works without any per-editor translation. Later patterns win in Neovim, so the general
; rules come first and the specific ones after.

; ---------------------------------------------------------------------------
; markup
; ---------------------------------------------------------------------------

(text) @markup

(linebreak) @string.escape
(escape) @string.escape
(shorthand) @string.special
(smart_quote) @punctuation.special

(strong) @markup.strong
(emph) @markup.italic

; Heading level comes from the marker's length. Neovim styles the six levels
; differently, so matching them separately is what makes a document's outline readable.
(heading (heading_marker) @markup.heading)

((heading (heading_marker) @markup.heading.1)
  (#eq? @markup.heading.1 "="))
((heading (heading_marker) @markup.heading.2)
  (#eq? @markup.heading.2 "=="))
((heading (heading_marker) @markup.heading.3)
  (#eq? @markup.heading.3 "==="))
((heading (heading_marker) @markup.heading.4)
  (#eq? @markup.heading.4 "===="))
((heading (heading_marker) @markup.heading.5)
  (#eq? @markup.heading.5 "====="))
((heading (heading_marker) @markup.heading.6)
  (#eq? @markup.heading.6 "======"))

(list_marker) @markup.list
(enum_marker) @markup.list
(term_marker) @markup.list
(term_item ":" @punctuation.delimiter)

(label) @label
(ref) @markup.link
(ref_marker) @markup.link.label
(link) @markup.link.url

; ---------------------------------------------------------------------------
; raw
; ---------------------------------------------------------------------------

(raw) @markup.raw
(raw_delim) @punctuation.delimiter
(raw_lang) @attribute

; A fenced block, as opposed to inline `code`. Neovim gives the block form its own
; background, which is what visually separates a code listing from surrounding prose.
((raw . (raw_delim) @_d) @markup.raw.block
  (#match? @_d "^```"))

; ---------------------------------------------------------------------------
; math
; ---------------------------------------------------------------------------

(equation) @markup.math

(math_ident) @function.builtin
(math_text) @markup.math
(math_shorthand) @operator
(math_align_point) @punctuation.special
(math_primes) @operator
(math_attach ["^" "_"] @operator)
(math_frac "/" @operator)
(math_root ["√" "∛" "∜"] @operator)
(math_call item: (math_ident) @function)
(math_field_access (math_ident) @function.builtin)

; ---------------------------------------------------------------------------
; code — literals
; ---------------------------------------------------------------------------

(none) @constant.builtin
(auto) @constant.builtin
(bool) @boolean
(int) @number
(float) @number.float
(numeric) @number
(str) @string

; ---------------------------------------------------------------------------
; code — names
; ---------------------------------------------------------------------------

(ident) @variable
(field_access field: (ident) @variable.member)
(named name: (ident) @variable.member)
(params (ident) @variable.parameter)
(params (named name: (ident) @variable.parameter))

(func_call item: (ident) @function.call)
(func_call item: (field_access field: (ident) @function.call))

(let_binding pattern: (ident) @variable)
(closure name: (ident) @function)
(set_rule target: (ident) @function)
(set_rule target: (field_access field: (ident) @function))
(show_rule selector: (ident) @function)

; ---------------------------------------------------------------------------
; code — keywords and operators
; ---------------------------------------------------------------------------

[
  "let"
  "set"
  "show"
  "context"
] @keyword

[
  "if"
  "else"
] @keyword.conditional

[
  "while"
  "for"
  "in"
] @keyword.repeat

; `break` and `continue` are named nodes here, not bare tokens, because typst gives them
; their own kinds (LoopBreak, LoopContinue).
[
  (loop_break)
  (loop_continue)
] @keyword.repeat

"return" @keyword.return

[
  "import"
  "include"
  "as"
] @keyword.import

[
  "+"
  "-"
  "*"
  "/"
  "="
  "=="
  "!="
  "<"
  "<="
  ">"
  ">="
  "+="
  "-="
  "*="
  "/="
  ".."
  "=>"
] @operator

[
  "and"
  "or"
  "not"
] @keyword.operator

(underscore) @variable.parameter.builtin

; ---------------------------------------------------------------------------
; punctuation
; ---------------------------------------------------------------------------

[
  "("
  ")"
  "["
  "]"
  "{"
  "}"
] @punctuation.bracket

[
  ","
  ";"
  ":"
  "."
] @punctuation.delimiter

"#" @punctuation.special
(equation ["$" "$"] @punctuation.special)

; ---------------------------------------------------------------------------
; comments
; ---------------------------------------------------------------------------

[
  (shebang)
  (line_comment)
  (block_comment)
] @comment @spell
