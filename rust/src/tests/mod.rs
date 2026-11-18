//! Tests that need the crate's internals: the shared conformance cases and
//! error contract, and the client against a local server.

mod client;
mod conformance;
mod contract;
mod server;

use std::path::PathBuf;

use serde_json::Value;

use crate::{Client, Options};
use server::Server;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// A shared fixture from tests/fixtures.
fn load_fixture(file: &str) -> Value {
    let path = manifest_dir().join("tests/fixtures").join(file);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap()
}

/// Fails unless every SDK in the repository has the same bytes for `file`.
fn same_in_every_sdk(file: &str, ours: &str) {
    let root = manifest_dir().join("..");
    let mine = std::fs::read(manifest_dir().join(ours)).unwrap();
    for other in [
        format!("go/testdata/{file}"),
        format!("python/tests/fixtures/{file}"),
        format!("typescript/test/fixtures/{file}"),
    ] {
        let path = root.join(&other);
        // The crate can be built outside the repository (cargo package).
        let Ok(theirs) = std::fs::read(&path) else {
            continue;
        };
        assert!(
            theirs == mine,
            "{other} differs; run the sync script in scripts/"
        );
    }
}

/// A keyed client for `server`. Retry waits on this thread are recorded
/// from here on, not slept through.
fn keyed(server: &Server) -> Client {
    crate::test_hooks::start_recording();
    Client::with_options(Options {
        api_key: Some("k".into()),
        base_url: Some(server.base_url.clone()),
        ..Default::default()
    })
    .unwrap()
}
