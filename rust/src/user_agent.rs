//! The User-Agent the client sends: `keenable-rust/<VERSION> <os>/<arch>`,
//! for example `keenable-rust/0.4.0 linux/x86_64`, from
//! `std::env::consts::{OS, ARCH}`. The compiler version is not sent: it is
//! not known without a build script. Nothing else is sent: no host name,
//! user, path, key or locale. A caller's `User-Agent` in `Options::headers`
//! or `RequestOptions::headers` replaces it. The formatting rule is shared
//! with the other SDKs (scripts/conformance/README.md).

use std::sync::LazyLock;

use crate::VERSION;

const MAX_PART: usize = 64;

/// The User-Agent for this build, worked out once.
pub(crate) static USER_AGENT: LazyLock<String> = LazyLock::new(|| {
    format_user_agent(&[
        ("keenable-rust", VERSION),
        (std::env::consts::OS, std::env::consts::ARCH),
    ])
});

fn allowed(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-')
}

/// Every run of characters other than ASCII letters, digits, `.`, `_`, `+`
/// and `-` becomes one `-`; the result is cut to 64 characters, then leading
/// and trailing `-` are dropped.
fn clean(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut dash = false;
    for c in text.chars() {
        if allowed(c) {
            out.push(c);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    // Only ASCII is left, so a byte index is a character index.
    out.truncate(MAX_PART);
    out.trim_matches('-').to_string()
}

/// `name/version` per part, space-separated, each half cleaned. A part whose
/// name cleans to nothing is left out; one whose version cleans to nothing
/// is its name alone.
pub(crate) fn format_user_agent(parts: &[(&str, &str)]) -> String {
    parts
        .iter()
        .filter_map(|(name, version)| {
            let (name, version) = (clean(name), clean(version));
            match (name.is_empty(), version.is_empty()) {
                (true, _) => None,
                (false, true) => Some(name),
                (false, false) => Some(format!("{name}/{version}")),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
