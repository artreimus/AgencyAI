import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { resolveOpencodeModelsUrl } from "./opencode-models-url.js";
import { LOCAL_STORAGE_LAYOUT_PATH_KEYS } from "./storage-layout-env.js";

function restoreProcessEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

async function writeFakeOpencodeBin(root: string): Promise<string> {
  const binPath = join(root, "fake-opencode.mjs");
  await writeFile(binPath, [
    "#!/usr/bin/env bun",
    "const portIndex = process.argv.indexOf(\"--port\");",
    "const port = portIndex >= 0 ? process.argv[portIndex + 1] : \"0\";",
    "const capturePath = process.env.OPENWORK_CAPTURE_MODELS_URL_FILE;",
    "if (capturePath) await Bun.write(capturePath, process.env.OPENCODE_MODELS_URL ?? \"\");",
    "console.log(`opencode server listening on http://127.0.0.1:${port}`);",
    "process.on(\"SIGTERM\", () => process.exit(0));",
    "setInterval(() => undefined, 1_000);",
  ].join("\n"));
  await chmod(binPath, 0o755);
  return binPath;
}

function localStorageEnvironment(root: string): Record<string, string> {
  const storageRoot = join(root, "agencyai");
  return {
    OPENWORK_STORAGE_ROOT: storageRoot,
    OPENWORK_SERVER_CONFIG: join(storageRoot, "config", "openwork", "server.json"),
    OPENWORK_ENV_STORE: join(storageRoot, "config", "openwork", "env.json"),
    OPENWORK_DATA_DIR: join(storageRoot, "data", "openwork"),
    OPENWORK_CACHE_DIR: join(storageRoot, "cache", "openwork"),
    OPENWORK_DESKTOP_BOOTSTRAP_PATH: join(
      storageRoot,
      "config",
      "openwork",
      "desktop-bootstrap.json",
    ),
    OPENWORK_RUNTIME_DB: join(storageRoot, "data", "openwork", "runtime.sqlite"),
    OPENWORK_MCP_AUTH_PATH: join(storageRoot, "data", "opencode", "mcp-auth.json"),
    XDG_CONFIG_HOME: join(storageRoot, "config"),
    XDG_DATA_HOME: join(storageRoot, "data"),
    XDG_CACHE_HOME: join(storageRoot, "cache"),
    XDG_STATE_HOME: join(storageRoot, "state"),
    OPENCODE_CONFIG_DIR: join(storageRoot, "config", "opencode"),
    OPENCODE_DB: join(storageRoot, "data", "opencode", "opencode.db"),
  };
}

describe("resolveOpencodeModelsUrl", () => {
  test("honors an explicit catalog URL", async () => {
    expect(await resolveOpencodeModelsUrl({
      env: {
        OPENWORK_DEV_MODE: "1",
        OPENCODE_MODELS_URL: " https://catalog.example.test/models ",
      },
    })).toBe("https://catalog.example.test/models");
  });

  test("uses the production catalog outside development", async () => {
    expect(await resolveOpencodeModelsUrl({ env: {} })).toBe("https://models.openworklabs.com/");
  });

  test("uses the local catalog when the development server is available", async () => {
    expect(await resolveOpencodeModelsUrl({
      env: { OPENWORK_DEV_MODE: "1" },
      fetchModels: async () => new Response(null, { status: 200 }),
    })).toBe("http://localhost:8791/models");
  });

  test("falls back to the production catalog when the development server is unavailable", async () => {
    expect(await resolveOpencodeModelsUrl({
      env: { OPENWORK_DEV_MODE: "1" },
      fetchModels: async () => new Response(null, { status: 503 }),
    })).toBe("https://models.openworklabs.com/");
  });
});

describe("startEmbeddedServer managed OpenCode models URL", () => {
  test("injects an explicit OPENCODE_MODELS_URL override", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-embedded-models-url-"));
    const workspace = join(root, "workspace");
    const capturePath = join(root, "models-url.txt");
    await mkdir(workspace, { recursive: true });
    const opencodeBin = await writeFakeOpencodeBin(root);

    const previousDevMode = process.env.OPENWORK_DEV_MODE;
    const previousModelsUrl = process.env.OPENCODE_MODELS_URL;
    const previousCapturePath = process.env.OPENWORK_CAPTURE_MODELS_URL_FILE;
    const previousHome = process.env.HOME;
    const previousOpencodeBaseUrl = process.env.OPENWORK_OPENCODE_BASE_URL;
    const storageEnv = localStorageEnvironment(root);
    const storageEnvKeys = [
      "OPENWORK_STORAGE_ROOT",
      ...LOCAL_STORAGE_LAYOUT_PATH_KEYS,
    ];
    const previousStorageEnv = new Map(
      storageEnvKeys.map((key) => [key, process.env[key]]),
    );

    try {
      Object.assign(process.env, storageEnv);
      process.env.OPENWORK_DEV_MODE = "1";
      process.env.OPENCODE_MODELS_URL = "https://catalog.example.test/models";
      process.env.OPENWORK_CAPTURE_MODELS_URL_FILE = capturePath;
      process.env.HOME = join(root, "home");
      delete process.env.OPENWORK_OPENCODE_BASE_URL;

      const { startEmbeddedServer } = await import("./embedded.js");
      const handle = await startEmbeddedServer({
        configPath: storageEnv.OPENWORK_SERVER_CONFIG,
        host: "127.0.0.1",
        port: 0,
        token: "server-token",
        hostToken: "host-token",
        workspaces: [workspace],
        manageOpencode: true,
        opencodeBin,
        opencodeCwd: workspace,
      });
      await handle.stop();

      expect(await readFile(capturePath, "utf8")).toBe("https://catalog.example.test/models");
    } finally {
      restoreProcessEnv("OPENWORK_DEV_MODE", previousDevMode);
      restoreProcessEnv("OPENCODE_MODELS_URL", previousModelsUrl);
      restoreProcessEnv("OPENWORK_CAPTURE_MODELS_URL_FILE", previousCapturePath);
      restoreProcessEnv("HOME", previousHome);
      restoreProcessEnv("OPENWORK_OPENCODE_BASE_URL", previousOpencodeBaseUrl);
      for (const [key, value] of previousStorageEnv) {
        restoreProcessEnv(key, value);
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
