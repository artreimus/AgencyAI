# AgencyAI OpenCode runtime

This repository is a narrow fork of [OpenCode](https://github.com/anomalyco/opencode) for the AgencyAI desktop application.

- Upstream release: `v1.17.11`
- Upstream commit: `67aec2212010d67775c35e696d8b8b54902eb338`
- License: MIT; see `LICENSE`
- Intended fork tag: `product-opencode-v1.17.11-p3`

The AgencyAI patch adds a fail-closed `OPENCODE_DISABLE_RUNTIME_DOWNLOADS` policy for npm-backed plugins, provider SDK fallbacks, formatters, and language servers. Existing verified cache entries remain usable. The fork also pins the release lock's `ghostty-web` commit so a frozen dependency install does not follow a moving branch, and builds against a vendored `models.dev` catalog generated from an exact source commit instead of fetching a mutable API response.

The AgencyAI build packages ripgrep separately. The desktop distribution manifest records the OpenCode binary, archive, SBOM, and ripgrep provenance and hashes.

The private validation artifact includes binary SPDX/CycloneDX data plus an intentionally over-inclusive build-source CycloneDX inventory. The AgencyAI release lane narrows that inventory to the exact shipped production closure before release.

Public release publication is intentionally outside this repository workflow. The workflow produces a private GitHub Actions artifact for validation; publication requires a separate approval.
