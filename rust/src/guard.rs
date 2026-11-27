//! Checks on the URLs the client talks to: the base URL the API key is sent
//! to, and the pages `fetch` may ask for. The rules are the same in every
//! SDK: scripts/conformance/README.md.

use std::net::{Ipv4Addr, Ipv6Addr};

use url::{Host, Url};

use crate::error::{Error, Result};

const LOCAL_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "::1"];
const BLOCKED_HOSTS: [&str; 2] = ["localhost", "metadata.google.internal"];

/// The text between `scheme://` and the path, query or fragment, as written.
fn written_authority(raw: &str) -> &str {
    let Some(sep) = raw.find("://") else {
        return "";
    };
    let scheme = &raw[..sep];
    let mut chars = scheme.chars();
    let valid = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    if !valid {
        return "";
    }
    let rest = &raw[sep + 3..];
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    &rest[..end]
}

/// The host as written, before a WHATWG parser rewrites it, without the
/// port, IPv6 brackets or one trailing dot, lowercased.
fn written_host(raw: &str) -> String {
    let host = written_authority(raw);
    let cut = if host.starts_with('[') {
        host.find(']').map_or(0, |i| i + 1)
    } else {
        host.rfind(':').unwrap_or(0)
    };
    let bare = if cut > 0 { &host[..cut] } else { host };
    let bare = bare.to_ascii_lowercase();
    let bare = bare.trim_start_matches('[').trim_end_matches(']');
    bare.strip_suffix('.').unwrap_or(bare).to_string()
}

/// The parsed host in one form: lowercased, without IPv6 brackets or trailing
/// dots.
fn parsed_host(url: &Url) -> String {
    let host = match url.host() {
        Some(Host::Ipv6(addr)) => addr.to_string(),
        Some(Host::Ipv4(addr)) => addr.to_string(),
        Some(Host::Domain(d)) => d.to_ascii_lowercase(),
        None => String::new(),
    };
    host.trim_end_matches('.').to_string()
}

/// Checks and normalises a base URL: surrounding whitespace and trailing
/// slashes dropped; `https`, or `http` to localhost, 127.0.0.1 or ::1; a host
/// and no query, fragment, user name, password or backslash before the path.
pub(crate) fn resolve_base_url(explicit: Option<&str>) -> Result<String> {
    let env = std::env::var("KEENABLE_API_URL")
        .ok()
        .filter(|v| !v.trim().is_empty());
    let raw = explicit
        .map(str::to_string)
        .or(env)
        .unwrap_or_else(|| crate::DEFAULT_BASE_URL.to_string());
    let raw = raw.trim().trim_end_matches('/').to_string();
    if raw.is_empty() {
        return Err(
            Error::invalid(r#"base_url must be an https:// URL with a host, got """#)
                .with_param("base_url"),
        );
    }
    // The endpoint path is appended to the base URL, so a query or fragment
    // would swallow it.
    if raw.contains('?') || raw.contains('#') {
        return Err(Error::invalid(format!(
            "base_url must be an https:// URL with a host and no query or fragment, got {raw:?}"
        ))
        .with_param("base_url"));
    }
    let parsed = Url::parse(&raw).map_err(|_| {
        Error::invalid(format!(
            "base_url must be an https:// URL with a host, got {raw:?}"
        ))
        .with_param("base_url")
    })?;
    // The API key is sent to this host. A backslash makes URL parsers disagree
    // on which host that is (http://evil.example\@localhost is evil.example to
    // a WHATWG parser), and a user name or password has no use here.
    let authority = written_authority(&raw);
    if authority.contains('\\')
        || authority.contains('@')
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(Error::invalid(
            "base_url must not contain a backslash, user name or password before its path. \
             Pass an https:// URL with only a host, an optional port and an optional path.",
        )
        .with_param("base_url"));
    }
    if parsed.host().is_none() || authority.is_empty() {
        return Err(Error::invalid(format!(
            "base_url must be an https:// URL with a host, got {raw:?}"
        ))
        .with_param("base_url"));
    }
    // The host as written must be one of the three plain spellings (a WHATWG
    // parser reads 127.1 as 127.0.0.1), and the parsed host must agree.
    let local = LOCAL_HOSTS.contains(&written_host(&raw).as_str())
        && LOCAL_HOSTS.contains(&parsed_host(&parsed).as_str());
    match parsed.scheme() {
        "https" => Ok(raw),
        "http" if local => Ok(raw),
        _ => Err(Error::invalid(format!(
            "base_url must use https (http is only allowed for localhost, 127.0.0.1, and ::1), got {raw:?}"
        )).with_param("base_url")),
    }
}

