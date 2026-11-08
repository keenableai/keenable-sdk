# Publishing

The three SDKs ship together, at one version. The root `VERSION` file holds
it, and each package keeps a copy that `make release` writes:

| File | Line |
|---|---|
| `python/pyproject.toml` | `version = "X.Y.Z"` |
| `python/keenable/_version.py` | `__version__ = "X.Y.Z"` |
| `typescript/package.json` | `"version": "X.Y.Z"` |
| `go/version.go` | `const Version = "X.Y.Z"` |

Don't edit these by hand. CI (`make release-check`) fails when they disagree.

## Release

Needs Node 22.18+.

```bash
git checkout main && git pull
make release BUMP=minor          # or patch, major, or an exact X.Y.Z / X.Y.Z-rc.1
git diff                         # read the changelog entries it wrote
git checkout -b release/v0.2.0
git commit -am "release: v0.2.0"
# open a PR, merge it
```

`make release` bumps every version and moves each `CHANGELOG.md`'s
`## Unreleased` section under `## X.Y.Z (date)`. If an SDK's `Unreleased`
section is empty, it fills the entry from the commits that touched that SDK's
directory since the last release. If no commits touched it, the entry says the
release only keeps the versions in step.

Merging the PR changes `VERSION` on `main`, and
[`release.yml`](.github/workflows/release.yml) then:

1. runs the full test suite;
2. tags `v<version>`, `python-v<version>`, `ts-v<version>` and
   `go/v<version>` on the merge commit;
3. creates the GitHub Release `v<version>`, marked **latest**. Its notes
   (`make release-notes`) list the install commands, each SDK's changelog
   entry and the commits since the last release;
4. starts `publish-python.yml` (PyPI) and `publish-typescript.yml` (npm) on
   the tag;
5. asks the Go module proxy for the new version, so `@latest` resolves to it
   at once.

Re-running the workflow is safe. It skips a version that is already tagged,
and both publish jobs skip a version their registry already has. To release a
`VERSION` that was merged without its workflow running, start **Release** by
hand from the Actions tab.

After the release, update the install pins in
[keenable-external-docs](https://github.com/keenableai/keenable-external-docs)
if any pin a version (see AGENTS.md).

## "latest"

Every channel resolves "latest" to the newest stable release, and a
prerelease (`X.Y.Z-rc.N`) never takes that slot:

| Channel | Latest | A prerelease |
|---|---|---|
| PyPI | `pip install -U keenable` | `pip install --pre keenable` |
| npm | `npm install keenable@latest` (the `latest` dist-tag) | `npm install keenable@next` |
| Go | `go get github.com/keenableai/keenable-sdk/go@latest` | `go get ...@v0.3.0-rc.1` |
| GitHub | [`/releases/latest`](https://github.com/keenableai/keenable-sdk/releases/latest) | marked "Pre-release" |

All three SDKs share one version. "Latest" is therefore the same number on
every channel, and the GitHub Release `latest` lists all three.
`make release-status` prints what each registry currently serves.

## One-time setup

- **PyPI**: register a Trusted Publisher for project `keenable`. Point it at
  repo `keenableai/keenable-sdk`, workflow `publish-python.yml` and
  environment `pypi`. If the `pypi` environment limits which tags may deploy,
  allow `v*`.
- **npm**: on npmjs.com, open package `keenable`, then Settings, then
  Trusted Publisher. Choose GitHub Actions, organization `keenableai`,
  repository `keenable-sdk`, workflow `publish-typescript.yml` and environment
  `npm`.
- **Go**: nothing to set up. `go get` and pkg.go.dev follow the `go/v<version>`
  tag. Its prefix is the module directory, and it is not part of the
  `@v<version>` that users type.

Tags made before the shared version (`python-v0.1.x`, `ts-v0.1.x`,
`go/v0.1.x`) stay as they are. `VERSION` starts at 0.1.4, the highest of the
three, so the first shared release comes after it. Python and Go skip the
numbers in between.
