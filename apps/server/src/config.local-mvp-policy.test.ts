import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getBuildProductProfile,
  PRODUCT_FEATURES,
} from "@openwork/product-config";

import {
  resolveServerConfig,
  type CliArgs,
} from "./config.js";
import {
  effectiveServerProductPolicy,
  isLocalMvpProduct,
  serverFeatureEnabled,
  type ServerProductPolicy,
} from "./product-policy.js";
import { resolveWorkspaceOpencodeConnection } from "./opencode-connection.js";
import { persistServerWorkspaceState } from "./routes/workspaces.js";

const MANAGED_ENV_KEYS = [
  "OPENWORK_STORAGE_ROOT",
  "OPENWORK_SERVER_CONFIG",
  "OPENWORK_WORKSPACES",
  "OPENWORK_HOST",
  "OPENWORK_PORT",
  "OPENWORK_TOKEN",
  "OPENWORK_HOST_TOKEN",
  "OPENWORK_APPROVAL_MODE",
  "OPENWORK_APPROVAL_TIMEOUT_MS",
  "OPENWORK_CORS_ORIGINS",
  "OPENWORK_OPENCODE_BASE_URL",
  "OPENWORK_OPENCODE_DIRECTORY",
  "OPENWORK_OPENCODE_USERNAME",
  "OPENWORK_OPENCODE_PASSWORD",
  "OPENWORK_READONLY",
  "OPENWORK_LOG_FORMAT",
  "OPENWORK_LOG_REQUESTS",
  "OPENWORK_RUNTIME_DB",
  "OPENWORK_TOKEN_STORE",
  "OPENWORK_ENV_STORE",
  "OPENWORK_MCP_AUTH_PATH",
  "OPENWORK_DATA_DIR",
  "OPENWORK_CACHE_DIR",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DB",
] as const;

const INPUT_ENV_KEYS = [
  "OPENWORK_WORKSPACES",
  "OPENWORK_HOST",
  "OPENWORK_PORT",
  "OPENWORK_APPROVAL_MODE",
  "OPENWORK_APPROVAL_TIMEOUT_MS",
  "OPENWORK_CORS_ORIGINS",
  "OPENWORK_OPENCODE_BASE_URL",
  "OPENWORK_OPENCODE_DIRECTORY",
  "OPENWORK_OPENCODE_USERNAME",
  "OPENWORK_OPENCODE_PASSWORD",
] as const;

const COMPILED_RENDERER_ORIGIN = "agencyai-internal://renderer";

let roots: string[] = [];
let previousEnvironment = new Map<string, string | undefined>();

function clearInputEnvironment(): void {
  for (const key of INPUT_ENV_KEYS) {
    delete process.env[key];
  }
}

async function createRoot(prefix = "agencyai-config-policy-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeConfig(
  root: string,
  value: Record<string, unknown>,
): Promise<{ path: string; raw: string }> {
  const path = join(root, "server.json");
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, raw, "utf8");
  return { path, raw };
}

function attemptedBroadeningPolicy(): ServerProductPolicy {
  const build = getBuildProductProfile();
  const features = structuredClone(build.features);
  for (const feature of PRODUCT_FEATURES) {
    Reflect.set(features, feature, true);
  }
  return {
    profile: "local-mvp",
    features,
    networkPolicy: "air-gapped",
    rendererOrigin: "https://attacker.invalid",
  };
}

function baseCli(configPath: string): CliArgs {
  return {
    configPath,
    workspaces: [],
    productPolicy: attemptedBroadeningPolicy(),
    trustedRendererOrigin: "https://attacker.invalid",
  };
}

