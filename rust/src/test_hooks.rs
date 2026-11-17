//! Lets tests see retry waits instead of sleeping through them.

use std::cell::RefCell;
use std::time::Duration;

thread_local! {
    static WAITS: RefCell<Option<Vec<Duration>>> = const { RefCell::new(None) };
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
