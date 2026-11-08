# Release commands. All three SDKs share the version in VERSION; see PUBLISH.md.
# Needs Node 22.18+ (the scripts are TypeScript run directly by Node).

RELEASE := node scripts/release/release.ts

.PHONY: release release-check release-notes release-status

## make release BUMP=patch|minor|major|X.Y.Z  bump every SDK and roll the changelogs
release:
	@test -n "$(BUMP)" || { echo "usage: make release BUMP=patch|minor|major|X.Y.Z"; exit 2; }
	@$(RELEASE) prepare $(BUMP)

## make release-check  every package carries the VERSION file's version
release-check:
	@$(RELEASE) check

## make release-notes [VERSION=X.Y.Z]  print the GitHub Release body
release-notes:
	@$(RELEASE) notes $(VERSION)

## make release-status  latest versions on PyPI, npm and the Go proxy
release-status:
	@$(RELEASE) status
