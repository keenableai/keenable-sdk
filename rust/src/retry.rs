//! When to retry, and how long to wait. The rules are the same in every SDK:
//! scripts/conformance/README.md.

use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use regex::Regex;

use crate::error::Error;

const INITIAL_RETRY_DELAY: Duration = Duration::from_millis(500);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(8);
/// The longest server-requested wait that is waited out. A longer one, such
/// as the keyless hourly cap, is returned at once.
const MAX_RETRY_AFTER_WAIT: Duration = Duration::from_secs(60);
/// The cap on any server-requested delay: a year.
pub(crate) const MAX_RETRY_AFTER: Duration = Duration::from_secs(365 * 24 * 60 * 60);

/// The wait before retry number `retry` (0 for the first): 0.5 s doubling up
/// to 8 s, shortened by up to 25% of jitter (`jitter` in [0, 1)) so clients
/// that failed together do not retry together.
pub(crate) fn backoff(retry: u32, jitter: f64) -> Duration {
    let base = if retry < 5 {
        (INITIAL_RETRY_DELAY * (1 << retry)).min(MAX_RETRY_DELAY)
    } else {
        MAX_RETRY_DELAY
    };
    base.mul_f64(1.0 - 0.25 * jitter)
}

/// How long to wait before retrying after `err`, or `None` when it should not
/// be retried. The API's `retryable` decides when it sent one; otherwise
/// 408, 429 and 5xx are retried, and so are network failures and timeouts. A
/// Retry-After over a minute is not waited out. A redirect is never retried.
pub(crate) fn retry_delay(err: &Error, retry: u32, jitter: f64) -> Option<Duration> {
    if let Some(api) = err.api_error() {
        let status = api.status_code;
        let retryable = api
            .retryable
            .unwrap_or(status == 408 || status == 429 || status >= 500);
        if !retryable {
            return None;
        }
        return match api.retry_after {
            Some(wait) if wait > MAX_RETRY_AFTER_WAIT => None,
            Some(wait) => Some(wait),
            None => Some(backoff(retry, jitter)),
        };
    }
    match err {
        Error::Connection(conn) if !conn.redirect => Some(backoff(retry, jitter)),
        _ => None,
    }
}

/// A delay in seconds from a JSON number: finite, at least 0, capped at a year.
pub(crate) fn seconds(n: f64) -> Option<Duration> {
    if !n.is_finite() || n < 0.0 {
        return None;
    }
    if n > MAX_RETRY_AFTER.as_secs_f64() {
        return Some(MAX_RETRY_AFTER);
    }
    Some(Duration::from_secs_f64(n))
}

/// Parses a Retry-After header as of now.
pub(crate) fn retry_after_header(value: &str) -> Option<Duration> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    retry_after_at(value, now)
}

/// Parses a Retry-After header as of `now` (Unix seconds): delay-seconds, or
/// one of the three RFC 9110 HTTP-date forms in GMT. Anything else is no
/// value, so the next source of the delay is used.
pub(crate) fn retry_after_at(value: &str, now: f64) -> Option<Duration> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if value.bytes().all(|b| b.is_ascii_digit()) {
        // All digits: a delay, however many there are, capped at a year.
        return Some(match value.parse::<u64>() {
            Ok(n) if n <= MAX_RETRY_AFTER.as_secs() => Duration::from_secs(n),
            _ => MAX_RETRY_AFTER,
        });
    }
    let when = parse_http_date(value)? as f64;
    let ahead = when - now;
    if ahead <= 0.0 {
        return Some(Duration::ZERO);
    }
    if ahead >= MAX_RETRY_AFTER.as_secs_f64() {
        return Some(MAX_RETRY_AFTER);
    }
    // Round up, so waiting this long is never too early.
    Some(Duration::from_secs(ahead.ceil() as u64))
}

const SHORT_DAYS: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const LONG_DAYS: [&str; 7] = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
];
const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

static IMF_FIXDATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([A-Za-z]{3}), ([0-9]{2}) ([A-Za-z]{3}) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$").unwrap()
});
static RFC850_DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^([A-Za-z]+), ([0-9]{2})-([A-Za-z]{3})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$",
    )
    .unwrap()
});
static ASCTIME_DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([A-Za-z]{3}) ([A-Za-z]{3}) ( [0-9]|[0-9]{1,2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$").unwrap()
});

fn index_fold(names: &[&str], name: &str) -> Option<usize> {
    names.iter().position(|n| n.eq_ignore_ascii_case(name))
}

/// Reads an IMF-fixdate, RFC 850 or asctime date as Unix seconds. Day and
/// month names may be in any case; the weekday is not checked against the
/// date.
pub(crate) fn parse_http_date(v: &str) -> Option<i64> {
    // weekday, day, month, year, hour, minute, second
    let (fields, days): ([&str; 7], &[&str]) = if let Some(m) = IMF_FIXDATE.captures(v) {
        let g = |i| m.get(i).map_or("", |x| x.as_str());
        ([g(1), g(2), g(3), g(4), g(5), g(6), g(7)], &SHORT_DAYS)
    } else if let Some(m) = RFC850_DATE.captures(v) {
        let g = |i| m.get(i).map_or("", |x| x.as_str());
        ([g(1), g(2), g(3), g(4), g(5), g(6), g(7)], &LONG_DAYS)
    } else {
        let m = ASCTIME_DATE.captures(v)?;
        let g = |i| m.get(i).map_or("", |x| x.as_str());
        ([g(1), g(3), g(2), g(7), g(4), g(5), g(6)], &SHORT_DAYS)
    };
    let [weekday, day, month, year, hour, minute, second] = fields;
    index_fold(days, weekday)?;
    let mon = index_fold(&MONTHS, month)? as i64 + 1;
    let mut y: i64 = year.parse().ok()?;
    if year.len() == 2 {
        // RFC 850's two-digit year: 69 to 99 are 19xx, 00 to 68 are 20xx.
        y += if y >= 69 { 1900 } else { 2000 };
    }
    let d: i64 = day.trim().parse().ok()?;
    let h: i64 = hour.parse().ok()?;
    let mi: i64 = minute.parse().ok()?;
    let sec: i64 = second.parse().ok()?;
    if d < 1 || d > days_in_month(y, mon) || h > 23 || mi > 59 || sec > 59 {
        return None;
    }
    Some(days_from_civil(y, mon, d) * 86_400 + h * 3600 + mi * 60 + sec)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if is_leap(y) => 29,
        _ => 28,
    }
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
/// algorithm).
pub(crate) fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date for days since 1970-01-01, as (year, month, day).
pub(crate) fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}
