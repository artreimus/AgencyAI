1. AgencyAI reads one immutable distribution manifest. The OpenCode fork, upstream tag and commit, fork patch commit, binary version, and all four generated SDK consumers agree on version 1.17.11.

2. The macOS arm64 archive, extracted OpenCode binary, private validation SBOMs, and packaged ripgrep tool each match a reviewed SHA-256 and declared provenance before they enter the desktop resources.

3. In the local MVP, production runtime resolution accepts only that verified packaged OpenCode binary and its packaged toolchain. Custom paths, global installs, PATH fallbacks, guided installs, and silent downloads fail closed.

4. OpenCode receives an explicit child environment. AgencyAI-owned storage, generated loopback credentials, and intentionally configured provider credentials remain; inherited update, share, model, plugin, LSP, hosted search, remote configuration, and telemetry overrides are removed or forced off.

5. With an empty package cache and a monitored local registry, plugin, provider SDK, formatter, language-server, and executable fallback attempts make zero requests and no package mutation. The verified packaged ripgrep executable still works.

6. Authenticated readiness reports healthy OpenCode 1.17.11 from the bundled patched source with the reviewed binary hash, without exposing paths, ports, credentials, or workspace data. Direct providers, Ollama and compatible local endpoints, sessions, tools, and explicitly configured MCP remain available.
