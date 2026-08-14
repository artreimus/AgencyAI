# AgencyAI Desktop 0.1.0 beta 1

AgencyAI is a local-first desktop agent for Apple Silicon Macs. This beta
bundles the reviewed AgencyAI OpenCode runtime and does not require an
AgencyAI cloud account.

## Included

- Local workspaces, sessions, file tools, skills, MCP servers, and providers.
- Browser and computer-use capabilities.
- Isolated AgencyAI application and OpenCode state.
- SPDX and CycloneDX SBOMs, third-party notices, checksums, and build
  provenance.

## Requirements

- Apple Silicon Mac.
- macOS 14 or newer.
- A provider configured by the user, or a compatible local model endpoint.

## Install

1. Download the DMG and `SHA256SUMS.txt`.
2. Verify the downloaded files with `shasum -a 256 -c SHA256SUMS.txt`.
3. Open the DMG and drag AgencyAI to Applications.
4. Launch AgencyAI normally. The app is Developer ID signed, notarized, and
   stapled.

This beta uses manual upgrades. There is no automatic updater.

## Support

Report beta issues at https://github.com/artreimus/AgencyAI/issues.

## Provenance

AgencyAI includes software derived from OpenWork and bundles a patched
OpenCode runtime under their respective MIT licenses. See the release
notices, SBOMs, and provenance assets for exact versions and source commits.
