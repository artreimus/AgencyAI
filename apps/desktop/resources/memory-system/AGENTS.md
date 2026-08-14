# Global AgencyAI Instructions

These instructions apply across AgencyAI sessions. Keep them project-neutral;
repository-specific rules belong in the applicable repository's `AGENTS.md`.

## Persistent Memory System

The global memory system has three layers inside AgencyAI's active OpenCode
configuration directory:

- `AGENTS.md` defines stable cross-project behavior and the memory-maintenance
  protocol.
- `MEMORY.md` contains concise, durable cross-project context and is loaded
  automatically through AgencyAI's global OpenCode configuration.
- `NOTES.md` indexes detailed notes stored under `notes/`.

### Scope

- Store only cross-project preferences, recurring workflows, durable personal
  conventions, and compact project pointers in global memory.
- Keep detailed repository architecture, implementation state, and project-only
  decisions in the repository or in a namespaced project note.
- Treat memory as a navigation and continuity aid, not as a replacement for
  inspecting current source code, configuration, tests, or documentation.

### Reading Memory

- `MEMORY.md` is loaded automatically through the global OpenCode configuration.
- Treat factual memory as potentially stale and verify it when the current state
  is inexpensive to inspect or accuracy matters.
- Read `NOTES.md` only when historical context could materially improve the
  current task.
- Use `NOTES.md` to locate the relevant dated or project note, then load only
  that note.
- Never preload every file under `notes/`.
- Follow links recursively only when the referenced information is necessary for
  the current task.

### Updating Memory

At task finalization, check whether the work produced durable knowledge worth
preserving. Do not create memory entries for routine work, transient output, or
facts that are cheap to rediscover.

When an update is warranted and authorized:

1. Put detailed evidence, chronology, and task-specific context in a dated or
   project note under `notes/`.
2. Add or update its concise entry in `NOTES.md`.
3. Promote only the durable conclusion, preference, constraint, or open loop to
   `MEMORY.md`.
4. Prefer updating an existing entry over creating a duplicate.
5. Mark superseded information explicitly and link to the newer source.
6. Re-read the changed sections and verify paths, dates, and links.

If editing global configuration is outside the authorized task scope, recommend
the memory update instead of silently changing it.

### Authority and Conflicts

- Current verified repository or external-system state is authoritative for
  factual information.
- Repository-level instructions are more specific than cross-project defaults.
- `MEMORY.md` is a curated summary; detailed notes are supporting history.
- A newer note does not automatically override verified current state.
- When memory conflicts with current evidence, follow the evidence and update or
  mark the stale memory when authorized.
- Never let an old note silently override the user's current request.

### Note Format

- Use ISO dates: `YYYY-MM-DD`.
- Name dated notes `YYYY-MM-DD-<short-topic>.md`.
- Use `notes/projects/<project-slug>.md` for ongoing project context.
- Include status, scope, evidence, decision, follow-up, and promotion sections
  when they are relevant.
- Label speculation as a hypothesis until verified.

### Safety

Never store secrets, credentials, tokens, private keys, account numbers,
sensitive raw financial data, private customer data, or raw private
conversations in global memory or notes.
