# Releasing AgencyAI Desktop

This runbook implements PR08 and Gate G7 from
[`PLAN_AGENCYAI_DESKTOP_MVP.md`](../PLAN_AGENCYAI_DESKTOP_MVP.md). The release
lane is intentionally limited to the local-only Apple Silicon macOS beta.

## Release invariants

- Release only from an exact, reviewed commit on the default `dev` branch.
- Require green exact-head CI for both `Local profile policy and tests` and
  `Ad-hoc packaged macOS arm64 proof` before tagging.
- Keep the release workflow and release notes in the tagged commit.
- Use the immutable OpenCode source commit and artifact recorded in
  [`opencode-distribution.json`](../opencode-distribution.json). Never replace
  it with a locally built or stock runtime during release.
- Publish only Developer ID signed, notarized, and stapled artifacts. Unsigned
  or ad-hoc packages are development evidence only.
- Keep the GitHub release as a **draft prerelease** until the downloaded assets
  pass clean-machine acceptance.
- Never commit a certificate, private key, password, decoded signing material,
  or generated release artifact.
- A release date never overrides a failed gate.

## One-time Apple distribution setup

Direct distribution outside the Mac App Store requires membership in the
Apple Developer Program and a **Developer ID Application** certificate.
“Apple Distribution” and “Mac App Distribution” certificates are for App
Store delivery and are rejected by the notarization service for this lane.

1. Export the Developer ID Application identity and private key from Keychain
   Access as a password-protected `.p12`.
2. Create a **team** App Store Connect API key that can use `notarytool`.
   Individual API keys cannot be used for notarization. Download its `.p8`
   file and record the key ID and issuer ID.
3. Record the ten-character Apple Developer Team ID.
4. Confirm the local certificate when it is installed on a release Mac:

   ```bash
   security find-identity -v -p codesigning
   ```

   At least one `Developer ID Application` identity must be present. The
   GitHub workflow does not require it to remain installed locally because it
   imports the exported `.p12` into an ephemeral runner keychain.

### GitHub Actions secrets

Configure these repository Actions secrets in `artreimus/AgencyAI`:

| Secret | Value |
| --- | --- |
| `APPLE_CODESIGN_CERT_P12_BASE64` | Base64-encoded Developer ID Application `.p12` |
| `APPLE_CODESIGN_CERT_PASSWORD` | Password used when exporting the `.p12` |
| `APPLE_NOTARY_API_KEY_P8_BASE64` | Base64-encoded App Store Connect team API `.p8` |
| `APPLE_NOTARY_API_KEY_ID` | App Store Connect API key ID |
| `APPLE_NOTARY_API_ISSUER_ID` | App Store Connect issuer ID |
| `APPLE_TEAM_ID` | Ten-character Apple Developer Team ID |

The binary secrets can be streamed to GitHub without writing an encoded copy
to disk:

```bash
export AGENCYAI_CODESIGN_P12=/absolute/path/to/DeveloperIDApplication.p12
export AGENCYAI_NOTARY_P8=/absolute/path/to/AuthKey.p8

base64 -i "$AGENCYAI_CODESIGN_P12" \
  | gh secret set APPLE_CODESIGN_CERT_P12_BASE64 --repo artreimus/AgencyAI
base64 -i "$AGENCYAI_NOTARY_P8" \
  | gh secret set APPLE_NOTARY_API_KEY_P8_BASE64 --repo artreimus/AgencyAI
```

Set the password and identifiers interactively so they are not placed in shell
history:

```bash
gh secret set APPLE_CODESIGN_CERT_PASSWORD --repo artreimus/AgencyAI
gh secret set APPLE_NOTARY_API_KEY_ID --repo artreimus/AgencyAI
gh secret set APPLE_NOTARY_API_ISSUER_ID --repo artreimus/AgencyAI
gh secret set APPLE_TEAM_ID --repo artreimus/AgencyAI
```

Verify names and update timestamps only; GitHub never returns secret values:

```bash
gh secret list --repo artreimus/AgencyAI
```

The release workflow validates that all six values are non-empty, imports the
certificate into an ephemeral keychain, and deletes temporary signing material
even when the job fails.

## Prepare a beta pull request

1. Start from the current `dev` branch in a clean checkout or worktree. Keep
   unrelated or untracked user files out of the release commit.
2. Land release preparation, runtime-pin changes, version changes, branding,
   and release notes in one reviewable beta-candidate PR targeting `dev`. Do
   not leave the workflow only on a non-default `main` branch.
