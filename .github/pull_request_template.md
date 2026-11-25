<!--
pr-body-lint reads this description and points out what's missing. It never
blocks a merge. Comments like this one are guidance: write outside them.
How to measure a change: MEASURING.md in keenableai/ci-workflows.

Release PR (it changes an SDK version)? scripts/release.ts writes its
description; it needs What changes for users, Evidence and Rollback instead
(PUBLISH.md), and that check does block.

No behavior change (refactor, tests, CI, docs only)? Add the
`no-behavior-change` label and leave Hypothesis and Follow-up out.
-->

## What

<!-- What changes, and in which SDKs: Python, TypeScript, Go, Rust. A new option, method, field or error type goes into all four. -->

## Why

<!--
Which developers or agents is this for, and what can't they do today? Link
what shows it: an issue, a docs page the SDK can't follow, a support thread.
-->

## Hypothesis

<!--
We believe <change> for <who> will result in <outcome>.
We'll know we're right when <metric, threshold, where it is measured>.
We'll know we're wrong when <metric or guardrail threshold>.
-->

## Checks

<!--
What you ran and what it showed, per SDK:
- Go: `go test ./... && go vet ./...`
- Python: `python -m pytest -q`
- TypeScript: `npx vitest run && npx tsc --noEmit`
- Rust: `cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`
- shared cases: `node scripts/conformance/sync.ts --check`, `node scripts/error-contract/sync.ts --check`
- tool definitions (tools.*) changed: an agent run on base and head (link it; required)
- the docs sample run against the live API, and its output
Say what you could not run and why.
-->

## Docs

<!--
Public behaviour changed (option, method, signature, model field, error type)?
Link the keenable-external-docs PR (samples regenerated). Otherwise say why none is needed.
-->

## Risk and rollback

<!--
What could break for users of each SDK? Users get it only in the next release,
and no registry takes a version back: say if it needs a careful release
(a deprecation first, a major version).
-->

## Follow-up

<!--
Where you will look after it ships, and when: downloads, issues, API errors
from the SDK's user agent. "None, because …" is an answer.
-->
