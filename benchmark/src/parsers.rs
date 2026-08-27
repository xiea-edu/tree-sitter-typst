use anyhow::{Context, Result};
use tree_sitter::{Language, Parser};
use tree_sitter_language::LanguageFn;

unsafe extern "C" {
    fn tree_sitter_typst_local() -> *const ();
    fn tree_sitter_typst_uben0() -> *const ();
    fn tree_sitter_typst_seniormars() -> *const ();
}

const LOCAL: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_typst_local) };
const UBEN0: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_typst_uben0) };
const SENIORMARS: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_typst_seniormars) };

#[derive(Clone, Copy)]
pub struct ParserDef {
    pub name: &'static str,
    language_fn: LanguageFn,
}

impl ParserDef {
    pub fn language(self) -> Language {
        self.language_fn.into()
    }

    pub fn parser(self) -> Result<Parser> {
        let mut parser = Parser::new();
        parser
            .set_language(&self.language())
            .with_context(|| format!("failed to load {} parser", self.name))?;
        Ok(parser)
    }
}

pub const PARSERS: [ParserDef; 3] = [
    ParserDef {
        name: "local",
        language_fn: LOCAL,
    },
    ParserDef {
        name: "uben0",
        language_fn: UBEN0,
    },
    ParserDef {
        name: "seniormars",
        language_fn: SENIORMARS,
    },
];
