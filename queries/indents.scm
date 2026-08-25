; Indentation, for Neovim's treesitter indent module.

[
  (code_block)
  (content_block)
  (array)
  (dict)
  (args)
  (params)
  (import_items)
] @indent.begin

[
  ")"
  "]"
  "}"
] @indent.branch

[
  ")"
  "]"
  "}"
] @indent.end

; A comment should keep the indentation of its surroundings rather than forcing its own.
(line_comment) @indent.auto
(block_comment) @indent.auto
