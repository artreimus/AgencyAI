# Releasing AgencyAI Desktop

This runbook implements PR08 and Gate G7 from
[`PLAN_AGENCYAI_DESKTOP_MVP.md`](../PLAN_AGENCYAI_DESKTOP_MVP.md). The release
lane is intentionally limited to the local-only Apple Silicon macOS beta.

## Apple distribution identity

Direct distribution outside the Mac App Store requires membership in the
Apple Developer Program and a **Developer ID Application** certificate.
“Apple Distribution” and “Mac App Distribution” certificates are for
App Store delivery and are rejected by the notarization service for this
release path.

Export the Developer ID Application identity and private key as a password
protected `.p12`. Create a team App Store Connect API key that can use
`notarytool`; individual API keys cannot be used for notarization.

Configure these GitHub Actions secrets in `artreimus/AgencyAI`:

| Secret | Value |
| --- | --- |
| `APPLE_CODESIGN_CERT_P12_BASE64` | Base64-encoded Developer ID Application `.p12` |
| `APPLE_CODESIGN_CERT_PASSWORD` | Password used when exporting the `.p12` |
| `APPLE_NOTARY_API_KEY_P8_BASE64` | Base64-encoded App Store Connect team API `.p8` |
| `APPLE_NOTARY_API_KEY_ID` | App Store Connect API key ID |
| `APPLE_NOTARY_API_ISSUER_ID` | App Store Connect issuer ID |
| `APPLE_TEAM_ID` | Ten-character Apple Developer Team ID |

Never commit any certificate, private key, password, or decoded signing
material. The workflow creates an ephemeral keychain and deletes it after the
run.

## Cut a beta

1. Run the local release gates:

   ```bash
   pnpm install --frozen-lockfile
   pnpm test:local
   node scripts/release/review-local-release.mjs
   ```

2. Set the intended version:

   ```bash
   node scripts/release/bump-local-version.mjs 0.1.0-beta.1
   ```

3. Merge the versioned release commit into `dev` and require exact-head CI to
   pass.

4. Create an annotated tag on that exact commit:

   ```bash
   git tag -a agencyai-desktop-v0.1.0-beta.1 -m "AgencyAI Desktop 0.1.0 beta 1"
   git push origin agencyai-desktop-v0.1.0-beta.1
   ```

5. The `AgencyAI Desktop Beta Release` workflow:

   - verifies the tag, product profile, source closure, tests, and pinned
     OpenCode provenance;
   - imports the Developer ID identity into an ephemeral keychain;
   - signs every nested executable and the outer app;
   - notarizes and staples the app;
   - signs, notarizes, and staples the DMG;
   - verifies Gatekeeper acceptance for the app, ZIP copy, and DMG;
   - inspects all artifact contents and stages SBOMs, notices, provenance, and
     checksums;
   - creates a **draft prerelease** and downloads it again to verify the
     uploaded hashes.

6. Complete the clean-machine installation, coexistence, replacement, and
   removal checklist from the MVP plan against the downloaded draft assets.
   Publish the draft only after that evidence passes.

Unsigned or ad-hoc artifacts are development builds only and must never be
attached to a public release.
