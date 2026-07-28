/**
 * Single entry point for embedding the OpenWork server in-process.
 *
 * Handles config resolution, managed OpenCode spawn, and server start
 * in one call -- mirrors what cli.ts does but returns a handle instead
 * of owning the process lifecycle.
 */
import { mkdir } from "node:fs/promises";
import { resolveServerConfig, type CliArgs } from "./config.js";
import {
  DesktopApprovalCredentialService,
  type DesktopApprovalGrant,
  type TrustedDesktopOperation,
} from "./desktop-approval-credentials.js";
import { createManagedOpencodeServer, type ManagedOpencodeServer, type OpencodeExecutionSnapshot } from "./managed-opencode.js";
import {
  clearTrustedOpencodeProcess,
  registerTrustedOpencodeProcess,
  startServer,
  syncAllWorkspacesRuntimeMcpToEngine,
} from "./server.js";
import { ensureLocalWorkspaceFiles } from "./workspace-init.js";
import { findManagedEngineWorkspace } from "./workspaces.js";
import { keepOpenworkRuntimeConfigFileFresh, writeOpenworkRuntimeConfigFile } from "./openwork-runtime-config.js";
import { sweepLegacyOpenCodeConfig } from "./legacy-config-sweep.js";
import { resolveOpencodeModelsUrl } from "./opencode-models-url.js";
import {
  assertLocalStorageLayoutEnvironment,
  type LocalStorageLayoutAttestation,
} from "./storage-layout-env.js";
import type { ServeResult } from "./serve-node.js";
import type { ServerConfig } from "./types.js";
import {
  isLocalMvpProduct,
  serverFeatureEnabled,
} from "./product-policy.js";

export type EmbeddedServerOptions = CliArgs & {
  /** When true, spawn a managed OpenCode child process. */
  manageOpencode?: boolean;
  /** Path to the OpenCode binary. Falls back to OPENWORK_OPENCODE_BIN env. */
  opencodeBin?: string;
  /** Working directory for the managed OpenCode process. */
  opencodeCwd?: string;
};

export type EmbeddedServerHandle = {
  /** Bound port the HTTP server is listening on. */
  port: number;
  /** Full base URL, e.g. http://127.0.0.1:48123 */
  url: string;
  /** The resolved server config (with OpenCode URLs populated). */
  config: ServerConfig;
  /** Redacted details for the managed OpenCode child process, when spawned. */
  managedOpencodeExecution: OpencodeExecutionSnapshot | null;
  /** Liveness for the managed OpenCode child process, when spawned. */
  managedOpencode: { pid: number | null; isAlive: () => boolean } | null;
  /** Exact path-only environment validated by this embedded server. */
  storage: LocalStorageLayoutAttestation | null;
  /** Issue a one-request grant after Electron validates its renderer. */
  issueDesktopApprovalGrant?: (input: {
    bearerToken: string;
    webContentsId: number;
    workspaceId: string;
    operation: TrustedDesktopOperation;
  }) => DesktopApprovalGrant;
  revokeDesktopApprovalGrantsForWebContents?: (webContentsId: number) => number;
  revokeAllDesktopApprovalGrants?: () => number;
  /** Stop the HTTP server and managed OpenCode (if any). */
  stop: () => Promise<void>;
};

