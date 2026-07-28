/** @jsxImportSource react */
import { useState } from "react";
import type { Agent } from "@opencode-ai/sdk/v2/client";

import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import type { McpServerEntry, McpStatusMap, ModelRef, SkillCard, SlashCommandOption } from "@/app/types";
import { t } from "@/i18n";
import { ReactSessionComposer } from "@/react-app/domains/session/surface/composer/composer";
import { encodeComposerMentionValue, type ComposerMentionKind } from "@/react-app/domains/session/surface/composer/mention-encoding";

/**
 * Workspace-scoped wiring for the new-task composer. Everything here is
 * route-level state (default model prefs, selected agent, workspace client),
 * so choices made before the session exists carry into the session that the
 * hero creates.
 */
export type NewTaskComposerContext = {
  client: OpenworkServerClient;
  workspaceId: string | null;
  selectedModel: ModelRef;
  modelUnavailable?: boolean;
  modelUnavailableMessage?: string | null;
  onRefreshOrganizationModels?: () => void | Promise<void>;
  modelPickerOpen: boolean;
  onModelPickerOpenChange: (open: boolean) => void;
  onModelChange: (model: ModelRef) => void;
  openWorkModelsEntitled?: boolean;
  modelVariantLabel: string;
  modelVariant: string | null;
  modelBehaviorOptions?: { value: string | null; label: string }[];
  onModelVariantChange: (value: string | null) => void;
  agentLabel: string;
  selectedAgent: string | null;
  listAgents: () => Promise<Agent[]>;
  onSelectAgent: (agent: string | null) => void;
  listCommands: () => Promise<SlashCommandOption[]>;
  searchFiles: (query: string) => Promise<string[]>;
  isRemoteWorkspace: boolean;
  isSandboxWorkspace: boolean;
  onOpenSettingsSection?: (section: "commands" | "skills" | "mcps" | "plugins") => void;
};

export type NewTaskComposerProps = {
  draft: string;
  onDraftChange: (value: string) => void;
  /** Called with a non-empty draft; the caller creates the session (and workspace if needed). */
  onRunTask: () => void;
  /** Disable submission while a default workspace is being prepared. */
  busy: boolean;
  context: NewTaskComposerContext | null;
};

const noop = () => {};
const emptyAgents = async (): Promise<Agent[]> => [];
const emptyCommands = async (): Promise<SlashCommandOption[]> => [];
const emptyFiles = async (): Promise<string[]> => [];
const FALLBACK_MODEL: ModelRef = { providerID: "", modelID: "" };
const LOCAL_BLOCKED_MCP_NAMES = new Set([
  "google-workspace",
  "openwork-cloud",
  "openwork-voice",
]);

/**
 * The real session composer, reused for the "What do you need done?" empty
 * state. The draft (including skill/mention tokens) is seeded into the
 * created session's composer, so pills typed here survive the handoff.
 * Attachments stay disabled: they are uploaded per session, which does not
 * exist yet.
 */
