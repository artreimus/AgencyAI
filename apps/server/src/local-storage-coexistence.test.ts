import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { LOCAL_MVP_FEATURES } from "@openwork/product-config";
import { auditLogPath, recordAudit } from "./audit.js";
import { listCommands } from "./commands.js";
import { resolveServerConfig } from "./config.js";
import { EnvService, resolveDefaultEnvStorePath } from "./env-file.js";
import {
  legacySweepStatePath,
  sweepLegacyOpenCodeConfig,
} from "./legacy-config-sweep.js";
import { resolveGlobalOpenCodeConfigPath } from "./mcp.js";
import { resolveOpencodeDbPath } from "./opencode-db.js";
import { uiControlDiscoveryPaths } from "./opencode-plugins/ui-control-discovery.js";
import { listPlugins } from "./plugins.js";
import type { ServerProductPolicy } from "./product-policy.js";
import { runtimeDbPath } from "./runtime-db.js";
import {
  resolveOpencodeConfigFilePath,
} from "./server.js";
import { listSkills } from "./skills.js";
import {
  assertLocalStorageLayoutEnvironment,
  LOCAL_STORAGE_LAYOUT_PATH_KEYS,
  resolveMcpAuthStorePath,
  resolveProfileGlobalOpencodeConfigDir,
} from "./storage-layout-env.js";
import { TokenService } from "./tokens.js";

const LOCAL_MVP_POLICY = {
  profile: "local-mvp",
  features: LOCAL_MVP_FEATURES,
  networkPolicy: "user-authorized",
  rendererOrigin: "agencyai-internal://renderer",
} satisfies ServerProductPolicy;

const roots: string[] = [];

