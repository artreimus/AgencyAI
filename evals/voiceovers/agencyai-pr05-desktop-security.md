1. AgencyAI serves its packaged renderer only from `agencyai-internal://renderer`. The main window is sandboxed with context isolation, no Node integration, and a production Content Security Policy that excludes `unsafe-eval`.

2. Every privileged main-window IPC command verifies the exact renderer origin, main frame, owning WebContents, and current main window. Generic navigation accepts only explicit public HTTPS destinations, while local file open and reveal remain separate, workspace-scoped commands.

3. Electron permissions are denied by default. Only profile-enabled capabilities may be granted to the trusted renderer, and browser tabs remain sandboxed remote content without AgencyAI preload or privileged IPC access.

4. Browser automation binds DevTools only to loopback on a randomized port chosen for each production launch. The reviewed plugin is bundled behind an authenticated AgencyAI wrapper that supplies the endpoint internally and authorizes only isolated tabs created through `browser.open_url`, never the app renderer.

5. AgencyAI packages on Electron 43.2.0 with hardened Electron fuses and deterministic native rebuilds. Packaged `better-sqlite3`, `@lydell/node-pty`, the computer-use helper, and the verified OpenCode sidecar all load and execute on the target architecture.

6. A packaged local-profile launch serves the internal renderer with the restrictive CSP, completes authenticated local readiness, and exercises SQLite, PTY, browser, and helper smoke checks without updater IPC, a public OS protocol, release metadata, or OpenWork-owned network traffic.
