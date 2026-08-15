# Navigation patch for the Cerebras Inference docs

The page is `integrations/keenable.mdx`. Two references need to point at it.

## 1. `docs.json`

Add the page id next to `integrations/exa`, in whichever group currently holds
the search and data providers (Exa and Parallel sit there today):

```json
"pages": [
  "integrations/exa",
  "integrations/keenable",
  "integrations/parallel"
]
```

Alphabetical placement puts Keenable between Exa and Parallel; nothing else in
the file changes.

## 2. `integrations.mdx` (the Integrations overview)

Add a card alongside the other search providers:

```jsx
<Card title="Keenable" icon="magnifying-glass" href="/integrations/keenable">
  Ground responses in live web results. Keyless by default.
</Card>
```

## Optional: `llms.txt`

If the file is generated, no action is needed. If it is hand-maintained, the
matching entry is:

```
- [Get Started with Keenable](https://inference-docs.cerebras.ai/integrations/keenable.md): Learn how to ground Cerebras responses with Keenable web search.
```
