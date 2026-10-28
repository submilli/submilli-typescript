#!/usr/bin/env bash
# Runs what .github/workflows/ci.yml runs, on this machine: a clean install,
# type checks, unit tests, the build and publint, the integration tests against
# a released submilli-server, and an install of each packed package on its own.
#
#   scripts/ci.sh
#
# Environment:
#   SUBMILLI_VERSION   The submilli-server release to test against (default: the
#                      one ci.yml pins). Downloaded into .submilli-bin/ on Linux
#                      x86_64; elsewhere, set SUBMILLI_BIN instead.
#   SUBMILLI_BIN       A directory holding submilli-server, used instead of a download.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
version="${SUBMILLI_VERSION:-$(sed -n 's/^  SUBMILLI_VERSION: "\(.*\)"$/\1/p' .github/workflows/ci.yml)}"

step() { printf '\n==> %s\n' "$*"; }

if [ -z "${SUBMILLI_BIN:-}" ]; then
  SUBMILLI_BIN="$root/.submilli-bin"
  if [ "$("$SUBMILLI_BIN/submilli-server" --version 2>/dev/null)" != "submilli-server $version" ]; then
    step "Download submilli-server $version"
    mkdir -p "$SUBMILLI_BIN" && cd "$SUBMILLI_BIN"
    base="https://github.com/submilli/submilli-runtime/releases/download/v$version"
    curl -fsSLO "$base/submilli-server-x86_64-unknown-linux-musl"
    curl -fsSLO "$base/SHA256SUMS"
    grep ' submilli-server-x86_64-unknown-linux-musl$' SHA256SUMS | sha256sum -c
    mv submilli-server-x86_64-unknown-linux-musl submilli-server
    chmod +x submilli-server
    cd "$root"
  fi
fi
export SUBMILLI_BIN

step "Node $(node --version)"
npm ci
step "Type checks"
npm run typecheck
step "Unit tests"
npm test
step "Build and publint"
npm run check
step "Integration tests against $("$SUBMILLI_BIN/submilli-server" --version)"
npm run test:integration --workspaces

step "Each package installs and imports on its own, from its tarball"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/packs" "$scratch/app"
npm pack --workspaces --pack-destination "$scratch/packs" >/dev/null 2>&1
(
  cd "$scratch/app"
  npm init -y >/dev/null
  npm pkg set type=module
  npm install --no-audit --no-fund ../packs/submilli-sdk-*.tgz ../packs/submilli-ai-sdk-*.tgz ai >/dev/null
  node -e 'import("@submilli/sdk").then((m) => { if (!m.Submilli) process.exit(1) })'
  node -e 'import("@submilli/ai-sdk").then((m) => { if (!m.submilliTools) process.exit(1) })'
  tar -xOzf ../packs/submilli-ai-sdk-*.tgz package/package.json |
    node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const v=JSON.parse(s).dependencies["@submilli/sdk"];if(!/^\^\d/.test(v)){console.error(`@submilli/sdk dependency is ${v}`);process.exit(1)}})'
)

step "CI passed on Node $(node --version)"
