# agencyai-pr01-identity-storage — AgencyAI keeps its identity and state separate

1. I start AgencyAI on a Mac where OpenWork and a global OpenCode setup already exist. AgencyAI launches with its own identity while those existing installations remain available beside it.

2. In the packaged metadata, I see AgencyAI’s stable application, executable, helper, and artifact identities. There is no public deep-link registration or updater feed attached to this local build.

3. On first launch, AgencyAI creates its own user data, session, logs, crash, database, bootstrap, MCP, and OpenCode directories under the AgencyAI root. Nothing is placed in OpenWork’s data folders.

4. I open a local workspace and the embedded runtime starts with AgencyAI-owned XDG and OpenCode paths, while my normal home directory remains unchanged for tools and providers.

5. I restart with stale OpenWork bootstrap data and a populated global OpenCode configuration already on disk. AgencyAI ignores that legacy state, and the before-and-after evidence shows every upstream file is byte-for-byte unchanged.

6. Finally, I reopen the workspace and run the canonical local task. The assistant replies exactly `core-flow ok`, proving the isolated identity and storage changes preserve the working desktop agent.
