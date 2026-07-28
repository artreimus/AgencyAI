# agencyai-pr07-supply-chain-no-egress — AgencyAI proves its local release closure

1. AgencyAI records the exact renderer modules, all nine bundled font files, server and orchestrator build inputs, and verified OpenCode evidence before packaging. The reviewed source archive hash remains in provenance without duplicating that archive inside the desktop app.

2. The packaged release manifest, SPDX 2.3 document, CycloneDX 1.7 document, and third-party notices describe the same shipped component closure. Every concluded license is covered by the reviewed policy, including fonts, native modules, Electron, Chromium, OpenCode, ripgrep, and SQLite.

3. One independent inspector opens the unpacked app, mounted DMG, and extracted ZIP, verifies their exact resource hashes and signatures, checks every native payload is arm64, and confirms that no updater manifest or blockmap survives packaging.

4. About and Licenses lets a user read the complete notices, Electron license, Chromium license bundle, and both SBOMs. Electron serves only six allowlisted packaged files, rejects symlinks and oversized content, and never grants the renderer arbitrary filesystem access.

5. Pull requests run the fast policy suite and an ad-hoc packaged proof on GitHub-hosted arm64 macOS. This lane has no signing credentials, notarization, release publication, or public DMG and ZIP upload; those distribution actions remain explicitly reserved for PR08.

6. The real packaged AgencyAI app starts from a disposable macOS home, launches the verified patched OpenCode runtime, exercises SQLite, PTY, browser automation, computer-use permission probing, curated docs, and cleanup, while both request auditing and independent process-tree socket samples observe zero unexpected non-loopback traffic.
