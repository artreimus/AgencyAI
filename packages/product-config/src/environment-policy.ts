const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

const USER_ENVIRONMENT_BLOCKED_NAMES = new Set([
  "BASHOPTS",
  "BASH_ENV",
  "CDPATH",
  "COMSPEC",
  "ENV",
  "GLOBIGNORE",
  "HOME",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "PATH",
  "PATHEXT",
  "PERL5OPT",
  "PROMPT_COMMAND",
  "RUBYOPT",
  "SHELL",
  "SHELLOPTS",
  "SSLKEYLOGFILE",
  "USERPROFILE",
  "ZDOTDIR",
  "_JAVA_OPTIONS",
])

const USER_ENVIRONMENT_BLOCKED_PREFIXES = [
  "BUN_",
  "COREPACK_",
  "DYLD_",
  "ELECTRON_",
  "LD_",
  "NPM_CONFIG_",
  "OPENCODE_",
  "OPENWORK_",
  "OTEL_",
  "PNPM_",
  "VSCODE_",
  "XDG_",
  "YARN_",
] as const

const USER_ENVIRONMENT_ALLOWED_NODE_NAMES = new Set([
  "NODE_EXTRA_CA_CERTS",
])

/**
 * Values in the user environment store are intended for model providers,
 * ordinary MCP servers, and local tools. They may not alter the trusted
 * desktop runtime, its interpreter/loader, package managers, storage roots,
 * or application policy.
 */
export function isUserEnvironmentInjectionKeyAllowed(name: string): boolean {
  if (!ENVIRONMENT_KEY_PATTERN.test(name)) return false
  const normalized = name.toUpperCase()
  if (USER_ENVIRONMENT_ALLOWED_NODE_NAMES.has(normalized)) return true
  if (USER_ENVIRONMENT_BLOCKED_NAMES.has(normalized)) return false
  if (normalized.startsWith("NODE_")) return false
  return !USER_ENVIRONMENT_BLOCKED_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  )
}
