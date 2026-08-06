# Detailed Memory Notes

This directory stores history and evidence that is too detailed or too narrow
for `MEMORY.md`.

## Naming

- Dated note: `YYYY-MM-DD-<short-topic>.md`
- Ongoing project note: `projects/<project-slug>.md`

Use lowercase kebab-case for topics and project slugs.

## Workflow

1. Copy `TEMPLATE.md` to the appropriate dated or project path.
2. Record only useful evidence, decisions, and follow-up context.
3. Add a concise pointer to `../NOTES.md`.
4. Promote only durable cross-project knowledge to `../MEMORY.md`.
5. Mark stale notes as superseded instead of silently rewriting history.

Notes are loaded on demand. Do not add this directory as a wildcard in the
global OpenCode `instructions` array.