3. Keep the PR draft while release prerequisites are incomplete. Its body
   should record:
   - the proposed version and tag;
   - the exact source commit;
   - the pinned OpenCode commit;
   - local validation commands;
   - links to exact-head CI;
   - remaining release blockers and any reruns.
4. Require the exact PR head to pass both macOS jobs. Merge only the reviewed
   beta scope; do not add unrelated feature work while cutting the release.

## Set the version and release notes

Use the next intended prerelease version. For example:

```bash
pnpm release:local:bump 0.1.0-beta.2
```

The bump helper keeps the local product package versions aligned. Add matching
release notes at:

```text
.github/release-notes/agencyai-desktop-v0.1.0-beta.2.md
```

The release workflow fails closed if the package version, tag, or release-note
filename does not match.

## Run the release gates

Run these from the beta candidate before merge:

```bash
pnpm install --frozen-lockfile
pnpm test:local
pnpm release:local:review
```

`release:local:review` requires a clean worktree and prints the version, source
commit, product profile, and pinned OpenCode commit. Save those values in the
PR description. If a test fails because a sandbox blocks the `tsx` temporary
IPC socket with `listen EPERM`, rerun the same command with normal local-machine
permissions; do not classify the sandbox error as a test assertion failure.

After merge, use a clean `dev` checkout and verify that it exactly matches the
remote branch before tagging:

```bash
git fetch origin --prune --tags
git switch dev
git pull --ff-only origin dev
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/dev)"
git status --short
pnpm release:local:review
```

If Git reports that `dev` is already checked out in another worktree, run this
block from that worktree. Do not force the branch switch or disturb a dirty
checkout to make a release.

Stop if the worktree is dirty, the source commit is unexpected, the release
workflow or matching notes are absent, either required CI job is not green, or
any Apple secret name is missing.

## Create the release tag

Create the annotated tag only on the exact merged and validated commit. Replace
the example version consistently:

```bash
export AGENCYAI_RELEASE_VERSION=0.1.0-beta.2
export AGENCYAI_RELEASE_TAG="agencyai-desktop-v${AGENCYAI_RELEASE_VERSION}"

git tag -a "$AGENCYAI_RELEASE_TAG" \
  -m "AgencyAI Desktop ${AGENCYAI_RELEASE_VERSION}"
git show --no-patch --decorate "$AGENCYAI_RELEASE_TAG"
git push origin "$AGENCYAI_RELEASE_TAG"
```

Pushing the tag starts
[`AgencyAI Desktop Beta Release`](../.github/workflows/release-desktop-local.yml).
Do not move or recreate a published release tag. If a pre-publication tag is
wrong, stop and document the correction before replacing it.

## What the workflow proves

The release job:

1. checks out the exact tag and verifies its version and local-only profile;
2. runs the source-closure policy and complete local release tests;
3. builds the exact pinned OpenCode runtime;
4. imports the Developer ID identity into an ephemeral keychain;
5. signs every nested executable and the outer app;
6. notarizes and staples the app;
7. signs, notarizes, and staples the DMG;
8. verifies Gatekeeper acceptance for the app, ZIP copy, and DMG;
9. inspects artifact contents and stages SBOMs, notices, provenance, and
   checksums;
10. uploads immutable workflow evidence;
11. creates or updates a draft prerelease; and
12. downloads the release assets again and verifies their hashes.

Monitor the run through GitHub or with:

```bash
gh run list \
  --repo artreimus/AgencyAI \
  --workflow release-desktop-local.yml \
  --limit 5
gh run watch RUN_ID --repo artreimus/AgencyAI --exit-status
```

Do not publish an incomplete draft or manually attach locally produced files.

## Verify the draft release

Confirm the release is still both draft and prerelease:

```bash
gh release view "$AGENCYAI_RELEASE_TAG" \
  --repo artreimus/AgencyAI \
  --json isDraft,isPrerelease,tagName,url,assets
```

Download the exact uploaded assets into a new temporary directory and verify
their checksums independently:

```bash
export AGENCYAI_RELEASE_DIR="$(mktemp -d)"
gh release download "$AGENCYAI_RELEASE_TAG" \
  --repo artreimus/AgencyAI \
  --dir "$AGENCYAI_RELEASE_DIR"
(
  cd "$AGENCYAI_RELEASE_DIR"
  shasum -a 256 -c SHA256SUMS.txt
)
```

The expected public beta payload includes the arm64 DMG and ZIP plus checksums,
SBOMs, license notices, and provenance generated by the workflow.

