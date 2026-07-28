import { spawn } from "node:child_process";
import { isIP } from "node:net";

const DEFAULT_TIMEOUT_MS = 4000;
const EXTERNAL_URL_DENIED_MESSAGE =
  "Only public HTTPS URLs can be opened externally.";

function describeError(error) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error ?? "unknown error");
}

async function defaultOpenExternal(url) {
  const electron = await import("electron");
  if (typeof electron.shell?.openExternal !== "function") {
    throw new Error("Electron shell.openExternal is unavailable");
  }
  await electron.shell.openExternal(url);
}

function normalizedHostname(url) {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isLoopbackOrDeceptiveHostname(hostname) {
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.startsWith("localhost.") ||
    hostname === "0.0.0.0" ||
    hostname.startsWith("127.") ||
    hostname === "::" ||
    hostname === "::1" ||
    hostname.startsWith("::ffff:127.")
  ) {
    return true;
  }

  if (isIP(hostname) !== 0) return false;
  return /^(?:0|127)(?:[.-]|$)/.test(hostname);
}

export function normalizeExternalHttpsUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) throw new Error(EXTERNAL_URL_DENIED_MESSAGE);

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(EXTERNAL_URL_DENIED_MESSAGE);
  }
  const hostname = normalizedHostname(url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !hostname ||
    isLoopbackOrDeceptiveHostname(hostname)
  ) {
    throw new Error(EXTERNAL_URL_DENIED_MESSAGE);
  }
  return url.toString();
}

export function isAllowedExternalHttpsUrl(value) {
  try {
    normalizeExternalHttpsUrl(value);
    return true;
  } catch {
    return false;
  }
}

export async function openExternalUrl(url, deps = {}) {
  let normalizedUrl;
  try {
    normalizedUrl = normalizeExternalHttpsUrl(url);
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }

  const env = deps.env ?? process.env;
  if (env.OPENWORK_SIMULATE_OPEN_EXTERNAL_FAILURE === "1") {
    const message = "simulated failure";
    // why: enables evals to prove the failure UX without breaking a real machine.
    console.error("[shell] openExternal failed:", message);
    return { ok: false, error: message };
  }

  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
  const openExternal = deps.openExternal ?? defaultOpenExternal;
  let timeoutId = null;

  try {
    // why: shell.openExternal can hang forever on Windows machines with broken https URL associations; silence is the bug we're fixing.
    await Promise.race([
      Promise.resolve().then(() => openExternal(normalizedUrl)),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    console.error("[shell] openExternal failed:", message);

    const platform = deps.platform ?? process.platform;
    if (platform === "win32") {
      const spawnProcess = deps.spawnProcess ?? spawn;
      try {
        console.error("[shell] attempting rundll32 browser fallback");
        const child = spawnProcess("rundll32", ["url.dll,FileProtocolHandler", normalizedUrl], {
          detached: true,
          stdio: "ignore",
        });
        if (typeof child?.unref === "function") child.unref();
      } catch (spawnError) {
        console.error("[shell] rundll32 browser fallback failed:", describeError(spawnError));
      }
    }

    return { ok: false, error: message };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
