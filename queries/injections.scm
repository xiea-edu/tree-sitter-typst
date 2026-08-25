; Embedded-language highlighting inside raw blocks.
;
; This is why the scanner emits a raw block as delimiter / language tag / content rather
; than one opaque token: the tag names the language and the content is the region to hand
; to it, and a query needs both as separate nodes.

; ```rust … ``` — the tag names the language directly.
((raw
   (raw_lang) @injection.language
   (raw_content) @injection.content)
  (#set! injection.include-children))

; Comments sometimes carry a directive of their own, e.g. `// language=json`.
((line_comment) @injection.content
  (#set! injection.language "comment"))

((block_comment) @injection.content
  (#set! injection.language "comment"))
