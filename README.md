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