## Clean-machine acceptance

Test the downloaded draft assets on an Apple Silicon Mac running macOS 14 or
newer. Do not use artifacts from the checkout or workflow workspace.

- Verify `SHA256SUMS.txt` before opening the DMG.
- Open the DMG normally, drag AgencyAI to Applications, and launch it without
  bypassing Gatekeeper.
- Verify `/Applications/AgencyAI.app` is accepted:

  ```bash
  codesign --verify --deep --strict --verbose=4 /Applications/AgencyAI.app
  xcrun stapler validate /Applications/AgencyAI.app
  spctl --assess --type execute --verbose=4 /Applications/AgencyAI.app
  ```

- Confirm the app identifies itself as AgencyAI and the internal `agencyai`
  profile is displayed as **Agency Agent**.
- Open a local workspace and complete one provider-backed prompt. Exercise
  ChatGPT subscription sign-in and the API-key path when they are in scope for
  the release.
- Exercise file approval, session persistence after restart, a local MCP, a
  local skill, browser automation, computer use, SQLite, and PTY behavior.
- Confirm AgencyAI and an existing OpenWork installation can run side by side
  without reading, mutating, importing, or deleting each other's application
  state.
- Replace an older AgencyAI beta with the candidate and confirm existing
  AgencyAI state remains usable.
- Remove the application and confirm no OpenWork application, shortcut,
  configuration, workspace, or user-data root is changed.
- Confirm there are no unexpected non-loopback connections before the user
  explicitly configures a provider or remote MCP.

Record the test Mac model, macOS version, downloaded hashes, release URL, test
results, and tester in the PR or release evidence. Publish the GitHub draft only
after every applicable item passes.

## Failure and rerun policy

- **Missing signing secret or identity:** fix the repository secret or exported
  certificate. Never fall back to ad-hoc signing.
- **Notarization, stapling, Gatekeeper, hash, provenance, or artifact failure:**
  stop the release and fix the cause on a new reviewed commit and tag.
- **Packaged browser smoke `ERR_ABORTED (-3)` while loading the internal
  `openwork-browser-tab` data URL:** rerun only the failed job once to determine
  whether the known Electron navigation race is transient. If it repeats, fix
  the race with regression coverage; never skip the packaged smoke gate.
- **Sandbox-only `tsx` IPC `EPERM`:** rerun locally outside the sandbox and
  record both the environmental failure and the real test result.
- **GitHub Action runtime deprecation warning:** treat it as maintenance debt
  and update the affected action after reviewing the action's supported runtime;
  a warning alone does not replace the release acceptance checks.

## Publish and archive evidence

After clean-machine acceptance:

1. Make the draft prerelease public in GitHub.
2. Reopen the public release page and download at least the checksum file and
   DMG once more.
3. Confirm the public hashes still match.
4. Record the tag, commit, workflow run, release URL, Apple Team ID, tester,
   clean-machine evidence, and any accepted follow-up work.
5. Keep the workflow artifact, SBOMs, notices, provenance, and checksums with
   the release record.

## Beta 1 preparation record — 2026-08-05

This section is historical evidence, not permission to reuse the old commit for
a later release.

| Item | Recorded state |
| --- | --- |
| Version | `0.1.0-beta.1` |
| Proposed tag | `agencyai-desktop-v0.1.0-beta.1` |
| Integration PR | [#9 — prepare AgencyAI beta 1](https://github.com/artreimus/AgencyAI/pull/9), draft, `openai-oauth` into `dev` |
| Exact candidate commit | `59c9c832982b5c16c7302f284e326e2e1a965d2a` |
| Pinned OpenCode commit | `32018b8929b2ea5d2c8d80a3e5f90aabcf5a46d2` |
| Local validation | `pnpm test:local`, app typecheck, focused branding tests, and `pnpm release:local:review` passed |
| Exact-head CI | [Run 30997735721](https://github.com/artreimus/AgencyAI/actions/runs/30997735721) passed both required jobs |
| Observed flake | First packaged smoke attempt hit Electron marker-load `ERR_ABORTED (-3)`; isolated failed-job rerun passed without a code change |
| Signing readiness | No local Developer ID identity and no repository-level Apple release secrets were present |
| Tag/release state | Tag was intentionally not created; no installer was published |

Before resuming beta 1, verify this table against current GitHub state. Merge
the reviewed PR, configure all six Apple secrets, rerun the post-merge release
review, and tag the exact merged `dev` commit—not the historical PR head.