beforeEach(() => {
  previousEnvironment = new Map(
    MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of MANAGED_ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of MANAGED_ENV_KEYS) {
    const previous = previousEnvironment.get(key);
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("resolveServerConfig local-mvp enforcement", () => {
  test("ignores hostile host, CORS, auto approval, and remote OpenCode from file, env, and CLI", async () => {
    const sources = ["file", "env", "cli"] as const;

    for (const source of sources) {
      clearInputEnvironment();
      const root = await createRoot(`agencyai-config-${source}-`);
      const workspacePath = join(root, "workspace");
      await mkdir(workspacePath, { recursive: true });

      const hostileValues = {
        host: "0.0.0.0",
        corsOrigins: ["*", "https://attacker.invalid"],
        approval: { mode: "auto", timeoutMs: 123 },
        opencodeBaseUrl: "https://remote-opencode.invalid",
        opencodeDirectory: "/remote/worktree",
        opencodeUsername: "remote-user",
        opencodePassword: "remote-password",
      };
      const fileValue: Record<string, unknown> = {
        host: "127.0.0.1",
        corsOrigins: ["https://file-safe.invalid"],
        approval: { mode: "manual", timeoutMs: 456 },
        workspaces: [{ id: `workspace_${source}`, path: workspacePath }],
        ...(source === "file" ? hostileValues : {}),
      };
      const fixture = await writeConfig(root, fileValue);
      const cli = baseCli(fixture.path);

      if (source === "env") {
        Object.assign(process.env, {
          OPENWORK_HOST: hostileValues.host,
          OPENWORK_CORS_ORIGINS: hostileValues.corsOrigins.join(","),
          OPENWORK_APPROVAL_MODE: hostileValues.approval.mode,
          OPENWORK_APPROVAL_TIMEOUT_MS: String(hostileValues.approval.timeoutMs),
          OPENWORK_OPENCODE_BASE_URL: hostileValues.opencodeBaseUrl,
          OPENWORK_OPENCODE_DIRECTORY: hostileValues.opencodeDirectory,
          OPENWORK_OPENCODE_USERNAME: hostileValues.opencodeUsername,
          OPENWORK_OPENCODE_PASSWORD: hostileValues.opencodePassword,
        });
      }
      if (source === "cli") {
        Object.assign(cli, {
          host: hostileValues.host,
          corsOrigins: hostileValues.corsOrigins,
          approvalMode: "auto",
          approvalTimeoutMs: hostileValues.approval.timeoutMs,
          opencodeBaseUrl: hostileValues.opencodeBaseUrl,
          opencodeDirectory: hostileValues.opencodeDirectory,
          opencodeUsername: hostileValues.opencodeUsername,
          opencodePassword: hostileValues.opencodePassword,
        });
      }

      const config = await resolveServerConfig(cli);
      const workspace = config.workspaces[0];
      if (!workspace) throw new Error(`Missing ${source} workspace`);

      expect(config.host, source).toBe("127.0.0.1");
      expect(config.corsOrigins, source).toEqual([COMPILED_RENDERER_ORIGIN]);
      expect(config.approval, source).toEqual({
        mode: "manual",
        timeoutMs: hostileValues.approval.timeoutMs,
      });
      expect(config.opencodeBaseUrl, source).toBeUndefined();
      expect(config.opencodeDirectory, source).toBeUndefined();
      expect(config.opencodeUsername, source).toBeUndefined();
      expect(config.opencodePassword, source).toBeUndefined();
      expect(workspace.baseUrl, source).toBeUndefined();
      expect(workspace.directory, source).toBeUndefined();
      expect(workspace.opencodeUsername, source).toBeUndefined();
      expect(workspace.opencodePassword, source).toBeUndefined();
      expect(resolveWorkspaceOpencodeConnection(config, workspace), source).toEqual({});
      expect(await readFile(fixture.path, "utf8"), source).toBe(fixture.raw);

      const build = getBuildProductProfile();
      expect(config.productPolicy?.profile, source).toBe("local-mvp");
      expect(config.productPolicy?.features, source).toEqual(build.features);
      expect(config.productPolicy?.networkPolicy, source).toBe(build.networkPolicy);
      expect(config.productPolicy?.rendererOrigin, source).toBe(COMPILED_RENDERER_ORIGIN);
    }
  });

  test("accepts only trusted-local-ui and only an exact internal or loopback dev renderer origin", async () => {
    const modes = [
      ["auto", "manual"],
      ["manual", "manual"],
      ["invalid", "manual"],
      ["trusted-local-ui", "trusted-local-ui"],
    ] as const;

    for (const [inputMode, expectedMode] of modes) {
      const root = await createRoot(`agencyai-approval-${inputMode}-`);
      const workspacePath = join(root, "workspace");
      await mkdir(workspacePath, { recursive: true });
      const fixture = await writeConfig(root, {
        approval: { mode: inputMode },
        corsOrigins: ["*", "https://attacker.invalid"],
        workspaces: [{ path: workspacePath }],
      });

      const config = await resolveServerConfig({
        configPath: fixture.path,
        workspaces: [],
      });
      expect(config.approval.mode, inputMode).toBe(expectedMode);
      expect(config.corsOrigins, inputMode).toEqual([COMPILED_RENDERER_ORIGIN]);
    }

    const devRoot = await createRoot("agencyai-dev-origin-");
    const devWorkspace = join(devRoot, "workspace");
    await mkdir(devWorkspace, { recursive: true });
    const devFixture = await writeConfig(devRoot, {
      workspaces: [{ path: devWorkspace }],
    });
    const devConfig = await resolveServerConfig({
      configPath: devFixture.path,
      workspaces: [],
      trustedRendererOrigin: "http://localhost:5173",
    });
    expect(devConfig.corsOrigins).toEqual(["http://localhost:5173"]);

    const ipv6DevConfig = await resolveServerConfig({
      configPath: devFixture.path,
      workspaces: [],
      trustedRendererOrigin: "http://[::1]:5173",
    });
    expect(ipv6DevConfig.corsOrigins).toEqual(["http://[::1]:5173"]);
  });

  test("keeps an allowed loopback OpenCode connection but drops credentials for missing, invalid, or remote URLs", async () => {
    const cases = [
      { name: "missing", baseUrl: undefined },
      { name: "invalid", baseUrl: "not a URL" },
      { name: "remote", baseUrl: "https://opencode.invalid" },
      { name: "credentialed", baseUrl: "http://embedded:secret@localhost:4096" },
      { name: "loopback suffix", baseUrl: "http://localhost.attacker.invalid:4096" },
    ] as const;

    for (const item of cases) {
      const root = await createRoot(`agencyai-opencode-${item.name.replaceAll(" ", "-")}-`);
      const workspacePath = join(root, "workspace");
      await mkdir(workspacePath, { recursive: true });
      const fixture = await writeConfig(root, {
        workspaces: [{ path: workspacePath }],
        ...(item.baseUrl ? { opencodeBaseUrl: item.baseUrl } : {}),
        opencodeDirectory: "/untrusted/directory",
        opencodeUsername: "untrusted-user",
        opencodePassword: "untrusted-password",
      });

      const config = await resolveServerConfig({
        configPath: fixture.path,
        workspaces: [],
      });
      const workspace = config.workspaces[0];
      if (!workspace) throw new Error(`Missing ${item.name} workspace`);
      expect(config.opencodeBaseUrl, item.name).toBeUndefined();
      expect(config.opencodeDirectory, item.name).toBeUndefined();
      expect(config.opencodeUsername, item.name).toBeUndefined();
      expect(config.opencodePassword, item.name).toBeUndefined();
      expect(resolveWorkspaceOpencodeConnection(config, workspace), item.name).toEqual({});
    }

    const allowedRoot = await createRoot("agencyai-opencode-loopback-");
    const allowedWorkspace = join(allowedRoot, "workspace");
    await mkdir(allowedWorkspace, { recursive: true });
    const allowedFixture = await writeConfig(allowedRoot, {
      workspaces: [{ path: allowedWorkspace }],
      opencodeBaseUrl: "http://127.0.0.1:4096",
      opencodeDirectory: allowedWorkspace,
      opencodeUsername: "local-user",
      opencodePassword: "local-password",
    });
    const allowed = await resolveServerConfig({
      configPath: allowedFixture.path,
      workspaces: [],
    });
    const workspace = allowed.workspaces[0];
    if (!workspace) throw new Error("Missing allowed workspace");
    expect(allowed.opencodeBaseUrl).toBe("http://127.0.0.1:4096");
    expect(allowed.opencodeDirectory).toBe(allowedWorkspace);
    expect(allowed.opencodeUsername).toBe("local-user");
    expect(allowed.opencodePassword).toBe("local-password");
    expect(resolveWorkspaceOpencodeConnection(allowed, workspace)).toEqual({
      baseUrl: "http://127.0.0.1:4096",
      authHeader: `Basic ${Buffer.from("local-user:local-password").toString("base64")}`,
    });
  });

  test("quarantines remote workspaces and unsafe local OpenCode records losslessly across persistence", async () => {
    const root = await createRoot("agencyai-config-quarantine-");
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    const unsafeLocal = {
      id: "workspace_local",
      path: workspacePath,
      name: "Unsafe local record",
      workspaceType: "local",
      baseUrl: "https://remote-opencode.invalid",
      directory: "/remote/worktree",
      opencodeUsername: "remote-user",
      opencodePassword: "remote-password",
      futureLocalField: {
        keep: true,
        nestedSecret: "preserve-without-activating",
      },
    };
    const remote = {
      id: "workspace_remote",
      path: "",
      name: "Remote record",
      workspaceType: "remote",
      remoteType: "openwork",
      baseUrl: "https://remote-openwork.invalid",
      openworkHostUrl: "https://remote-openwork.invalid",
      openworkToken: "remote-token-preserved",
      futureRemoteField: ["preserve", { exact: true }],
    };
    const fixture = await writeConfig(root, {
      host: "0.0.0.0",
      token: "client-token",
      hostToken: "host-token",
      opencodeBaseUrl: "https://top-level-remote.invalid",
      opencodeDirectory: "/top-level/remote",
      opencodeUsername: "top-level-user",
      opencodePassword: "top-level-password",
      workspaces: [unsafeLocal, remote],
    });

    const config = await resolveServerConfig({
      configPath: fixture.path,
      port: 0,
      workspaces: [],
    });
    expect(config.workspaces).toHaveLength(1);
    expect(config.workspaces[0]).toMatchObject({
      id: unsafeLocal.id,
      workspaceType: "local",
      baseUrl: undefined,
      directory: undefined,
      opencodeUsername: undefined,
      opencodePassword: undefined,
    });
    expect(config.quarantinedRemoteWorkspaceConfigs).toEqual([remote]);
    expect(config.quarantinedLocalOpencodeWorkspaceConfigs).toEqual([
      {
        workspaceId: unsafeLocal.id,
        config: unsafeLocal,
      },
    ]);
    expect(resolveWorkspaceOpencodeConnection(config, config.workspaces[0]!)).toEqual({});
    expect(await readFile(fixture.path, "utf8")).toBe(fixture.raw);

    config.workspaces = config.workspaces.map((workspace) => ({
      ...workspace,
      name: "Renamed safely",
      displayName: "Renamed safely",
    }));
    expect(await persistServerWorkspaceState(config)).toBe(true);

    const persisted = JSON.parse(await readFile(fixture.path, "utf8"));
    const persistedLocal = persisted.workspaces.find(
      (workspace: { id?: string }) => workspace.id === unsafeLocal.id,
    );
    const persistedRemote = persisted.workspaces.find(
      (workspace: { id?: string }) => workspace.id === remote.id,
    );
    expect(persistedLocal).toMatchObject({
      ...unsafeLocal,
      name: "Renamed safely",
      displayName: "Renamed safely",
    });
    expect(persistedRemote).toEqual(remote);
    expect(persisted.opencodeBaseUrl).toBe("https://top-level-remote.invalid");
    expect(persisted.opencodeUsername).toBe("top-level-user");
    expect(persisted.opencodePassword).toBe("top-level-password");

    const resolvedAgain = await resolveServerConfig({
      configPath: fixture.path,
      workspaces: [],
    });
    expect(resolveWorkspaceOpencodeConnection(
      resolvedAgain,
      resolvedAgain.workspaces[0]!,
    )).toEqual({});
    expect(resolvedAgain.quarantinedLocalOpencodeWorkspaceConfigs?.[0]?.config).toMatchObject({
      baseUrl: unsafeLocal.baseUrl,
      futureLocalField: unsafeLocal.futureLocalField,
    });
  });

  test("retains upstream behavior for direct ServerConfig fixtures without a product policy", () => {
    const compatibility = effectiveServerProductPolicy();
    expect(isLocalMvpProduct(undefined)).toBe(false);
    expect(compatibility.profile).toBe("upstream");
    expect(PRODUCT_FEATURES.every((feature) => compatibility.features[feature])).toBe(true);
    expect(serverFeatureEnabled("remoteWorkspaces", undefined)).toBe(true);
    expect(serverFeatureEnabled("openworkCloud", undefined)).toBe(true);

    expect(resolveWorkspaceOpencodeConnection(
      {
        opencodeBaseUrl: "https://upstream-remote.invalid",
        opencodeUsername: "upstream-user",
        opencodePassword: "upstream-password",
      },
      {
        id: "upstream_fixture",
        name: "Upstream fixture",
        path: "/tmp/upstream-fixture",
        preset: "starter",
        workspaceType: "local",
      },
    )).toEqual({
      baseUrl: "https://upstream-remote.invalid",
      authHeader: `Basic ${Buffer.from("upstream-user:upstream-password").toString("base64")}`,
    });
  });
});
