/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import {
  Page,
  PageDescription,
  PageHeader,
  PageTitle,
  PageTitlebarRegion,
} from "@/components/page";
import {
  pickDirectory,
  resolveWorkspaceListSelectedId,
  workspaceSetRuntimeActive,
  workspaceSetSelected,
  type WorkspaceInfo,
  type WorkspaceList,
} from "@/app/lib/desktop";
import { createClient, unwrap } from "@/app/lib/opencode";
import {
  buildOpenworkWorkspaceBaseUrl,
  createOpenworkServerClient,
} from "@/app/lib/openwork-server";
import { getCompiledRendererProductProfile } from "@/app/lib/product-profile";
import { isDesktopRuntime } from "@/app/utils";
import { ProviderSelectionStep } from "@/react-app/domains/onboarding/provider-selection-step";
import { CreateWorkspaceModal } from "@/react-app/domains/workspace/create-workspace-modal";
import type { CreateWorkspaceOptions } from "@/react-app/domains/workspace/types";
import { useLocal } from "@/react-app/kernel/local-provider";
import { useBootState } from "./boot-state";
import { ensureDesktopLocalOpenworkConnection } from "./desktop-local-openwork";
import { resolveOpenworkConnection } from "./openwork-connection";
import {
  writeActiveWorkspaceId,
  writeLastSessionFor,
  writeWorkspaceProjectDimension,
} from "./session-memory";
import { workspaceSessionRoute } from "./workspace-routes";

const PRODUCT = getCompiledRendererProductProfile();

function folderNameFromPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "workspace";
}

function focusPromptSoon() {
  [0, 80, 240, 600].forEach((delay) => {
    window.setTimeout(
      () => window.dispatchEvent(new Event("openwork:focusPrompt")),
      delay,
    );
  });
}

export function LocalWelcomeRoute() {
  const navigate = useNavigate();
  const local = useLocal();
  const { markRouteReady } = useBootState();
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState("");
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [providerStep, setProviderStep] = useState(false);

  useEffect(() => {
    markRouteReady();
  }, [markRouteReady]);

  useEffect(() => {
    if (local.prefs.hasCompletedOnboarding) {
      navigate("/session", { replace: true });
    }
  }, [local.prefs.hasCompletedOnboarding, navigate]);

  const complete = useCallback((openProvider: boolean) => {
    local.setPrefs((previous) => ({
      ...previous,
      hasCompletedOnboarding: true,
      analyticsEnabled: false,
    }));
    const route = pendingWorkspaceId
      ? workspaceSessionRoute(pendingWorkspaceId, pendingSessionId)
      : "/session";
    navigate(openProvider ? `${route}?onboarding=1` : route, { replace: true });
    if (pendingSessionId) focusPromptSoon();
  }, [local, navigate, pendingSessionId, pendingWorkspaceId]);

  const createWorkspace = useCallback(async (
    _preset: string,
    folder: string | null,
    options?: CreateWorkspaceOptions,
  ) => {
    if (!folder) return;
    setBusy(true);
    setError(null);
    try {
      const connection = await resolveOpenworkConnection();
      if (!connection.normalizedBaseUrl || !connection.resolvedToken) {
        throw new Error("The local AgencyAI runtime is not ready yet.");
      }
      const client = createOpenworkServerClient({
        baseUrl: connection.normalizedBaseUrl,
        token: connection.resolvedToken,
        hostToken: connection.resolvedHostToken || undefined,
      });
      const list: WorkspaceList = await client.createLocalWorkspace({
        folderPath: folder,
        name: folderNameFromPath(folder),
        preset: "starter",
      });
      const workspaceId =
        resolveWorkspaceListSelectedId(list) ||
        list.workspaces[list.workspaces.length - 1]?.id ||
        "";
      const workspace =
        list.workspaces.find((entry: WorkspaceInfo) => entry.id === workspaceId) ??
        null;
      if (!workspaceId || !workspace || workspace.workspaceType === "remote") {
        throw new Error("AgencyAI could not create the local workspace.");
      }

      await workspaceSetSelected(workspaceId).catch(() => undefined);
      await workspaceSetRuntimeActive(workspaceId).catch(() => undefined);
      writeActiveWorkspaceId(workspaceId);
      const projectLabel = options?.projectLabel?.trim() ?? "";
      if (projectLabel) {
        writeWorkspaceProjectDimension(workspaceId, { label: projectLabel });
      }

      await ensureDesktopLocalOpenworkConnection({
        route: "session",
        workspace,
        allWorkspaces: list.workspaces.filter(
          (entry) => entry.workspaceType !== "remote",
        ),
      }).catch(() => undefined);
      const fresh = await resolveOpenworkConnection();
      let sessionId: string | null = null;
      if (fresh.normalizedBaseUrl && fresh.resolvedToken) {
        const mounted =
          buildOpenworkWorkspaceBaseUrl(fresh.normalizedBaseUrl, workspaceId) ??
          fresh.normalizedBaseUrl;
        const session = unwrap(
          await createClient(
            `${mounted.replace(/\/+$/, "")}/opencode`,
            workspace.path?.trim() || folder,
            { token: fresh.resolvedToken, mode: "openwork" },
          ).session.create({ directory: workspace.path?.trim() || folder }),
        );
        sessionId = session.id;
        writeLastSessionFor(workspaceId, session.id);
      }

      setPendingWorkspaceId(workspaceId);
      setPendingSessionId(sessionId);
      setModalOpen(false);
      setProviderStep(true);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Failed to create the local workspace.",
      );
    } finally {
      setBusy(false);
    }
  }, []);

  const chooseFolder = useCallback(async () => {
    const selected = await pickDirectory({ title: "Choose an AgencyAI workspace" });
    const folder = typeof selected === "string" ? selected : null;
    if (folder) await createWorkspace("starter", folder);
  }, [createWorkspace]);

  return (
    <>
      <Page className="min-h-screen">
        <PageTitlebarRegion />
        <div className="flex min-h-screen items-center justify-center px-6 py-16">
          <div className="w-full max-w-xl rounded-3xl border border-border bg-background px-8 py-12 sm:px-14">
            <div className="text-sm font-semibold tracking-tight">
              {PRODUCT.brand.name}
            </div>
            <PageHeader className="mt-10">
              <PageTitle>Your desktop agent, on your machine</PageTitle>
              <PageDescription>
                Choose a local folder, connect your own model provider, and start a task.
              </PageDescription>
            </PageHeader>
            <Button
              type="button"
              size="lg"
              className="mt-8 w-full"
              onClick={chooseFolder}
              disabled={busy || !isDesktopRuntime()}
              data-testid="local-welcome-choose-workspace"
            >
              <FolderOpen className="mr-2 size-4" />
              {busy ? "Creating workspace…" : "Choose a local workspace"}
            </Button>
            {error ? (
              <p className="mt-3 text-sm text-destructive">{error}</p>
            ) : null}
          </div>
        </div>
      </Page>

      <CreateWorkspaceModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onConfirm={createWorkspace}
        onPickFolder={async () => {
          const selected = await pickDirectory({
            title: "Choose an AgencyAI workspace",
          });
          return Array.isArray(selected) ? selected[0] ?? null : selected;
        }}
        submitting={busy}
        localError={error}
        localDisabled={!isDesktopRuntime()}
      />

      {providerStep ? (
        <ProviderSelectionStep
          showOpenWorkModels={false}
          onOpenWorkModels={() => undefined}
          onBringYourOwn={() => complete(true)}
          onSkip={() => complete(false)}
        />
      ) : null}
    </>
  );
}
