//! Opt-in debug logging: one line per attempt with the method, the URL's
//! path, the attempt number, the status (or what failed), the elapsed time,
//! the retry decision and wait, and the request id. Never the API key, a
//! header, the query string or a body. The format is the same in every
//! Keenable SDK: scripts/conformance/README.md.
//!
//! Each line goes to the [`log`] facade at debug level with the target
//! `keenable`, so an application's logger (env_logger, tracing-log, ...)
//! picks it up. `KEENABLE_LOG=debug` also prints it to stderr, for when no
//! logger is installed. `log` is already in the dependency tree through
//! reqwest, so this adds no crate.

use std::time::Instant;

use crate::error::Error;

/// The longest request id logged; a longer one is left out.
const MAX_REQUEST_ID: usize = 128;

/// What one attempt did.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct AttemptLog<'a> {
    pub(crate) method: &'a str,
    pub(crate) path: &'a str,
    /// 1 for the first attempt.
    pub(crate) attempt: u32,
    /// The HTTP status, when one counts.
    pub(crate) status: Option<u16>,
    /// What failed when there is no status: timeout, redirect or connection.
    pub(crate) error: Option<&'a str>,
    pub(crate) elapsed_ms: u128,
    /// The wait before the next attempt, when it is retried.
    pub(crate) wait_ms: Option<u128>,
    pub(crate) request_id: Option<&'a str>,
}

/// Whether a `KEENABLE_LOG` value turns debug logging on: `debug`, trimmed,
/// in any letter case.
pub(crate) fn env_enabled(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case("debug")
}

/// Whether `KEENABLE_LOG` asks for debug lines on stderr.
pub(crate) fn stderr_from_env() -> bool {
    std::env::var("KEENABLE_LOG").is_ok_and(|v| env_enabled(&v))
}

fn loggable_id(id: Option<&str>) -> Option<&str> {
    id.filter(|id| {
        !id.is_empty()
            && id.len() <= MAX_REQUEST_ID
            && id.bytes().all(|b| (0x21..=0x7e).contains(&b))
    })
}

/// One attempt's line, after the `keenable: ` prefix.
pub(crate) fn fields(a: &AttemptLog<'_>) -> String {
    let mut line = format!("method={} path={} attempt={}", a.method, a.path, a.attempt);
    match a.status {
        Some(status) => line.push_str(&format!(" status={status}")),
        None => line.push_str(&format!(" error={}", a.error.unwrap_or("connection"))),
    }
    line.push_str(&format!(" elapsed_ms={}", a.elapsed_ms));
    match a.wait_ms {
        Some(wait) => line.push_str(&format!(" retry=true wait_ms={wait}")),
        None => line.push_str(" retry=false"),
    }
    if let Some(id) = loggable_id(a.request_id) {
        line.push_str(&format!(" request_id={id}"));
    }
    line
}

/// A failed attempt's status, or what failed instead, and its request id.
pub(crate) fn failure(err: &Error) -> (Option<u16>, Option<&'static str>, Option<&str>) {
    if let Some(api) = err.api_error() {
        return (Some(api.status_code), None, api.request_id.as_deref());
    }
    match err {
        Error::Connection(c) if c.timeout => (None, Some("timeout"), None),
        Error::Connection(c) if c.redirect => (None, Some("redirect"), None),
        _ => (None, Some("connection"), None),
    }
}

/// Whether anything takes the lines: the `log` facade at debug level for the
/// `keenable` target, or stderr.
pub(crate) fn wanted(stderr: bool) -> bool {
    stderr || recording() || log::log_enabled!(target: "keenable", log::Level::Debug)
}

/// Logs one attempt. `started` is when it began.
pub(crate) fn emit(stderr: bool, mut a: AttemptLog<'_>, started: Instant) {
    a.elapsed_ms = started.elapsed().as_millis();
    let line = fields(&a);
    log::debug!(target: "keenable", "{line}");
    #[cfg(test)]
    if crate::test_hooks::record_log(&line) {
        return;
    }
    if stderr {
        eprintln!("keenable: {line}");
    }
}

#[cfg(test)]
fn recording() -> bool {
    crate::test_hooks::recording_logs()
}

#[cfg(not(test))]
fn recording() -> bool {
    false
}