function storageEnvironment(root: string): Record<string, string> {
  return {
    OPENWORK_STORAGE_ROOT: root,
    OPENWORK_SERVER_CONFIG: join(root, "config", "openwork", "server.json"),
    OPENWORK_ENV_STORE: join(root, "config", "openwork", "env.json"),
    OPENWORK_DATA_DIR: join(root, "data", "openwork"),
    OPENWORK_CACHE_DIR: join(root, "cache", "openwork"),
    OPENWORK_DESKTOP_BOOTSTRAP_PATH: join(
      root,
      "config",
      "openwork",
      "desktop-bootstrap.json",
    ),
    OPENWORK_RUNTIME_DB: join(root, "data", "openwork", "runtime.sqlite"),
    OPENWORK_MCP_AUTH_PATH: join(root, "data", "opencode", "mcp-auth.json"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_CONFIG_DIR: join(root, "config", "opencode"),
    OPENCODE_DB: join(root, "data", "opencode", "opencode.db"),
  };
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function snapshotBytes(
  root: string,
): Promise<Array<readonly [string, string]>> {
  const snapshot: Array<readonly [string, string]> = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const name = relative(root, path);
      if (entry.isDirectory()) {
        snapshot.push([`${name}/`, "<directory>"]);
        await visit(path);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const info = await lstat(path);
        snapshot.push([name, `<symlink:${info.size}>`]);
        continue;
      }
      snapshot.push([name, (await readFile(path)).toString("base64")]);
    }
  }

  await visit(root);
  return snapshot;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function seedUpstreamHome(home: string): Promise<void> {
  await writeText(
    join(home, ".config", "openwork", "server.json"),
    `{"upstream":"server"}\n`,
  );
  await writeText(
    join(home, ".config", "openwork", "env.json"),
    `{"upstream":"env"}\n`,
  );
  await writeText(
    join(home, ".config", "openwork", "tokens.json"),
    `{"upstream":"tokens"}\n`,
  );
  await writeText(
    join(home, ".config", "openwork", "runtime.sqlite"),
    "UPSTREAM_OPENWORK_RUNTIME_DB",
  );
  await writeText(
    join(
      home,
      ".config",
      "openwork",
      "desktop-bootstrap.json",
    ),
    `{"baseUrl":"https://upstream.invalid"}\n`,
  );
  await writeText(
    join(home, ".openwork", "openwork-server", "audit", "legacy.jsonl"),
    `{"upstream":"audit"}\n`,
  );
  await writeText(
    join(home, ".config", "opencode", "opencode.jsonc"),
    `{
  "default_agent": "openwork",
  "mcp": {"openwork-cloud": {"type": "remote"}},
  "plugin": ["openwork-capabilities-knowledge"]
}\n`,
  );
  await writeText(
    join(home, ".config", "opencode", "mcp-auth.json"),
    `{"upstream":"mcp-auth"}\n`,
  );
  await writeText(
    join(home, ".config", "opencode", "plugins", "upstream-plugin.js"),
    `export default "upstream";\n`,
  );
  await writeText(
    join(home, ".config", "opencode", "commands", "upstream-command.md"),
    "---\nname: upstream-command\ndescription: Upstream command\nmodel: null\n---\nDo not mutate me\n",
  );
  await writeText(
    join(
      home,
      ".config",
      "opencode",
      "skills",
      "upstream-skill",
      "SKILL.md",
    ),
    "---\nname: upstream-skill\ndescription: Upstream skill\n---\n\nDo not read me\n",
  );
  await writeText(
    join(home, ".local", "share", "opencode", "opencode.db"),
    "UPSTREAM_OPENCODE_DB",
  );
  await writeText(
    join(home, ".local", "share", "opencode", "mcp-auth.json"),
    `{"upstream":"xdg-mcp-auth"}\n`,
  );
  await writeText(
    join(
      home,
      "Library",
      "Application Support",
      "com.differentai.openwork",
      "openwork-ui-control.json",
    ),
    `{"baseUrl":"http://127.0.0.1:9","token":"upstream"}\n`,
  );
}

async function seedAgencyLayout(
  env: Record<string, string>,
): Promise<void> {
  await writeText(env.OPENWORK_SERVER_CONFIG, "{}\n");
  await writeText(env.OPENWORK_ENV_STORE, `{"schemaVersion":1,"variables":[]}\n`);
  await writeText(
    env.OPENWORK_DESKTOP_BOOTSTRAP_PATH,
    `{"product":"agencyai"}\n`,
  );
  await writeText(
    join(env.OPENCODE_CONFIG_DIR, "opencode.jsonc"),
    `{"plugin":["agency-config-plugin"]}\n`,
  );
  await writeText(
    join(env.OPENCODE_CONFIG_DIR, "plugins", "agency-plugin.js"),
    `export default "agencyai";\n`,
  );
  await writeText(
    join(env.OPENCODE_CONFIG_DIR, "commands", "agency-command.md"),
    "---\nname: agency-command\ndescription: Agency command\n---\nRun locally\n",
  );
  await writeText(
    join(
      env.OPENCODE_CONFIG_DIR,
      "skills",
      "agency-skill",
      "SKILL.md",
    ),
    "---\nname: agency-skill\ndescription: Agency skill\n---\n\nUse locally\n",
  );
  await writeText(env.OPENWORK_MCP_AUTH_PATH, `{"agencyai":"mcp-auth"}\n`);
  await writeText(env.OPENCODE_DB, "AGENCYAI_OPENCODE_DB");
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("local-mvp StorageLayout contract", () => {
  test("requires every absolute application path below one root", async () => {
    const root = await createRoot("agencyai-storage-contract-");
    const env = storageEnvironment(root);

    expect(() => assertLocalStorageLayoutEnvironment({
      env,
      productPolicy: LOCAL_MVP_POLICY,
    })).not.toThrow();

    expect(() => assertLocalStorageLayoutEnvironment({
      env: { ...env, OPENWORK_RUNTIME_DB: undefined },
      productPolicy: LOCAL_MVP_POLICY,
    })).toThrow("OPENWORK_RUNTIME_DB");

    expect(() => assertLocalStorageLayoutEnvironment({
      env: { ...env, OPENCODE_DB: "relative/opencode.db" },
      productPolicy: LOCAL_MVP_POLICY,
    })).toThrow("OPENCODE_DB to be an absolute path");

    expect(() => assertLocalStorageLayoutEnvironment({
      env: { ...env, OPENWORK_MCP_AUTH_PATH: join(root, "..", "shared", "mcp-auth.json") },
      productPolicy: LOCAL_MVP_POLICY,
    })).toThrow("OPENWORK_MCP_AUTH_PATH to stay inside");

    expect(() => assertLocalStorageLayoutEnvironment({
      env: {
        ...env,
        OPENWORK_RUNTIME_DB: join(root, "same"),
        OPENCODE_DB: join(root, "same"),
      },
      productPolicy: LOCAL_MVP_POLICY,
    })).toThrow("OPENWORK_RUNTIME_DB to match the exact StorageLayout path");

    const attestation = assertLocalStorageLayoutEnvironment({
      env,
      productPolicy: LOCAL_MVP_POLICY,
    });
    expect(attestation).toEqual({
      root,
      environment: env,
    });
    expect(Object.isFrozen(attestation)).toBe(true);
    expect(Object.isFrozen(attestation?.environment)).toBe(true);
    expect(attestation?.environment.OPENWORK_RUNTIME_DB).not.toBe(
      attestation?.environment.OPENCODE_DB,
    );
  });
});

describe("local-mvp hostile-state coexistence", () => {
  test("uses only AgencyAI state and leaves upstream HOME byte-for-byte unchanged", async () => {
    const root = await createRoot("agencyai-coexistence-");
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const agencyRoot = join(root, "agencyai");
    const env = storageEnvironment(agencyRoot);
    const uiControlPath = join(
      agencyRoot,
      "electron",
      "user-data",
      "openwork-ui-control.json",
    );

    await mkdir(join(workspace, ".git"), { recursive: true });
    await writeText(
      join(workspace, ".opencode", "skills", "workspace-skill", "SKILL.md"),
      "---\nname: workspace-skill\ndescription: Workspace skill\n---\n\nUse in this workspace\n",
    );
    await seedUpstreamHome(home);
    await seedAgencyLayout(env);
    await writeText(
      uiControlPath,
      `{"baseUrl":"http://127.0.0.1:47831","token":"agencyai"}\n`,
    );

    const before = await snapshotBytes(home);
    const managedKeys = [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "OPENWORK_STORAGE_ROOT",
      ...LOCAL_STORAGE_LAYOUT_PATH_KEYS,
      "OPENWORK_UI_CONTROL_DISCOVERY",
      "OPENWORK_TOKEN_STORE",
      "OPENWORK_WORKSPACES",
    ];
    const previousEnv = new Map(
      managedKeys.map((key) => [key, process.env[key]]),
    );

    try {
      Object.assign(process.env, env, {
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, "AppData", "Roaming"),
        OPENWORK_UI_CONTROL_DISCOVERY: uiControlPath,
      });
      delete process.env.OPENWORK_TOKEN_STORE;
      delete process.env.OPENWORK_WORKSPACES;

      assertLocalStorageLayoutEnvironment();
      expect(process.env.HOME).toBe(home);
      expect(process.env.USERPROFILE).toBe(home);
      const config = await resolveServerConfig({
        workspaces: [workspace],
      });
      const resolvedWorkspace = config.workspaces[0];
      if (!resolvedWorkspace) {
        throw new Error("expected one resolved workspace");
      }

      expect(config.configPath).toBe(env.OPENWORK_SERVER_CONFIG);
      expect(runtimeDbPath(config)).toBe(env.OPENWORK_RUNTIME_DB);
      expect(resolveDefaultEnvStorePath()).toBe(env.OPENWORK_ENV_STORE);
      expect(auditLogPath(resolvedWorkspace.id)).toBe(
        join(env.OPENWORK_DATA_DIR, "audit", `${resolvedWorkspace.id}.jsonl`),
      );
      expect(resolveProfileGlobalOpencodeConfigDir()).toBe(
        env.OPENCODE_CONFIG_DIR,
      );
      expect(resolveGlobalOpenCodeConfigPath()).toBe(
        join(env.OPENCODE_CONFIG_DIR, "opencode.jsonc"),
      );
      expect(resolveOpencodeConfigFilePath("global", workspace)).toBe(
        join(env.OPENCODE_CONFIG_DIR, "opencode.jsonc"),
      );
      expect(resolveMcpAuthStorePath()).toBe(env.OPENWORK_MCP_AUTH_PATH);
      expect(resolveOpencodeDbPath()).toBe(env.OPENCODE_DB);

      const plugins = await listPlugins(
        config,
        resolvedWorkspace.id,
        workspace,
        true,
      );
      expect(plugins.items.some((item) => item.spec.includes("agency-plugin.js"))).toBe(true);
      expect(plugins.items.some((item) => item.spec.includes("upstream-plugin.js"))).toBe(false);

      const commands = await listCommands(workspace, "global");
      expect(commands.map((command) => command.name)).toEqual([
        "agency-command",
      ]);

      const skills = await listSkills(workspace, true);
      expect(skills.map((skill) => skill.name)).toContain("workspace-skill");
      expect(skills.map((skill) => skill.name)).toContain("agency-skill");
      expect(skills.map((skill) => skill.name)).not.toContain("upstream-skill");

      expect(uiControlDiscoveryPaths({
        env: {
          ...env,
          OPENWORK_UI_CONTROL_DISCOVERY: uiControlPath,
        },
        homeDir: home,
        platform: "darwin",
        productPolicy: LOCAL_MVP_POLICY,
      })).toEqual([uiControlPath]);
      expect(uiControlDiscoveryPaths({
        env,
        homeDir: home,
        platform: "darwin",
        productPolicy: LOCAL_MVP_POLICY,
      })).toEqual([]);
      expect(uiControlDiscoveryPaths({
        env: {
          ...env,
          OPENWORK_UI_CONTROL_DISCOVERY: join(
            home,
            "Library",
            "Application Support",
            "com.differentai.openwork",
            "openwork-ui-control.json",
          ),
        },
        homeDir: home,
        platform: "darwin",
        productPolicy: LOCAL_MVP_POLICY,
      })).toEqual([]);

      const sweep = await sweepLegacyOpenCodeConfig(config, {
        homeDir: home,
        productPolicy: LOCAL_MVP_POLICY,
      });
      expect(sweep.files).toEqual([]);
      expect(sweep.skipped).toBe("feature_disabled");
      expect(await Bun.file(legacySweepStatePath(config)).exists()).toBe(false);

      const envService = new EnvService();
      await envService.upsertMany([
        { key: "ANTHROPIC_API_KEY", value: "fixture" },
      ]);
      const tokenService = new TokenService(config);
      await tokenService.create("viewer", { label: "fixture" });
      await recordAudit(workspace, {
        id: "audit_agencyai_fixture",
        workspaceId: resolvedWorkspace.id,
        actor: { type: "host" },
        action: "coexistence.verify",
        target: workspace,
        summary: "Verify isolated AgencyAI storage",
        timestamp: Date.now(),
      });

      expect(await Bun.file(env.OPENWORK_ENV_STORE).exists()).toBe(true);
      expect(
        await Bun.file(
          join(dirname(env.OPENWORK_SERVER_CONFIG), "tokens.json"),
        ).exists(),
      ).toBe(true);
      expect(await Bun.file(env.OPENWORK_RUNTIME_DB).exists()).toBe(true);

      expect(process.env.HOME).toBe(home);
      expect(process.env.USERPROFILE).toBe(home);
      expect(await snapshotBytes(home)).toEqual(before);
    } finally {
      for (const [key, value] of previousEnv) {
        restoreEnv(key, value);
      }
    }
  });
});
