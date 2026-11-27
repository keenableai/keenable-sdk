#!/usr/bin/env bash
# Live smoke test of one SDK against the production API, keyless.
#
#   scripts/smoke/run.sh <python|typescript|go|rust> <repo|registry|build>
#
# repo installs the SDK from this checkout; registry installs the latest
# published release (PyPI, npm, the Go module proxy, crates.io), so a broken
# release shows up even when main is fine; build is repo but only compiles the
# Go and Rust programs, calling no API (Python and TypeScript are checked by
# the examples type check instead). Either way the package is installed
# into a scratch directory the way a user would, then smoke.py, smoke.ts,
# main.go or main.rs runs one search and one fetch of https://example.com.
#
# Needs network access. KEENABLE_API_KEY is cleared: the test is keyless.
set -euo pipefail

usage="usage: run.sh <python|typescript|go|rust> <repo|registry|build>"
lang=${1:?$usage}
source=${2:?$usage}
case $source in repo | registry | build) ;; *) echo "$usage" >&2; exit 2 ;; esac
case $lang:$source in python:build | typescript:build) echo "$usage" >&2; exit 2 ;; esac

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
unset KEENABLE_API_KEY
export PIP_DISABLE_PIP_VERSION_CHECK=1

echo "== $lang SDK from $source"
case $lang in
python)
  python3 -m venv "$work/venv"
  if [ "$source" = repo ]; then
    "$work/venv/bin/pip" install --quiet "$root/python"
  else
    "$work/venv/bin/pip" install --quiet keenable
  fi
  "$work/venv/bin/python" "$here/smoke.py"
  ;;
typescript)
  # Node 22.18+ runs smoke.ts directly (type stripping).
  if [ "$source" = repo ]; then
    (cd "$root/typescript" && npm install --legacy-peer-deps --silent && npm run --silent build >/dev/null &&
      npm pack --silent --pack-destination "$work" >/dev/null)
    pkg=$(ls "$work"/keenable-*.tgz)
  else
    pkg=keenable
  fi
  cd "$work"
  npm init -y >/dev/null
  npm pkg set type=module
  npm install --silent --no-audit --no-fund "$pkg"
  cp "$here/smoke.ts" .
  node smoke.ts
  ;;
go)
  cd "$work"
  cp "$here/main.go" .
  go mod init smoke >/dev/null 2>&1
  if [ "$source" != registry ]; then
    go mod edit -require=github.com/keenableai/keenable-sdk/go@v0.0.0 \
      -replace=github.com/keenableai/keenable-sdk/go="$root/go"
  else
    go get github.com/keenableai/keenable-sdk/go@latest
  fi
  go mod tidy
  if [ "$source" = build ]; then go vet . && go build -o /dev/null .; else go run .; fi
  ;;
rust)
  cargo new --quiet --bin --name smoke "$work/smoke"
  cd "$work/smoke"
  cp "$here/main.rs" src/main.rs
  if [ "$source" != registry ]; then
    cargo add --quiet keenable --path "$root/rust"
  else
    cargo add --quiet keenable
  fi
  cargo add --quiet tokio --features macros,rt-multi-thread
  if [ "$source" = build ]; then cargo build --quiet; else cargo run --quiet; fi
  ;;
*)
  echo "unknown language: $lang" >&2
  exit 2
  ;;
esac
