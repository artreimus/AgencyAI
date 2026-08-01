#!/usr/bin/env bash

# PLAN_AGENCYAI_DESKTOP_MVP.md PR08/G2: build the exact reviewed OpenCode
# source closure at the deterministic CI path used to produce the pinned hash.

set -euo pipefail

: "${RUNNER_WORKSPACE:?RUNNER_WORKSPACE is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"
: "${GITHUB_ENV:?GITHUB_ENV is required}"

source_root="$(dirname "$RUNNER_WORKSPACE")/AgencyAI-OpenCode/AgencyAI-OpenCode"
output_binary="$RUNNER_TEMP/agencyai-opencode"
distribution="$GITHUB_WORKSPACE/opencode-distribution.json"
source_repository="$(jq -r '.sourceRepository' "$distribution")"
source_commit="$(jq -r '.forkCommit' "$distribution")"
binary_version="$(jq -r '.binaryVersion' "$distribution")"
expected_hash="$(jq -r '.targetAssets["aarch64-apple-darwin"].sourceBinarySha256' "$distribution")"

test "$source_repository" = "https://github.com/artreimus/AgencyAI-OpenCode"
test "${OPENCODE_VERSION:-}" = "$binary_version"
test "$source_root" = "/Users/runner/work/AgencyAI-OpenCode/AgencyAI-OpenCode"
test ! -e "$source_root"

mkdir -p "$source_root"
git -C "$source_root" init --quiet
git -C "$source_root" remote add origin "$source_repository"
git -C "$source_root" fetch --depth=1 origin "$source_commit"
git -C "$source_root" checkout --detach FETCH_HEAD
test "$(git -C "$source_root" rev-parse HEAD)" = "$source_commit"

models_snapshot="$source_root/.github/agencyai/models-dev-api.json"
models_metadata="$source_root/.github/agencyai/models-dev-snapshot.json"
evidence_provenance="$GITHUB_WORKSPACE/apps/desktop/resources/opencode-evidence/aarch64-apple-darwin/provenance.json"
expected_models_hash="$(jq -r '.dependencies.modelsDev.sha256' "$evidence_provenance")"

test -f "$models_snapshot"
test -f "$models_metadata"
test "$(jq -r '.snapshotFile' "$models_metadata")" = ".github/agencyai/models-dev-api.json"
test "$(jq -r '.snapshotSha256' "$models_metadata")" = "$expected_models_hash"
test "$(shasum -a 256 "$models_snapshot" | awk '{print $1}')" = "$expected_models_hash"
test "$(jq -r '.sourceRepository' "$models_metadata")" = "$(jq -r '.dependencies.modelsDev.source' "$evidence_provenance")"
test "$(jq -r '.sourceCommit' "$models_metadata")" = "$(jq -r '.dependencies.modelsDev.commit' "$evidence_provenance")"

export MODELS_DEV_API_JSON="$models_snapshot"
(
  cd "$source_root"
  bun install --frozen-lockfile
  bun packages/opencode/script/build.ts --single --skip-embed-web-ui --skip-install
)

runtime_binary="$source_root/packages/opencode/dist/opencode-darwin-arm64/bin/opencode"
test -x "$runtime_binary"
test "$("$runtime_binary" --version)" = "$binary_version"
file "$runtime_binary" | grep -q "arm64"
codesign --force --sign - "$runtime_binary"
codesign --verify --strict --verbose=2 "$runtime_binary"
test "$(shasum -a 256 "$runtime_binary" | awk '{print $1}')" = "$expected_hash"

install -m 755 "$runtime_binary" "$output_binary"
printf 'AGENCYAI_VERIFIED_OPENCODE_BINARY_PATH=%s\n' "$output_binary" >> "$GITHUB_ENV"
