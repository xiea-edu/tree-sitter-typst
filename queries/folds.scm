; Foldable regions.
;
; Headings are not listed: a heading node covers only its own line, so folding it would
; collapse nothing. Folding a section would need the heading to span until the next one
; of equal or lower level, which is a document-outline notion rather than a syntactic one.

[
  (code_block)
  (content_block)
  (raw)
  (equation)
  (array)
  (dict)
  (args)
  (params)
  (closure)
  (conditional)
  (while_loop)
  (for_loop)
  (import_items)
] @fold
