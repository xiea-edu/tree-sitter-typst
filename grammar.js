/**
 * @file Tree-sitter grammar for the Typst markup language
 * @license MIT
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

module.exports = grammar({
  name: 'typst',

  rules: {
    source_file: $ => repeat($._markup_expr),

    _markup_expr: $ => choice(
      $.text,
      $.space,
    ),

    text: _ => /[^\s]+/,
    space: _ => /\s+/,
  },
});
