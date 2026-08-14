import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { createBundledDocsIndex } from "./bundled-docs.js";

const AGENCYAI_LOCAL_CAPABILITIES = `You are running inside AgencyAI, a local-first desktop agent.

Use the current local workspace as the source of truth. Work with files carefully, keep changes reviewable, and run the smallest meaningful validation after editing code.

For AgencyAI product and setup questions, use agencyai_docs_search and agencyai_docs_read as the first source of truth. Read the relevant local page before answering and cite its docs-relative path when useful. If the bundled docs do not cover a capability, say so instead of inferring that a hosted or organization service exists.

## Local capabilities
- AI providers are configured by the user. Never claim an account or provider is available until the runtime exposes it.
- MCP servers are user-configured tools. Use only the servers and tools currently exposed by the runtime.
- Skills are reusable instruction packs stored in the workspace or the user's OpenCode configuration.
- Create standard local artifacts such as Markdown, CSV, Excel workbooks, presentations, PDFs, and browser previews, then report their workspace-relative paths.
- Use browser or computer-control tools only when the user requests a task that needs them and those tools are available.
- Use local session history when the runtime exposes it. Do not invent earlier conversations or durable facts.

Explain missing setup with one targeted question. Never imply that an unavailable integration, organization feature, or hosted service is active.`;

const docsSearchArgsSchema = z.object({
  query: z.string().min(1).describe(
    "AgencyAI local docs search query, for example 'configure provider API key'.",
  ),
  limit: z.number().int().min(1).max(10).optional().describe(
    "Maximum number of matching local docs pages to return.",
  ),
});

const docsReadArgsSchema = z.object({
  path: z.string().min(1).describe(
    "Docs-relative path returned by agencyai_docs_search, for example providers.mdx.",
  ),
});

function docsCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(here, "..", "agencyai-docs"),
    resolve(here, "..", "..", "..", "..", "packages", "agencyai-docs"),
  ];
}

const docs = createBundledDocsIndex({
  candidateDirectories: docsCandidates(),
  missingPageLabel: "AgencyAI docs page",
});

export const AgencyAiLocalCapabilities = async () => ({
  "experimental.chat.system.transform": async (
    _input: unknown,
    output: { system: string[] },
  ) => {
    output.system.push(AGENCYAI_LOCAL_CAPABILITIES);
  },
  tool: {
    agencyai_docs_search: {
      description:
        "Search the bundled local-only AgencyAI documentation. Use this first for AgencyAI product and setup questions.",
      args: docsSearchArgsSchema.shape,
      async execute(rawArgs: unknown) {
        const args = docsSearchArgsSchema.parse(rawArgs);
        const matches = await docs.search(args.query, args.limit);
        return JSON.stringify({ ok: true, matches }, null, 2);
      },
    },
    agencyai_docs_read: {
      description:
        "Read an AgencyAI local documentation page by the docs-relative path returned from agencyai_docs_search.",
      args: docsReadArgsSchema.shape,
      async execute(rawArgs: unknown) {
        const args = docsReadArgsSchema.parse(rawArgs);
        return JSON.stringify(await docs.read(args.path), null, 2);
      },
    },
  },
});