/// Refuses obviously internal fetch targets before a request leaves the
/// process. The API enforces this too; stopping here keeps an internal
/// hostname out of an outbound request.
pub(crate) fn reject_private_fetch_target(raw: &str) -> Result<()> {
    let not_http = || {
        Error::invalid(format!(
            "fetch() needs an http(s) URL, got {raw:?}. Use an https URL on the public internet."
        ))
        .with_param("url")
    };
    // Parsers disagree on what control characters and surrounding spaces
    // mean (WHATWG deletes a tab, others refuse it), so none is accepted.
    if raw.chars().any(|c| c < '\u{20}' || c == '\u{7f}') || raw.trim_matches(' ') != raw {
        return Err(not_http());
    }
    // Exactly "scheme://": a WHATWG parser reads https:host, https:/host and
    // https:///host all as https://host/, which other parsers read as hostless.
    let Some(sep) = raw.find("://") else {
        return Err(not_http());
    };
    let scheme = &raw[..sep];
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err(not_http());
    }
    let authority = written_authority(raw);
    // A WHATWG parser reads a backslash as a slash and RFC 3986 parsers do
    // not, so they would disagree on the host.
    if authority.contains('\\') {
        return Err(Error::invalid(format!(
            "fetch() URL has a backslash in its host: {raw:?}. Pass an https URL with a public host."
        )).with_param("url"));
    }
    let no_host = || {
        Error::invalid(format!(
            "fetch() URL has no host: {raw:?}. Pass an https URL with a public host."
        ))
        .with_param("url")
    };
    if authority.is_empty() {
        return Err(no_host());
    }
    let parsed = Url::parse(raw).map_err(|_| not_http())?;
    let host = parsed_host(&parsed);
    if host.is_empty() {
        return Err(no_host());
    }
    match parsed.host() {
        Some(Host::Domain(domain)) => {
            // One trailing dot is the root label. Any other empty label (a..b,
            // .a, a..) is read differently by resolvers and URL parsers.
            let name = domain.strip_suffix('.').unwrap_or(domain);
            if name.split('.').any(str::is_empty) {
                return Err(Error::invalid(format!(
                    "fetch() URL has an empty label in its host (two dots in a row, or a leading dot): {raw:?}. \
                     Pass an https URL with a public host."
                )).with_param("url"));
            }
            if BLOCKED_HOSTS.contains(&host.as_str()) || host.ends_with(".localhost") {
                return Err(Error::invalid(format!(
                    "refusing to fetch internal host {host:?}. Pass a public http(s) URL."
                ))
                .with_param("url"));
            }
            Ok(())
        }
        Some(Host::Ipv4(addr)) if blocked_ipv4(addr) => Err(private(&host)),
        Some(Host::Ipv6(addr)) if blocked_ipv6(addr) => Err(private(&host)),
        Some(_) => Ok(()),
        None => Err(no_host()),
    }
}

fn private(host: &str) -> Error {
    Error::invalid(format!(
        "refusing to fetch private address {host:?}. Pass a public http(s) URL."
    ))
    .with_param("url")
}

/// The IPv4 ranges fetch() refuses: this network, private, carrier-grade NAT
/// (where some clouds keep their metadata service), loopback, link-local,
/// IETF assignments, documentation, benchmarking, multicast and reserved. The
/// list is explicit, and the same in every SDK, because each standard library
/// draws "private" differently.
const BLOCKED_IPV4: [([u8; 4], u32); 14] = [
    ([0, 0, 0, 0], 8),
    ([10, 0, 0, 0], 8),
    ([100, 64, 0, 0], 10),
    ([127, 0, 0, 0], 8),
    ([169, 254, 0, 0], 16),
    ([172, 16, 0, 0], 12),
    ([192, 0, 0, 0], 24),
    ([192, 0, 2, 0], 24),
    ([192, 168, 0, 0], 16),
    ([198, 18, 0, 0], 15),
    ([198, 51, 100, 0], 24),
    ([203, 0, 113, 0], 24),
    ([224, 0, 0, 0], 4),
    ([240, 0, 0, 0], 4),
];

fn blocked_ipv4(addr: Ipv4Addr) -> bool {
    let value = u32::from(addr);
    BLOCKED_IPV4.iter().any(|(first, bits)| {
        let mask = u32::MAX << (32 - bits);
        value & mask == u32::from_be_bytes(*first)
    })
}

/// An IPv4-mapped address is judged by its IPv4 address. Any other address
/// must be global unicast (2000::/3) and outside 2001::/23, 2001:db8::/32,
/// 2002::/16 and 3fff::/20.
fn blocked_ipv6(addr: Ipv6Addr) -> bool {
    let g = addr.segments();
    if g[..5].iter().all(|&n| n == 0) && g[5] == 0xffff {
        let [a, b] = g[6].to_be_bytes();
        let [c, d] = g[7].to_be_bytes();
        return blocked_ipv4(Ipv4Addr::new(a, b, c, d));
    }
    (g[0] & 0xe000) != 0x2000
        || (g[0] == 0x2001 && (g[1] & 0xfe00) == 0)
        || (g[0] == 0x2001 && g[1] == 0x0db8)
        || g[0] == 0x2002
        || (g[0] == 0x3fff && (g[1] & 0xf000) == 0)
}
