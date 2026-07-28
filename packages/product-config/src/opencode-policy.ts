export const AGENCYAI_OPENCODE_BINARY_VERSION = "1.17.11"
export const AGENCYAI_OPENCODE_FORK_TAG =
  `product-opencode-v${AGENCYAI_OPENCODE_BINARY_VERSION}-p2`

export const AGENCYAI_LOCAL_OPENCODE_PLUGIN_NAMES = Object.freeze([
  "agencyai-local-extensions",
  "agencyai-local-capabilities",
  "openwork-office-attachments",
  "openwork-anthropic-adaptive-thinking",
  "openwork-anthropic-tool-schema",
  "agencyai-local-policy",
] as const)
