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

```bash
pip install keenable
npm install keenable
go get github.com/keenableai/keenable-sdk/go@latest
```

Straight from GitHub, no registry needed:

```bash
pip install "git+https://github.com/keenableai/keenable-sdk.git#subdirectory=python"
go get github.com/keenableai/keenable-sdk/go@latest
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

Keep sites out of a search with `exclude_domains` (`excludeDomains` in
TypeScript, `ExcludeDomains` in Go). Each entry is a host and also covers its
subdomains, up to 1,000 hosts:

```python
results = keenable.search(
    "how to repot a monstera without damaging the roots",
    exclude_domains=["pinterest.com", "quora.com"],
)
```

Each SDK exposes the same surface: search, fetch, a `to_context()` /
`toContext()` / `ToContext()` renderer for prompts, and OpenAI-compatible tool
definitions for tool calling. See the per-language READMEs for the full
reference.

## Anonymous client ID

A keyless client is told apart from other keyless callers by an ID the API
issues, not by its address or user agent. The API sends an opaque token in the
`X-Keenable-Client` response header; the client keeps it and sends it back in
the same header on later keyless requests.

- It identifies an installation, not a person. The token is opaque: the SDK
  never parses it, and it carries no personal data. It is not a credential and
  grants nothing.
- It is stored on one line in `<config dir>/keenable/client-id`, where the
  config dir is `$XDG_CONFIG_HOME` when set to an absolute path, else
  `%APPDATA%` on Windows, else `~/.config`. The Keenable MCP bridge uses the
  same file, so one machine keeps one ID. If the file cannot be read or
  written, the ID lives in memory for the client's lifetime and nothing is
  raised.
  In a browser or an edge runtime the TypeScript SDK keeps it in memory only.
- A client with an API key never sends, reads or stores it.
- To turn it off, set `KEENABLE_NO_CLIENT_ID` to any non-empty value, or
  pass `anonymous_client_id=False` (Python), `anonymousClientId: false` (TypeScript) or `AnonymousClientID` pointing to `false` (Go) to the client. Nothing is then read, written, sent or kept.

## Examples

- [`examples/cerebras/`](./examples/cerebras) - grounding a Cerebras model in
  live web results, and letting it call Keenable as a tool. Python and Node.
- [`examples/domain-filters/`](./examples/domain-filters) - keeping sites out
  of the results with `exclude_domains`. Python and TypeScript.

## Documentation for partners

- [`docs/partners/cerebras/keenable.mdx`](./docs/partners/cerebras/keenable.mdx) -
  integration page written for the Cerebras Inference docs.

## License

MIT