export function NewTaskComposer(props: NewTaskComposerProps) {
  const [mentions, setMentions] = useState<Record<string, ComposerMentionKind>>({});
  const [skills, setSkills] = useState<SkillCard[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerEntry[]>([]);
  const [mcpStatuses, setMcpStatuses] = useState<McpStatusMap>({});
  const [mcpStatus, setMcpStatus] = useState<string | null>(null);
  const context = props.context;
  const workspaceId = context?.workspaceId ?? null;

  const listSkills = context && workspaceId
    ? async (): Promise<SkillCard[]> => {
        const response = await context.client.listSkills(workspaceId, { includeGlobal: true });
        const localSkills = (response.items ?? []).map((skill) => ({
          name: skill.name,
          path: skill.path,
          description: skill.description,
          trigger: skill.trigger,
          scope: skill.scope,
          origin: "local",
        } satisfies SkillCard));
        setSkills(localSkills);
        return localSkills;
      }
    : undefined;

  const listMcp = context && workspaceId
    ? async (): Promise<{ servers: McpServerEntry[]; statuses: McpStatusMap; status: string | null }> => {
        const response = await context.client.listMcp(workspaceId);
        const servers = (response.items ?? [])
          .filter((entry) => !LOCAL_BLOCKED_MCP_NAMES.has(entry.name.trim().toLowerCase()))
          .map((entry) => ({
            name: entry.name,
            config: entry.config as McpServerEntry["config"],
            source: entry.source,
            origin: "local",
          } satisfies McpServerEntry));
        const statuses: McpStatusMap = {};
        const status = servers.length ? null : "No MCP servers loaded.";
        setMcpServers(servers);
        setMcpStatuses(statuses);
        setMcpStatus(status);
        return { servers, statuses, status };
      }
    : undefined;

  const handleInsertMention = (kind: ComposerMentionKind, value: string) => {
    // @agent mentions switch the pending task's agent instead of inserting a
    // mention token (mirrors the session composer, #2101).
    if (kind === "agent") {
      props.onDraftChange(props.draft.replace(/@([^\s@]*)$/, ""));
      context?.onSelectAgent(value);
      return;
    }
    props.onDraftChange(props.draft.replace(/@([^\s@]*)$/, `@${encodeComposerMentionValue(value)} `));
    setMentions((previous) => ({ ...previous, [value]: kind }));
  };

  // No paste-chip store exists before the session does, so large pastes are
  // inlined into the draft instead of becoming expandable chips.
  const handlePasteText = (text: string) => {
    props.onDraftChange(props.draft ? `${props.draft}\n${text}` : text);
  };

  const handleUnsupportedFileLinks = (links: string[]) => {
    if (!links.length) return;
    props.onDraftChange(`${props.draft}${props.draft && !props.draft.endsWith("\n") ? "\n" : ""}${links.join("\n")}`);
  };

  return (
    <ReactSessionComposer
      draft={props.draft}
      mentions={mentions}
      onDraftChange={props.onDraftChange}
      onSend={props.onRunTask}
      onSteer={noop}
      onQueue={noop}
      onStop={noop}
      busy={false}
      steering={false}
      submissionPreparing={props.busy}
      queuedCount={0}
      disabled={Boolean(context?.modelUnavailable)}
      modelUnavailable={context?.modelUnavailable}
      modelUnavailableMessage={context?.modelUnavailableMessage}
      statusLabel=""
      modelPickerOpen={context?.modelPickerOpen ?? false}
      selectedModel={context?.selectedModel ?? FALLBACK_MODEL}
      openWorkModelsEntitled={context?.openWorkModelsEntitled}
      onRefreshOrganizationModels={context?.onRefreshOrganizationModels}
      onModelPickerOpenChange={context?.onModelPickerOpenChange ?? noop}
      onModelChange={context?.onModelChange ?? noop}
      attachments={[]}
      onAttachFiles={noop}
      onRemoveAttachment={noop}
      attachmentsEnabled={false}
      attachmentsDisabledReason="Attachments become available once the task starts."
      modelVariantLabel={context?.modelVariantLabel ?? ""}
      modelVariant={context?.modelVariant ?? null}
      modelBehaviorOptions={context?.modelBehaviorOptions}
      onModelVariantChange={context?.onModelVariantChange ?? noop}
      agentLabel={context?.agentLabel ?? t("session.default_agent")}
      selectedAgent={context?.selectedAgent ?? null}
      listAgents={context?.listAgents ?? emptyAgents}
      onSelectAgent={context?.onSelectAgent ?? noop}
      listCommands={context?.listCommands ?? emptyCommands}
      listSkills={listSkills}
      skills={skills}
      listMcp={listMcp}
      mcpServers={mcpServers}
      mcpStatus={mcpStatus}
      mcpStatuses={mcpStatuses}
      onOpenSettingsSection={context?.onOpenSettingsSection}
      recentFiles={[]}
      searchFiles={context?.searchFiles ?? emptyFiles}
      onInsertMention={handleInsertMention}
      onPasteText={handlePasteText}
      onUnsupportedFileLinks={handleUnsupportedFileLinks}
      pastedText={[]}
      onExpandPastedText={noop}
      onRemovePastedText={noop}
      isRemoteWorkspace={context?.isRemoteWorkspace ?? false}
      isSandboxWorkspace={context?.isSandboxWorkspace ?? false}
      onUploadInboxFiles={null}
      // The hero owns its own page padding, so the composer must fill the hero column and line up with the suggestion cards.
      flush
      draftScopeKey={`new-task:${workspaceId ?? "chat-first"}`}
    />
  );
}
