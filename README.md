# Keenable SDK

[![PyPI](https://img.shields.io/pypi/v/keenable?label=PyPI)](https://pypi.org/project/keenable/)
[![npm](https://img.shields.io/npm/v/keenable?label=npm)](https://www.npmjs.com/package/keenable)
[![crates.io](https://img.shields.io/crates/v/keenable?label=crates.io)](https://crates.io/crates/keenable)
[![Go Reference](https://pkg.go.dev/badge/github.com/keenableai/keenable-sdk/go.svg)](https://pkg.go.dev/github.com/keenableai/keenable-sdk/go)
[![Test](https://github.com/keenableai/keenable-sdk/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/keenableai/keenable-sdk/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/be3QybVZ2P)
[![X](https://img.shields.io/badge/follow-%40KeenableAI-000000?logo=x)](https://x.com/KeenableAI)

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

## Integrations and examples

Keenable has ready-made integrations for the agent frameworks and tools you
may already use. Each page in the
[integrations directory](https://docs.keenable.ai/integrations) shows the setup
and a working example:

- **Frameworks and SDKs:**
  [LangChain](https://docs.keenable.ai/integrations/langchain),
  [LlamaIndex](https://docs.keenable.ai/integrations/llamaindex),
  [Vercel AI SDK](https://docs.keenable.ai/integrations/vercel),
  [Mastra](https://docs.keenable.ai/integrations/mastra),
  [CrewAI](https://docs.keenable.ai/integrations/crewai),
  [Agno](https://docs.keenable.ai/integrations/agno),
  [Haystack](https://docs.keenable.ai/integrations/haystack),
  [Google ADK](https://docs.keenable.ai/integrations/google-adk),
  [NVIDIA NeMo Agent Toolkit](https://docs.keenable.ai/integrations/nemo-agent-toolkit),
  [PraisonAI](https://docs.keenable.ai/integrations/praisonai)
- **Low-code builders:**
  [n8n](https://docs.keenable.ai/integrations/n8n),
  [Dify](https://docs.keenable.ai/integrations/dify),
  [Langflow](https://docs.keenable.ai/integrations/langflow),
  [RAGFlow](https://docs.keenable.ai/integrations/ragflow)
- **Inference providers:**
  [OpenRouter](https://docs.keenable.ai/integrations/openrouter),
  [Baseten](https://docs.keenable.ai/integrations/baseten)
- **Voice agents:**
  [Pipecat](https://docs.keenable.ai/integrations/pipecat)

The docs also cover [tool calling](https://docs.keenable.ai/tool-calling),
[best practices](https://docs.keenable.ai/best-practices) for search and fetch,
and the [MCP server](https://docs.keenable.ai/mcp-server) for coding agents and
chat apps.

## Documentation for partners

- [`docs/partners/cerebras/keenable.mdx`](./docs/partners/cerebras/keenable.mdx) -
  integration page written for the Cerebras Inference docs.

## Community

- [Discord](https://discord.gg/be3QybVZ2P): ask questions and talk to the
  Keenable team and other developers.
- [X (@KeenableAI)](https://x.com/KeenableAI): releases and news.
- [Issues](https://github.com/keenableai/keenable-sdk/issues): bugs and feature
  requests for the SDKs.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how the four SDKs stay in step, how
to run the tests, and the deprecation policy. To report a vulnerability, see
[SECURITY.md](./SECURITY.md).

## License

MIT