export async function startEmbeddedServer(options: EmbeddedServerOptions): Promise<EmbeddedServerHandle> {
  const storage = assertLocalStorageLayoutEnvironment();
  const config = await resolveServerConfig(options);
  const localMvp = isLocalMvpProduct(config.productPolicy);
  const desktopApprovalCredentials = localMvp
    ? new DesktopApprovalCredentialService()
    : null;
  if (desktopApprovalCredentials) {
    config.desktopApprovalCredentials = desktopApprovalCredentials;
  }
  const serverUrl = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;

  // Spawn managed OpenCode if requested and no explicit base URL was provided.
  let managedOpencode: ManagedOpencodeServer | null = null;
  let managedOpencodeIdentity: string | null = null;

  if (!config.readOnly) {
    await ensureLocalWorkspaceFiles(config.workspaces);
  }

  if (!config.opencodeBaseUrl && options.manageOpencode) {
    const workspace = findManagedEngineWorkspace(config.workspaces);
    if (workspace) {
      // Server-managed config file: the engine re-reads it from disk on every
      // instance rebuild, and keepOpenworkRuntimeConfigFileFresh rewrites it
      // on every runtime-DB write — so disposes always pick up current state.
      const runtimeConfigPath = await writeOpenworkRuntimeConfigFile(config, workspace.id);
      keepOpenworkRuntimeConfigFileFresh(config, workspace.id);
      const cwd = options.opencodeCwd
        || process.env.OPENWORK_MANAGED_OPENCODE_CWD?.trim()
        || workspace.path;
      await mkdir(cwd, { recursive: true });
      if (serverFeatureEnabled("legacyOpenWorkImport", config.productPolicy)) {
        await sweepLegacyOpenCodeConfig(config).catch(() => undefined);
      }
      const opencodeModelsUrl = localMvp
        ? null
        : await resolveOpencodeModelsUrl();

      managedOpencode = await createManagedOpencodeServer({
        bin: options.opencodeBin || process.env.OPENWORK_OPENCODE_BIN,
        cwd,
        excludedPorts: [config.port],
        corsOrigins: config.corsOrigins,
        env: {
          // Passing the validated path contract explicitly makes the actual
          // child spawn environment observable in its redacted execution
          // snapshot instead of relying on ambient process inheritance.
          ...(storage?.environment ?? {}),
          ...(process.env.OPENWORK_DEV_MODE ? { OPENWORK_DEV_MODE: process.env.OPENWORK_DEV_MODE } : {}),
          ...(process.env.OPENWORK_UI_CONTROL_DISCOVERY ? { OPENWORK_UI_CONTROL_DISCOVERY: process.env.OPENWORK_UI_CONTROL_DISCOVERY } : {}),
          OPENWORK_SERVER_URL: serverUrl,
          OPENWORK_SERVER_TOKEN: config.token,
          OPENCODE_CONFIG: runtimeConfigPath,
          ...(opencodeModelsUrl ? { OPENCODE_MODELS_URL: opencodeModelsUrl } : {}),
        },
      });

      config.opencodeBaseUrl = managedOpencode.url;
      config.opencodeUsername = managedOpencode.username;
      config.opencodePassword = managedOpencode.password;
      for (const entry of config.workspaces) {
        if (entry.workspaceType === "remote") {
          entry.baseUrl ??= managedOpencode.url;
          entry.opencodeUsername ??= managedOpencode.username;
          entry.opencodePassword ??= managedOpencode.password;
          entry.directory ??= entry.path;
          continue;
        }
        entry.baseUrl = managedOpencode.url;
        entry.opencodeUsername = managedOpencode.username;
        entry.opencodePassword = managedOpencode.password;
        entry.directory = entry.path;
      }
      managedOpencodeIdentity = [
        managedOpencode.pid ?? "unknown",
        managedOpencode.username,
        managedOpencode.password,
      ].join(":");
      registerTrustedOpencodeProcess(config, {
        baseUrl: managedOpencode.url,
        identity: managedOpencodeIdentity,
        isAlive: managedOpencode.isAlive,
      });
    }
  }

  const server = await startServer(config);
  const boundServerOrigin = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${server.port}`;

  // The runtime config file above only covers workspaces[0]. Push every
  // workspace's runtime-DB MCPs into the engine so they aren't invisible
  // until a manual reload. Best-effort.
  if (managedOpencode) {
    void syncAllWorkspacesRuntimeMcpToEngine(config);
  }

  return {
    port: server.port,
    url: boundServerOrigin,
    config,
    managedOpencodeExecution: managedOpencode?.execution ?? null,
    managedOpencode: managedOpencode
      ? { pid: managedOpencode.pid ?? null, isAlive: managedOpencode.isAlive }
      : null,
    storage,
    ...(desktopApprovalCredentials
      ? {
          issueDesktopApprovalGrant(input) {
            const workspace = config.workspaces.find(
              (entry) => entry.id === input.workspaceId
                && entry.workspaceType === "local",
            );
            if (!workspace) {
              throw new Error("Desktop approval workspace is not an active local workspace");
            }
            return desktopApprovalCredentials.issue({
              ...input,
              rendererOrigin: config.corsOrigins[0] ?? "",
              serverOrigin: boundServerOrigin,
            });
          },
          revokeDesktopApprovalGrantsForWebContents(webContentsId: number) {
            return desktopApprovalCredentials.revokeForWebContents(webContentsId);
          },
          revokeAllDesktopApprovalGrants() {
            return desktopApprovalCredentials.revokeAll();
          },
        }
      : {}),
    async stop() {
      desktopApprovalCredentials?.revokeAll();
      if (managedOpencodeIdentity) {
        clearTrustedOpencodeProcess(config, managedOpencodeIdentity);
      }
      await managedOpencode?.close();
      await server.stop();
    },
  };
}
