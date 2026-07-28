import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { randomUUID } from "node:crypto";

export type ManagedOpencodeServer = {
  url: string;
  username: string;
  password: string;
  pid: number | null;
  execution: OpencodeExecutionSnapshot;
  isAlive: () => boolean;
  close: () => Promise<void>;
};

export type OpencodeExecutionEnvEntry = {
  name: string;
  value: string;
  redacted: boolean;
};

export type OpencodeExecutionSnapshot = {
  command: string;
  args: string[];
  cwd: string;
  env: OpencodeExecutionEnvEntry[];
};

const SECRET_ENV_PATTERN = /(TOKEN|PASSWORD|USERNAME|AUTH|SECRET|KEY|CREDENTIAL)/i;
const NON_SECRET_STORAGE_ENV_NAMES = new Set([
  "OPENWORK_CACHE_DIR",
  "OPENWORK_DATA_DIR",
  "OPENWORK_DESKTOP_BOOTSTRAP_PATH",
  "OPENWORK_ENV_STORE",
  "OPENWORK_MCP_AUTH_PATH",
  "OPENWORK_RUNTIME_DB",
  "OPENWORK_SERVER_CONFIG",
  "OPENWORK_STORAGE_ROOT",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DB",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);

function isSecretEnvironmentName(name: string): boolean {
  return !NON_SECRET_STORAGE_ENV_NAMES.has(name) && SECRET_ENV_PATTERN.test(name);
}

function randomSecret(): string {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

async function findFreePortOnce(hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Failed to resolve free port"));
      });
    });
  });
}

async function findFreePort(hostname: string, excludedPorts: number[] = []): Promise<number> {
  const excluded = new Set(
    excludedPorts.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535),
  );
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await findFreePortOnce(hostname);
    if (!excluded.has(port)) return port;
  }
  throw new Error("Failed to resolve free port outside the excluded set");
}

export async function waitForManagedOpencodeReady(options: {
  url: string;
  username: string;
  password: string;
  expectedVersion: string;
  timeoutMs: number;
  fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  isAlive?: () => boolean;
  startupOutput?: () => string;
}): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  const fetchImpl = options.fetchImpl ?? fetch;
  const authorization = `Basic ${Buffer.from(
    `${options.username}:${options.password}`,
  ).toString("base64")}`;
  let lastError = "OpenCode readiness probe did not succeed";

  while (Date.now() < deadline) {
    if (options.isAlive && !options.isAlive()) {
      const output = options.startupOutput?.().trim();
      throw new Error(
        `OpenCode server exited before readiness${output ? `\n${output}` : ""}`,
      );
    }
    try {
      const response = await fetchImpl(
        `${options.url.replace(/\/+$/, "")}/global/health`,
        {
          headers: {
            Accept: "application/json",
            Authorization: authorization,
          },
          redirect: "error",
          signal: AbortSignal.timeout(
            Math.min(1_000, Math.max(1, options.timeoutMs)),
          ),
        },
      );
      const payload = response.ok ? await response.json() as unknown : null;
      if (
        response.ok
        && payload
        && typeof payload === "object"
        && !Array.isArray(payload)
        && Object.keys(payload).sort().join(",") === "healthy,version"
        && (payload as Record<string, unknown>).healthy === true
        && (payload as Record<string, unknown>).version === options.expectedVersion
      ) {
        return;
      }
      lastError = response.ok
        ? "OpenCode health response did not match the pinned runtime contract"
        : `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const output = options.startupOutput?.().trim();
  throw new Error(
    `Timeout waiting for exact OpenCode ${options.expectedVersion} readiness: ${lastError}${
      output ? `\n${output}` : ""
    }`,
  );
}

export async function createManagedOpencodeServer(options: {
  bin?: string;
  cwd: string;
  hostname?: string;
  port?: number;
  excludedPorts?: number[];
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  parentEnv?: NodeJS.ProcessEnv;
  corsOrigins?: string[];
  expectedVersion?: string;
}): Promise<ManagedOpencodeServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? await findFreePort(hostname, options.excludedPorts);
  const username = randomSecret();
  const password = randomSecret();
  const corsOrigins = options.corsOrigins?.filter((origin) => origin.trim()) ?? [];
  const args = [
    "serve",
    "--hostname",
    hostname,
    "--port",
    String(port),
    ...corsOrigins.flatMap((origin) => ["--cors", origin]),
  ];
  const command = options.bin?.trim() || "opencode";
  const env = {
    ...(options.parentEnv ?? process.env),
    ...options.env,
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
  };
  const injectedEnv = Object.entries({
    ...(options.env ?? {}),
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
  })
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, value]) => ({
      name,
      value: isSecretEnvironmentName(name) ? "<redacted>" : value,
      redacted: isSecretEnvironmentName(name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const child: ChildProcess = spawn(command, args, {
    cwd: options.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let closePromise: Promise<void> | null = null;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  let startupOutput = "";
  const appendStartupOutput = (chunk: unknown) => {
    startupOutput += String(chunk);
    if (startupOutput.length > 8_000) {
      startupOutput = startupOutput.slice(startupOutput.length - 8_000);
    }
  };

  let url: string;
  if (options.expectedVersion) {
    const urlHostname = hostname.includes(":") ? `[${hostname}]` : hostname;
    url = `http://${urlHostname}:${port}`;
    child.stdout?.on("data", appendStartupOutput);
    child.stderr?.on("data", appendStartupOutput);
    try {
      await waitForManagedOpencodeReady({
        url,
        username,
        password,
        expectedVersion: options.expectedVersion,
        timeoutMs: options.timeoutMs ?? 15_000,
        isAlive: () =>
          child.exitCode === null
          && child.signalCode === null
          && !child.killed,
        startupOutput: () => startupOutput,
      });
    } catch (error) {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      throw error;
    }
  } else {
    url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for OpenCode server after ${options.timeoutMs ?? 15000}ms`)), options.timeoutMs ?? 15000);
    let output = "";
    const done = (value: string) => {
      clearTimeout(timeout);
      resolve(value);
    };
    const fail = (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    };
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      for (const line of output.split("\n")) {
        if (!line.startsWith("opencode server listening")) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match?.[1]) return fail(new Error(`Failed to parse OpenCode server URL from: ${line}`));
        done(match[1]);
      }
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(`OpenCode server exited with code ${code}${output.trim() ? `\n${output}` : ""}`)));
    });
  }

  return {
    url,
    username,
    password,
    pid: child.pid ?? null,
    execution: {
      command,
      args,
      cwd: options.cwd,
      env: injectedEnv,
    },
    isAlive() {
      return child.exitCode === null && child.signalCode === null && !child.killed;
    },
    close() {
      closePromise ??= (async () => {
        if (child.exitCode !== null) return;
        if (!child.killed) child.kill("SIGTERM");
        const timeout = new Promise<void>((resolve) => {
          setTimeout(() => resolve(), 1000);
        });
        await Promise.race([exited, timeout]);
        if (child.exitCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Process already exited.
          }
          await Promise.race([exited, new Promise<void>((resolve) => setTimeout(() => resolve(), 500))]);
        }
      })();
      return closePromise;
    },
  };
}
