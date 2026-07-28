# AgencyAI PR03 — Local server policy and approval boundary

Internal demo proving that the local product profile is enforced by the server, disabled cloud paths cannot be recovered through direct API calls, and only the validated desktop renderer receives narrowly scoped approval trust.

1. I launch AgencyAI and read its non-secret readiness contract. It reports the immutable `local-mvp` profile, disabled cloud, analytics, automatic-update, and runtime-download features, and loopback-only AgencyAI and OpenCode bindings without exposing a port, token, local path, provider key, or workspace name.

2. Using valid local API credentials, I call the disabled Cloud MCP, Connect, Google Workspace, cloud sync, cloud marketplace, voice, runtime-upgrade, and remote-workspace routes directly. Every route is absent or returns a stable feature-disabled response before any remote request, while local workspace, session, provider, file, artifact, approval, and ordinary MCP APIs remain available.

3. I seed a persisted `openwork-cloud` MCP and an ordinary third-party MCP, then restart AgencyAI and reload the engine. AgencyAI preserves the cloud record for reversibility but marks it disabled and never contacts or registers it, while the ordinary MCP remains enabled and is synchronized normally.

4. I exercise the OpenCode proxy with an engine request trap. The reviewed local session, provider, MCP, file, question, and permission methods reach the loopback engine, while global upgrade, sharing, account, control-plane, upstream web-UI, and unrestricted configuration-mutation requests are denied before the engine sees them.

5. I compare origins and approval actors. The configured AgencyAI renderer origin with a fresh, process-local desktop credential can auto-approve a reviewed wrapper operation only for its selected workspace; an unapproved origin, a bearer request without that credential, a spoofed or expired credential, and a request for another workspace remain manual or denied. OpenCode’s own tool-permission prompt still appears and must be answered.

6. I inspect the generated agent prompt and the local capabilities and extensions plugins, then run a local task. They contain no OpenWork Cloud, Connect, Memory Bank, Google Workspace, or voice instructions and make no Connect probe, while local session tools, skills, artifacts, providers, ordinary MCP, and task execution still work; the request audit reports zero unexpected non-loopback traffic.
