# AgencyAI PR02 — Local renderer composition

1. I launch AgencyAI with a fresh product profile and see the local welcome experience. The app starts without a cloud sign-in gate, organization setup, updater prompt, remote branding, or an OpenWork-owned network request.

2. I seed saved cloud credentials, a non-loopback OpenWork server URL, a remote workspace, cloud notifications, and remote icon URLs, then relaunch. AgencyAI preserves the raw saved data for reversibility but keeps it quarantined: no saved host is contacted and no disabled route or action becomes available.

3. I choose a local folder and create my first workspace. Only local workspace setup is offered; remote workers, team sign-in, organization servers, OpenWork Models, and attribution submission are absent.

4. I open AI Providers and connect a user-owned model provider. The provider flow uses the local OpenCode runtime and does not include organization providers, cloud entitlements, or OpenWork Models.

5. I create a task and send `Reply with exactly: local-renderer ok`. The assistant replies exactly `local-renderer ok`, proving the local workspace and provider path still works.

6. I open Settings and inspect the local navigation and control-action inventories. Cloud account, Connect, cloud providers, memory, sign-in, onboarding, sharing, voice, grant exchange, and remote-workspace actions are absent or redirect to a reviewed local destination, while the request audit reports zero unexpected non-loopback hosts.
