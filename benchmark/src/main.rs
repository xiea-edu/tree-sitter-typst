mod accuracy;
mod mapping;
mod model;
mod parsers;
mod speed;
mod util;

use anyhow::{Context, Result, bail};
use std::env;
use std::path::PathBuf;

fn main() -> Result<()> {
    let mut args = env::args().skip(1);
    let Some(command) = args.next() else {
        bail!("usage: typst-parser-benchmark <accuracy|speed> ...");
    };
    match command.as_str() {
        "accuracy" => {
            let manifest = required_path(args.next(), "manifest")?;
            let corpus = required_path(args.next(), "corpus root")?;
            let output = required_path(args.next(), "output")?;
            accuracy::run(&manifest, &corpus, &output)
        }
        "speed" => {
            let manifest = required_path(args.next(), "manifest")?;
            let corpus = required_path(args.next(), "corpus root")?;
            let accuracy = required_path(args.next(), "accuracy result")?;
            let output = required_path(args.next(), "output")?;
            speed::run(&manifest, &corpus, &accuracy, &output)
        }
        other => bail!("unknown command: {other}"),
    }
}

fn required_path(value: Option<String>, label: &str) -> Result<PathBuf> {
    value
        .map(PathBuf::from)
        .with_context(|| format!("missing {label} path"))
}
