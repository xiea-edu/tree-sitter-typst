; Scopes and bindings, used for rename, reference highlighting and scope-aware
; highlighting of variables.

[
  (code_block)
  (content_block)
  (closure)
  (for_loop)
  (while_loop)
  (conditional)
] @local.scope

; `let x = …`, `let (a, b) = …`, `let f(x) = …`
(let_binding pattern: (ident) @local.definition.var)
(let_binding (destructuring (ident) @local.definition.var))
(closure name: (ident) @local.definition.function)

; Parameters, including defaulted ones.
(params (ident) @local.definition.parameter)
(params (named name: (ident) @local.definition.parameter))
(params (spread (ident) @local.definition.parameter))

; `for x in …` binds its pattern.
(for_loop pattern: (ident) @local.definition.var)
(for_loop pattern: (destructuring (ident) @local.definition.var))

; Imported names become bindings in the importing file.
(import_item_path (ident) @local.definition.import)
(renamed_import_item new_name: (ident) @local.definition.import)
(module_import alias: (ident) @local.definition.import)

(ident) @local.reference
