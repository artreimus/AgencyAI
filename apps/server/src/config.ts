import { dirname, resolve } from "node:path";
import { openworkServerConfigPath } from "@openwork/paths";
import {
  LocalStorageLayoutError,
  resolveLocalStorageLayoutPath,
} from "./storage-layout-env.js";
import type { ApprovalMode, ApprovalConfig, ServerConfig, WorkspaceConfig, LogFormat } from "./types.js";
import {
  isLocalMvpProduct,
  resolveServerProductPolicy,
  type ServerProductPolicy,
} from "./product-policy.js";
import { buildWorkspaceInfos } from "./workspaces.js";
import { parseList, readJsonFile, shortId } from "./utils.js";

export interface CliArgs {
  configPath?: string;
  host?: string;
  port?: number;
  token?: string;
  hostToken?: string;
  approvalMode?: ApprovalMode;
  approvalTimeoutMs?: number;
  opencodeBaseUrl?: string;
  opencodeDirectory?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  workspaces: string[];
  corsOrigins?: string[];
  readOnly?: boolean;
  verbose?: boolean;
  logFormat?: LogFormat;
  logRequests?: boolean;
  version?: boolean;
  help?: boolean;
  /** In-process callers may narrow, but never broaden, the compiled policy. */
  productPolicy?: ServerProductPolicy;
  /** Exact renderer origin supplied only by an in-process desktop host. */
  trustedRendererOrigin?: string;
}

interface FileConfig {
  host?: string;
  port?: number;
  token?: string;
  hostToken?: string;
  approval?: Partial<ApprovalConfig>;
  workspaces?: WorkspaceConfig[];
  corsOrigins?: string[];
  authorizedRoots?: string[];
  readOnly?: boolean;
  opencodeBaseUrl?: string;
  opencodeDirectory?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  logFormat?: LogFormat;
  logRequests?: boolean;
}

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_LOG_FORMAT: LogFormat = "pretty";
const DEFAULT_LOG_REQUESTS = true;

