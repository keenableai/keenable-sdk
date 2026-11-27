//! Live smoke test: one keyless search and one keyless fetch against
//! production. The smoke workflow copies it into a scratch crate that depends
//! on the SDK (this repo's copy, or the latest release) and runs it.
//! It exits non-zero, with the reason, if either call fails or comes back empty.

use std::process::exit;

const QUERY: &str = "how do solar panels work";
const URL: &str = "https://example.com";
// The page's title and text both say what example.com is for; checking for the
// word keeps the test from breaking when the wording changes.
const EXPECT: &str = "example";

fn fail(message: String) -> ! {
    eprintln!(
        "smoke FAILED (rust, keenable {}): {message}",
        keenable::VERSION
    );
    exit(1);
}

#[tokio::main]
async fn main() {
    let client = keenable::Client::new().unwrap_or_else(|e| fail(format!("new client: {e}")));

    let results = client
        .search(QUERY)
        .await
        .unwrap_or_else(|e| fail(format!("search {QUERY:?}: {e}")));
    let Some(first) = results.results.first() else {
        fail(format!(
            "search {QUERY:?} returned no results (request {:?})",
            results.request_id
        ));
    };
    if !first.url.starts_with("http") {
        fail(format!("first search result has no URL: {first:?}"));
    }
    println!(
        "search: {} results, first {}",
        results.results.len(),
        first.url
    );

    let response = client
        .fetch([URL])
        .await
        .unwrap_or_else(|e| fail(format!("fetch {URL}: {e}")));
    if response.results.len() != 1 {
        fail(format!(
            "fetch returned {} pages for 1 URL",
            response.results.len()
        ));
    }
    let page = &response.results[0];
    if let Some(error) = &page.error {
        fail(format!(
            "fetch {URL}: {} {:?} {}",
            error.status, error.code, error.error
        ));
    }
    let text = format!("{}{}", page.title, page.content).to_lowercase();
    if page.content.trim().is_empty() || !text.contains(EXPECT) {
        let head: String = page.content.chars().take(200).collect();
        fail(format!(
            "fetch {URL}: unexpected page {:?}: {head:?}",
            page.title
        ));
    }
    println!("fetch: {} {} chars", page.url, page.content.len());
    println!("smoke ok (rust, keenable {})", keenable::VERSION);
}
