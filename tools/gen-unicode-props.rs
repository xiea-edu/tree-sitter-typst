//! Emits the Unicode range tables that `src/scanner.c` uses for character classification.
//!
//! The scanner used to call `iswalnum`/`iswalpha`/`iswspace` from <wctype.h>. Those are
//! locale-dependent: in the default "C" locale glibc and macOS libc answer "no" for every
//! non-ASCII code point, while Windows' UCRT consults a built-in table. That split made
//! the same input parse differently per platform — a text run broke at every space
//! before an Arabic or Hebrew word on Linux but not on Windows.
//!
//! typst decides these questions with `char::is_alphanumeric`, `char::is_alphabetic` and
//! `char::is_whitespace`, so the tables are generated from those very functions. Building
//! the table with the same std that typst-syntax compiles against makes the two agree by
//! construction rather than by transcription.
//!
//! Regenerate with:
//!     rustc -O tools/gen-unicode-props.rs -o <tmp>/gen && <tmp>/gen
//! and paste the output over the generated block in src/scanner.c.

fn ranges(pred: impl Fn(char) -> bool) -> Vec<(u32, u32)> {
    let mut out: Vec<(u32, u32)> = Vec::new();
    for cp in 0u32..=0x10FFFF {
        // Surrogates are not scalar values; a UTF-8 decoder never yields one.
        let hit = char::from_u32(cp).map_or(false, &pred);
        if hit {
            match out.last_mut() {
                Some(last) if last.1 + 1 == cp => last.1 = cp,
                _ => out.push((cp, cp)),
            }
        }
    }
    out
}

fn emit(name: &str, doc: &str, rs: &[(u32, u32)]) {
    println!("/* {} */", doc);
    println!("static const uint32_t {}[][2] = {{", name);
    for chunk in rs.chunks(4) {
        let cells: Vec<String> = chunk
            .iter()
            .map(|(a, b)| format!("{{0x{:04X},0x{:04X}}}", a, b))
            .collect();
        println!("  {},", cells.join(", "));
    }
    println!("}};\n");
}

fn main() {
    // Only non-ASCII goes in the tables; the scanner answers ASCII with a direct test.
    let alpha = ranges(|c| c.is_alphabetic() && c as u32 > 127);
    let numeric = ranges(|c| c.is_numeric() && c as u32 > 127);
    let space = ranges(|c| c.is_whitespace() && c as u32 > 127);

    eprintln!(
        "alpha {} ranges, numeric {} ranges, space {} ranges",
        alpha.len(),
        numeric.len(),
        space.len()
    );

    emit("UC_ALPHA", "Unicode Alphabetic, non-ASCII (rust `char::is_alphabetic`)", &alpha);
    emit("UC_NUMERIC", "Unicode Nd/Nl/No, non-ASCII (rust `char::is_numeric`)", &numeric);
    emit("UC_SPACE", "Unicode White_Space, non-ASCII (rust `char::is_whitespace`)", &space);
}