function normalizeLogFormat(value: string | undefined): LogFormat | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "json") return "json";
  if (normalized === "pretty" || normalized === "text" || normalized === "human") return "pretty";
  return undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function localLoopbackOpencodeOrigin(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username
      || url.password
      || (url.pathname !== "" && url.pathname !== "/")
      || url.search
      || url.hash
      || (
        hostname !== "127.0.0.1"
        && hostname !== "localhost"
        && hostname !== "::1"
        && hostname !== "[::1]"
      )
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function hasWorkspaceOpencodeConnection(
  workspace: Pick<
    WorkspaceConfig,
    "baseUrl" | "directory" | "opencodeUsername" | "opencodePassword"
  >,
): boolean {
  return Boolean(
    workspace.baseUrl?.trim()
    || workspace.directory?.trim()
    || workspace.opencodeUsername?.trim()
    || workspace.opencodePassword?.trim(),
  );
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { workspaces: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;
    if (value === "--help" || value === "-h") {
      args.help = true;
      continue;
    }
    if (value === "--version") {
      args.version = true;
      continue;
    }
    if (value === "--verbose") {
      args.verbose = true;
      continue;
    }
    if (value === "--log-format") {
      args.logFormat = argv[index + 1] as LogFormat | undefined;
      index += 1;
      continue;
    }
    if (value === "--log-requests") {
      args.logRequests = true;
      continue;
    }
    if (value === "--no-log-requests") {
      args.logRequests = false;
      continue;
    }
    if (value === "--config") {
      args.configPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--host") {
      args.host = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--port") {
      const port = Number(argv[index + 1]);
      if (!Number.isNaN(port)) args.port = port;
      index += 1;
      continue;
    }
    if (value === "--token") {
      args.token = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--host-token") {
      args.hostToken = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--approval") {
      const mode = argv[index + 1] as ApprovalMode | undefined;
      if (mode === "manual" || mode === "auto" || mode === "trusted-local-ui") {
        args.approvalMode = mode;
      }
      index += 1;
      continue;
    }
    if (value === "--approval-timeout") {
      const timeout = Number(argv[index + 1]);
      if (!Number.isNaN(timeout)) args.approvalTimeoutMs = timeout;
      index += 1;
      continue;
    }
    if (value === "--opencode-base-url") {
      args.opencodeBaseUrl = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--opencode-directory") {
      args.opencodeDirectory = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--opencode-username") {
      args.opencodeUsername = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--opencode-password") {
      args.opencodePassword = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--workspace") {
      const path = argv[index + 1];
      if (path) args.workspaces.push(path);
      index += 1;
      continue;
    }
    if (value === "--cors") {
      args.corsOrigins = parseList(argv[index + 1]);
      index += 1;
      continue;
    }
    if (value === "--read-only") {
      args.readOnly = true;
      continue;
    }
  }
  return args;
}

export function printHelp(): void {
  const message = [
    "openwork-server",
    "",
    "Options:",
    "  --config <path>          Path to server.json",
    "  --host <host>            Hostname (default 127.0.0.1)",
    "  --port <port>            Port (default 8787)",
    "  --token <token>          Client bearer token",
    "  --host-token <token>     Host approval token",
    "  --approval <mode>        manual | auto | trusted-local-ui",
    "  --approval-timeout <ms>  Approval timeout",
    "  --opencode-base-url <url> OpenCode base URL to share",
    "  --opencode-directory <path> OpenCode workspace directory to share",
    "  --opencode-username <user> OpenCode server username",
    "  --opencode-password <pass> OpenCode server password",
    "  --workspace <path>       Workspace root (repeatable)",
    "  --cors <origins>          Comma-separated origins or *",
    "  --read-only              Disable writes",
    "  --log-format <format>     Log output format: pretty | json",
    "  --log-requests           Log incoming requests (default: true)",
    "  --no-log-requests        Disable request logging",
    "  --verbose                Print resolved config",
    "  --version                Show version",
  ].join("\n");
  console.log(message);
}

async function loadFileConfig(configPath: string): Promise<FileConfig> {
  const parsed = await readJsonFile<FileConfig>(configPath);
  return parsed ?? {};
}

export async function resolveServerConfig(cli: CliArgs): Promise<ServerConfig> {
  const productPolicy = resolveServerProductPolicy(cli.productPolicy);
  const localMvp = isLocalMvpProduct(productPolicy);
  const localConfigPath = resolveLocalStorageLayoutPath(
    "OPENWORK_SERVER_CONFIG",
  );
  if (
    localConfigPath
    && cli.configPath
    && resolve(cli.configPath) !== localConfigPath
  ) {
    throw new LocalStorageLayoutError(
      "local-mvp server config must match OPENWORK_SERVER_CONFIG",
    );
  }
  const configPath = localConfigPath
    ?? cli.configPath
    ?? openworkServerConfigPath();
  const fileConfig = await loadFileConfig(configPath);
  const configDir = dirname(configPath);

  const envWorkspaces = parseList(process.env.OPENWORK_WORKSPACES);
  let workspaceConfigs: WorkspaceConfig[] =
    cli.workspaces.length > 0
      ? cli.workspaces.map((path) => ({ path }))
      : envWorkspaces.length > 0
        ? envWorkspaces.map((path) => ({ path }))
        : fileConfig.workspaces ?? [];
  const sourceWorkspaceConfigs = workspaceConfigs.map(
    (workspace) => ({ ...workspace }) as Record<string, unknown>,
  );

  const envOpencodeBaseUrl = process.env.OPENWORK_OPENCODE_BASE_URL;
  const envOpencodeDirectory = process.env.OPENWORK_OPENCODE_DIRECTORY;
  const envOpencodeUsername = process.env.OPENWORK_OPENCODE_USERNAME;
  const envOpencodePassword = process.env.OPENWORK_OPENCODE_PASSWORD;
  const configuredOpencodeBaseUrl =
    cli.opencodeBaseUrl ?? envOpencodeBaseUrl ?? fileConfig.opencodeBaseUrl;
  const configuredOpencodeDirectory =
    cli.opencodeDirectory ?? envOpencodeDirectory ?? fileConfig.opencodeDirectory;
  const configuredOpencodeUsername =
    cli.opencodeUsername ?? envOpencodeUsername ?? fileConfig.opencodeUsername;
  const configuredOpencodePassword =
    cli.opencodePassword ?? envOpencodePassword ?? fileConfig.opencodePassword;
  const localOpencodeBaseUrl = localMvp
    ? localLoopbackOpencodeOrigin(configuredOpencodeBaseUrl)
    : configuredOpencodeBaseUrl;
  const opencodeBaseUrl = localOpencodeBaseUrl;
  const opencodeDirectory = localMvp && !localOpencodeBaseUrl
    ? undefined
    : configuredOpencodeDirectory;
  const opencodeUsername = localMvp && !localOpencodeBaseUrl
    ? undefined
    : configuredOpencodeUsername;
  const opencodePassword = localMvp && !localOpencodeBaseUrl
    ? undefined
    : configuredOpencodePassword;

  if (workspaceConfigs.length > 0 && (opencodeBaseUrl || opencodeDirectory || opencodeUsername || opencodePassword)) {
    const allowDirectoryOverride = workspaceConfigs.length === 1 && opencodeDirectory;
    workspaceConfigs = workspaceConfigs.map((workspace, index) => {
      const nextDirectory =
        workspace.directory ?? (allowDirectoryOverride && index === 0 ? opencodeDirectory : undefined);
      return {
        ...workspace,
        baseUrl: workspace.baseUrl ?? opencodeBaseUrl,
        directory: nextDirectory,
        opencodeUsername: workspace.opencodeUsername ?? opencodeUsername,
        opencodePassword: workspace.opencodePassword ?? opencodePassword,
      };
    });
  }

  const resolvedWorkspaces = buildWorkspaceInfos(workspaceConfigs, configDir);
  const quarantinedRemoteWorkspaces = localMvp
    ? resolvedWorkspaces.filter((workspace) => workspace.workspaceType === "remote")
    : [];
  const quarantinedRemoteWorkspaceConfigs = localMvp
    ? resolvedWorkspaces.flatMap((workspace, index) =>
        workspace.workspaceType === "remote"
          ? [sourceWorkspaceConfigs[index] ?? {}]
          : [])
    : [];
  const quarantinedLocalOpencodeWorkspaceConfigs = localMvp
    ? resolvedWorkspaces.flatMap((workspace, index) => {
        if (
          workspace.workspaceType === "remote"
          || localLoopbackOpencodeOrigin(workspace.baseUrl)
          || !hasWorkspaceOpencodeConnection(workspace)
        ) {
          return [];
        }
        const source = sourceWorkspaceConfigs[index] ?? {};
        const sourceConnection = {
          baseUrl: typeof source.baseUrl === "string" ? source.baseUrl : undefined,
          directory: typeof source.directory === "string" ? source.directory : undefined,
          opencodeUsername: typeof source.opencodeUsername === "string"
            ? source.opencodeUsername
            : undefined,
          opencodePassword: typeof source.opencodePassword === "string"
            ? source.opencodePassword
            : undefined,
        };
        return hasWorkspaceOpencodeConnection(sourceConnection)
          ? [{ workspaceId: workspace.id, config: source }]
          : [];
      })
    : [];
  const workspaces = (localMvp
    ? resolvedWorkspaces.filter((workspace) => workspace.workspaceType !== "remote")
    : resolvedWorkspaces
  ).map((workspace) => {
    if (!localMvp) return workspace;
    const allowedBaseUrl = localLoopbackOpencodeOrigin(workspace.baseUrl);
    if (!allowedBaseUrl) {
      return {
        ...workspace,
        baseUrl: undefined,
        directory: undefined,
        opencodeUsername: undefined,
        opencodePassword: undefined,
      };
    }
    return {
      ...workspace,
      baseUrl: allowedBaseUrl,
    };
  });

  const tokenFromEnv = process.env.OPENWORK_TOKEN;
  const hostTokenFromEnv = process.env.OPENWORK_HOST_TOKEN;

  const token = cli.token ?? tokenFromEnv ?? fileConfig.token ?? shortId();
  const hostToken = cli.hostToken ?? hostTokenFromEnv ?? fileConfig.hostToken ?? shortId();

  const tokenSource: ServerConfig["tokenSource"] = cli.token
    ? "cli"
    : tokenFromEnv
      ? "env"
      : fileConfig.token
        ? "file"
        : "generated";

  const hostTokenSource: ServerConfig["hostTokenSource"] = cli.hostToken
    ? "cli"
    : hostTokenFromEnv
      ? "env"
      : fileConfig.hostToken
        ? "file"
        : "generated";

  const approvalMode =
    cli.approvalMode ??
    (process.env.OPENWORK_APPROVAL_MODE as ApprovalMode | undefined) ??
    fileConfig.approval?.mode ??
    "manual";

  const approvalTimeoutMs =
    cli.approvalTimeoutMs ??
    (process.env.OPENWORK_APPROVAL_TIMEOUT_MS ? Number(process.env.OPENWORK_APPROVAL_TIMEOUT_MS) : undefined) ??
    fileConfig.approval?.timeoutMs ??
    DEFAULT_TIMEOUT_MS;

  const approval: ApprovalConfig = {
    mode: localMvp
      ? approvalMode === "trusted-local-ui"
        ? "trusted-local-ui"
        : "manual"
      : approvalMode === "auto"
        ? "auto"
        : approvalMode === "trusted-local-ui"
          ? "trusted-local-ui"
          : "manual",
    timeoutMs: Number.isNaN(approvalTimeoutMs) ? DEFAULT_TIMEOUT_MS : approvalTimeoutMs,
  };

  const envCorsOrigins = process.env.OPENWORK_CORS_ORIGINS;
  const parsedEnvCors = envCorsOrigins ? parseList(envCorsOrigins) : null;
  const trustedRendererOrigin = (() => {
    if (!cli.trustedRendererOrigin?.trim()) return productPolicy.rendererOrigin;
    try {
      const url = new URL(cli.trustedRendererOrigin);
      if (
        url.username
        || url.password
        || (url.pathname !== "" && url.pathname !== "/")
        || url.search
        || url.hash
      ) {
        return productPolicy.rendererOrigin;
      }
      const origin = url.origin === "null"
        ? `${url.protocol}//${url.host}`
        : url.origin;
      const hostname = url.hostname.toLowerCase();
      const loopbackDevOrigin = (url.protocol === "http:" || url.protocol === "https:")
        && (
          hostname === "127.0.0.1"
          || hostname === "localhost"
          || hostname === "::1"
          || hostname === "[::1]"
        );
      return origin === productPolicy.rendererOrigin || loopbackDevOrigin
        ? origin
        : productPolicy.rendererOrigin;
    } catch {
      return productPolicy.rendererOrigin;
    }
  })();
  const corsOrigins = localMvp
    ? [trustedRendererOrigin]
    : cli.corsOrigins ?? parsedEnvCors ?? fileConfig.corsOrigins ?? ["*"];

  const envReadOnly = process.env.OPENWORK_READONLY;
  const parsedReadOnly = envReadOnly
    ? ["true", "1", "yes"].includes(envReadOnly.toLowerCase())
    : undefined;
  const readOnly = cli.readOnly ?? parsedReadOnly ?? fileConfig.readOnly ?? false;

  const envLogFormat = process.env.OPENWORK_LOG_FORMAT;
  const logFormat =
    cli.logFormat ??
    normalizeLogFormat(envLogFormat) ??
    normalizeLogFormat(fileConfig.logFormat) ??
    DEFAULT_LOG_FORMAT;

  const envLogRequests = parseBoolean(process.env.OPENWORK_LOG_REQUESTS);
  const logRequests = cli.logRequests ?? envLogRequests ?? fileConfig.logRequests ?? DEFAULT_LOG_REQUESTS;

  const authorizedRoots =
    fileConfig.authorizedRoots?.length
      ? fileConfig.authorizedRoots.map((root) => resolve(configDir, root))
      : workspaces.map((workspace) => workspace.path);

  const host = localMvp
    ? DEFAULT_HOST
    : cli.host ?? process.env.OPENWORK_HOST ?? fileConfig.host ?? DEFAULT_HOST;
  const port = cli.port ?? (process.env.OPENWORK_PORT ? Number(process.env.OPENWORK_PORT) : undefined) ?? fileConfig.port ?? DEFAULT_PORT;

  return {
    host,
    port: Number.isNaN(port) ? DEFAULT_PORT : port,
    token,
    hostToken,
    configPath,
    opencodeBaseUrl,
    opencodeDirectory,
    opencodeUsername,
    opencodePassword,
    approval,
    corsOrigins,
    workspaces,
    authorizedRoots,
    readOnly,
    startedAt: Date.now(),
    tokenSource,
    hostTokenSource,
    logFormat,
    logRequests,
    productPolicy,
    ...(quarantinedRemoteWorkspaces.length > 0
      ? { quarantinedRemoteWorkspaces }
      : {}),
    ...(quarantinedRemoteWorkspaceConfigs.length > 0
      ? { quarantinedRemoteWorkspaceConfigs }
      : {}),
    ...(quarantinedLocalOpencodeWorkspaceConfigs.length > 0
      ? { quarantinedLocalOpencodeWorkspaceConfigs }
      : {}),
  };
}
