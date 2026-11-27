# Security policy

## Report a vulnerability

Please don't open a public issue for a security problem. Report it privately,
in either of these ways:

- **GitHub:** [open a private security advisory](https://github.com/keenableai/keenable-sdk/security/advisories/new)
  on this repository (Security tab, "Report a vulnerability").
- **Email:** [security@keenable.ai](mailto:security@keenable.ai).

Include:

- Which SDK (Python, TypeScript, Go or Rust) and which version.
- What the vulnerability is and its security impact.
- Steps to reproduce it. A minimal proof of concept is enough.

Keenable acknowledges a report within 3 business days and asks for coordinated
disclosure, 30 days by default. The full
[vulnerability disclosure policy](https://app.keenable.ai/security.md) covers
services under `keenable.ai` and its subdomains, what is out of scope, and the
safe harbor terms. Keenable runs no formal bug bounty program. See
[Security and privacy](https://docs.keenable.ai/security) in the docs for how
the API handles keys and request data.

## Supported versions

Security fixes go into the latest release of each SDK. Upgrade to it to get
them:

| SDK | Package |
|---|---|
| Python | [`keenable` on PyPI](https://pypi.org/project/keenable/) |
| TypeScript | [`keenable` on npm](https://www.npmjs.com/package/keenable) |
| Go | [`github.com/keenableai/keenable-sdk/go`](https://pkg.go.dev/github.com/keenableai/keenable-sdk/go) |
| Rust | [`keenable` on crates.io](https://crates.io/crates/keenable) |

## Not a vulnerability?

For a bug, open an [issue](https://github.com/keenableai/keenable-sdk/issues/new/choose).
For help with the API, see [Get help](https://docs.keenable.ai/help) or ask in
the [Keenable Discord](https://discord.gg/be3QybVZ2P).
