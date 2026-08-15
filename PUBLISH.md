# Publishing

Two packages ship from this repo, on independent version numbers.

## Python (`keenable` on PyPI)

Trusted Publishing (OIDC), no tokens stored.

One-time setup on PyPI: register a Trusted Publisher for project `keenable`
pointing at repo `keenableai/keenable-sdk`, workflow `publish-python.yml`,
environment `pypi`.

To release:

1. Bump `version` in `python/pyproject.toml` and `__version__` in
   `python/keenable/__init__.py`.
2. Create a GitHub Release tagged `python-v<version>` (e.g. `python-v0.1.1`).
3. `publish-python.yml` builds with `uv` and publishes. The workflow ignores
   releases whose tag does not start with `python-v`.

## TypeScript (`keenable` on npm)

Manual publish with OTP, matching how our other npm packages ship.

1. Bump `version` in `typescript/package.json` and `VERSION` in
   `typescript/src/client.ts` (the User-Agent tag).
2. Build and verify:
   ```bash
   cd typescript
   npm install
   npm run typecheck && npm test && npm run build
   npm pack --dry-run    # check the file list
   ```
3. Publish:
   ```bash
   npm publish --access public --otp=<code>
   ```
4. Tag the release `ts-v<version>` on GitHub.

## Version sync

The two packages keep the same feature surface but version independently. When
a change touches both, release both and note it in the same GitHub Release
description.
