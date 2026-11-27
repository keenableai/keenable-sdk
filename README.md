# Keenable SDK

Official SDKs for [Keenable](https://keenable.ai), a web search API built for AI
agents. Search returns ranked pages with their text already extracted, so one
call gives a model something to reason over; fetch returns any URL as clean
markdown.

**Keyless by default.** Every call works with no account and no key. An optional
`KEENABLE_API_KEY` only lifts the hourly rate limit.

| Language | Package | Source |
|---|---|---|
| Python 3.9+ | [`keenable`](https://pypi.org/project/keenable/) | [`python/`](./python) |
| TypeScript / Node 18+ | [`keenable`](https://www.npmjs.com/package/keenable) | [`typescript/`](./typescript) |
| Go 1.22+ | [`keenable`](https://pkg.go.dev/github.com/keenableai/keenable-sdk/go) | [`go/`](./go) |
| Rust 1.85+ | [`keenable`](https://crates.io/crates/keenable) | [`rust/`](./rust) |

```bash
pip install keenable
npm install keenable
go get github.com/keenableai/keenable-sdk/go@latest
cargo add keenable
```

Straight from GitHub, no registry needed:

```bash
pip install "git+https://github.com/keenableai/keenable-sdk.git#subdirectory=python"
go get github.com/keenableai/keenable-sdk/go@latest
cargo add keenable --git https://github.com/keenableai/keenable-sdk
```

Every [GitHub Release](https://github.com/keenableai/keenable-sdk/releases) also attaches the built package (the Python wheel and sdist, the TypeScript `keenable-<version>.tgz`) and lists the exact install command for that release in its notes. That is the way to install the TypeScript SDK from GitHub, and to pin any SDK to a release.

```python
from keenable import Keenable

keenable = Keenable()
results = keenable.search("fastest inference providers 2026")
print(results.to_context())   # numbered, citable block, ready for a prompt
```

```ts
import { Keenable } from "keenable";

const keenable = new Keenable();
const results = await keenable.search("fastest inference providers 2026");
console.log(results.toContext());
```

```go
package main

import (
	"context"
	"fmt"
	"log"

	"github.com/keenableai/keenable-sdk/go"
)

func main() {
	client, err := keenable.New(nil)
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()

	results, err := client.Search(context.Background(), "fastest inference providers 2026", nil)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(results.ToContext(nil))
}
```

```rust
#[tokio::main]
async fn main() -> Result<(), keenable::Error> {
    let client = keenable::Client::new()?;
    let results = client.search("fastest inference providers 2026").await?;
    println!("{}", results.to_context());
    Ok(())
}
```

Keep sites out of a search with `exclude_domains` (`excludeDomains` in
TypeScript, `ExcludeDomains` in Go, `exclude_domains` on `SearchOptions` in Rust). Each entry is a host and also covers its
subdomains, up to 1,000 hosts:

```python
results = keenable.search(
    "how to repot a monstera without damaging the roots",
    exclude_domains=["pinterest.com", "quora.com"],
)
```

Each SDK exposes the same surface: search, fetch, billing (prices, and with a
key your balance), a `to_context()` /
`toContext()` / `ToContext()` / `to_context()` renderer for prompts, and OpenAI-compatible tool
definitions for tool calling. See the per-language READMEs for the full
reference.

## Monitors

A search monitor is a standing search: it watches the web for a topic and
reports every new result that matches, by webhook, in scheduled runs, or when
you poll it. A page monitor watches one page and reports the changes worth
telling. Every SDK has a `monitors` namespace for
`https://api.keenable.ai/v1/monitors` (create, list, get, update, pause,
resume, delete, trigger, runs, results, versions, deliveries, stats, bulk) and a
`verify_webhook` helper for the signed deliveries. Monitors need an API key.

```python
from keenable import Keenable

keenable = Keenable()  # reads KEENABLE_API_KEY
monitor = keenable.monitors.create(search={"query": "new open-weights LLM releases"})
for result in keenable.monitors.results(monitor.id):
    print(result.title, result.url)

pricing = keenable.monitors.create(
    type="page",
    page={"url": "https://example.com/pricing", "watch_for": "plan prices"},
    schedule={"type": "interval", "value": "6h"},
)
for version in keenable.monitors.versions(pricing.id):
    print(version.version, version.summary)
```

See each SDK's README for the full list, and [`examples/monitors`](./examples/monitors).

## Examples

- [`examples/cerebras/`](./examples/cerebras) - grounding a Cerebras model in
  live web results, and letting it call Keenable as a tool. Python and Node.
- [`examples/domain-filters/`](./examples/domain-filters) - keeping sites out
  of the results with `exclude_domains`. Python and TypeScript.
- [`examples/monitors/`](./examples/monitors) - a monitor that reads new results
  and a webhook receiver that verifies deliveries, and a page monitor that
  watches a pricing page (`pricing_page.py`, `pricing_page.ts`). Python and
  TypeScript; Go
  in [`go/example/monitors`](./go/example/monitors), Rust in
  [`rust/examples/monitors.rs`](./rust/examples/monitors.rs).

## Documentation for partners

- [`docs/partners/cerebras/keenable.mdx`](./docs/partners/cerebras/keenable.mdx) -
  integration page written for the Cerebras Inference docs.

## Feedback

Something hard or missing in any SDK? [Tell us](https://github.com/keenableai/keenable-sdk/issues/new?template=feedback.yml) or ask on [Discord](https://discord.gg/be3QybVZ2P).

## License

MIT
