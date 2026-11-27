//! Lets tests see retry waits instead of sleeping through them, and debug
//! lines instead of printing them.

use std::cell::RefCell;
use std::time::Duration;

thread_local! {
    static WAITS: RefCell<Option<Vec<Duration>>> = const { RefCell::new(None) };
    static LOGS: RefCell<Option<Vec<String>>> = const { RefCell::new(None) };
}

/// Records a wait when this thread records them. Returns whether it did, in
/// which case the caller does not sleep.
pub(crate) fn record_wait(wait: Duration) -> bool {
    WAITS.with(|w| match w.borrow_mut().as_mut() {
        Some(list) => {
            list.push(wait);
            true
        }
        None => false,
    })
}

/// Starts recording waits on this thread, dropping any recorded before.
pub(crate) fn start_recording() {
    WAITS.with(|w| *w.borrow_mut() = Some(Vec::new()));
}

/// The waits recorded since `start_recording`, clearing them.
pub(crate) fn take_waits() -> Vec<Duration> {
    WAITS.with(|w| {
        w.borrow_mut()
            .as_mut()
            .map(std::mem::take)
            .unwrap_or_default()
    })
}

/// Whether this thread records debug lines.
pub(crate) fn recording_logs() -> bool {
    LOGS.with(|l| l.borrow().is_some())
}

/// Records a debug line when this thread records them. Returns whether it
/// did, in which case the caller does not print it.
pub(crate) fn record_log(line: &str) -> bool {
    LOGS.with(|l| match l.borrow_mut().as_mut() {
        Some(list) => {
            list.push(line.to_string());
            true
        }
        None => false,
    })
}

/// Starts recording debug lines on this thread, dropping any recorded before.
pub(crate) fn start_recording_logs() {
    LOGS.with(|l| *l.borrow_mut() = Some(Vec::new()));
}

/// The debug lines recorded since `start_recording_logs`, clearing them.
pub(crate) fn take_logs() -> Vec<String> {
    LOGS.with(|l| {
        l.borrow_mut()
            .as_mut()
            .map(std::mem::take)
            .unwrap_or_default()
    })
}
