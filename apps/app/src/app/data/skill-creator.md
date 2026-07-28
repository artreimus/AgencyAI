---
name: skill-creator
description: Create or update a reusable local skill in the current workspace.
---

# Skill Creator

Use this checklist to create or update one local skill in the current
workspace.

## What is a skill?

A skill is a folder under `.opencode/skills/<skill-name>/` anchored by a
`SKILL.md`. It packages durable instructions, examples, templates, and optional
scripts for a repeated workflow.

## Local authoring contract

1. Inspect `.opencode/skills/` for an exact or closely related skill.
2. Create or update exactly one `.opencode/skills/<skill-name>/SKILL.md`.
3. Keep the frontmatter `name` aligned with the folder name.
4. Re-read the finished file and validate any referenced local scripts.
5. Report the workspace-relative path and summarize what changed.

## Design goals

- Portable: safe to copy between machines
- Reconstructable: can recreate any required local state
- Self-building: can bootstrap its own config/state
- Credential-safe: no secrets committed; graceful first-time setup

## Recommended structure

```
.opencode/
  skills/
    my-skill/
      SKILL.md
      README.md
      templates/
      scripts/
```

## Trigger phrases (critical)

The description field tells the agent when to use the skill.
Include 2-3 specific phrases that should trigger it.

Bad example:
"Use when working with content"

Good examples:
"Use when user mentions 'content pipeline', 'add to content database', or 'schedule a post'"
"Triggers on: 'rotate PDF', 'flip PDF pages', 'change PDF orientation'"

Quick validation:
- Contains at least one quoted phrase
- Uses "when" or "triggers"
- Longer than ~50 characters

## Frontmatter template

```yaml
---
name: my-skill
description: |
  [What it does in one sentence]

  Triggers when user mentions:
  - "[specific phrase 1]"
  - "[specific phrase 2]"
  - "[specific phrase 3]"
---
```

## Authoring checklist

1. Start with a clear purpose statement: when to use it and what it outputs.
2. Specify inputs, outputs, and required permissions.
3. Include setup steps when the skill needs local tooling.
4. Add at least two realistic user prompts.
5. Avoid destructive defaults and require confirmation for consequential work.
6. Never include credentials, tokens, private logs, or machine-specific secrets.
7. Validate the completed local files before reporting success.
