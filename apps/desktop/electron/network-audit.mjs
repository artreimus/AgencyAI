import { appendFileSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export const NETWORK_AUDIT_MODES = Object.freeze([
  "audit",
  "deny-non-loopback",
]);

export class NetworkAuditDeniedError extends Error {
  constructor(origin) {
    super(`Network audit denied non-loopback destination: ${origin}`);
    this.name = "NetworkAuditDeniedError";
    this.code = "agencyai_network_denied";
    this.origin = origin;
  }
}

const auditedFetchTargets = new WeakSet();

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function isLoopbackHostname(hostname) {
  const normalized = String(hostname ?? "").trim().toLowerCase();
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || (
      ipv4 !== null
      && Number(ipv4[1]) === 127
      && ipv4.slice(1).every((part) => Number(part) <= 255)
    )
    || normalized === "::1"
    || normalized === "[::1]";
}

function normalizedDestination(input) {
  const raw =
    input instanceof URL
      ? input.toString()
      : typeof input === "string"
        ? input
        : typeof input?.url === "string"
          ? input.url
          : "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    return null;
  }
  return {
    origin: parsed.origin,
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || null,
    loopback: isLoopbackHostname(parsed.hostname),
  };
}

function assertAuditPath(auditPath, storageRoot) {
  invariant(path.isAbsolute(auditPath), "Network audit path must be absolute");
  invariant(path.isAbsolute(storageRoot), "Storage root must be absolute");
  const root = realpathSync(storageRoot);
  const requested = path.resolve(auditPath);
  const resolved = path.join(
    realpathSync(path.dirname(requested)),
    path.basename(requested),
  );
  const relative = path.relative(root, resolved);
  invariant(
    relative
      && !relative.startsWith("..")
      && !path.isAbsolute(relative),
    "Network audit path must be a descendant of the AgencyAI storage root",
  );
  let current = root;
  for (const segment of path.dirname(relative).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stats = lstatSync(current);
    invariant(
      stats.isDirectory() && !stats.isSymbolicLink(),
      "Network audit path cannot traverse symbolic links",
    );
  }
  return resolved;
}

export function createNetworkAudit({
  mode,
  auditPath,
  storageRoot,
  append = appendFileSync,
  now = () => new Date().toISOString(),
}) {
  invariant(
    NETWORK_AUDIT_MODES.includes(mode),
    `Unsupported network audit mode: ${mode}`,
  );
  const resolvedAuditPath = assertAuditPath(auditPath, storageRoot);

  function inspect(input, { source, method = "GET" }) {
    const destination = normalizedDestination(input);
    if (!destination) return { allowed: true, destination: null };
    const allowed =
      mode !== "deny-non-loopback" || destination.loopback;
    const record = {
      schemaVersion: 1,
      at: now(),
      source,
      method: String(method || "GET").toUpperCase(),
      origin: destination.origin,
      protocol: destination.protocol,
      hostname: destination.hostname,
      port: destination.port,
      loopback: destination.loopback,
      decision: allowed ? "allow" : "deny",
    };
    append(resolvedAuditPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return { allowed, destination, record };
  }

  /**
   * @param {any} target
   */
  function installGlobalFetch(target = globalThis) {
    invariant(typeof target.fetch === "function", "Global fetch is unavailable");
    if (auditedFetchTargets.has(target)) return target.fetch;
    const originalFetch = target.fetch.bind(target);
    const auditedFetch = function auditedFetch(input, init) {
      const result = inspect(input, {
        source: "global-fetch",
        method: init?.method ?? input?.method ?? "GET",
      });
      if (!result.allowed) {
        return Promise.reject(
          new NetworkAuditDeniedError(result.destination.origin),
        );
      }
      return originalFetch(input, init);
    };
    target.fetch = auditedFetch;
    auditedFetchTargets.add(target);
    return auditedFetch;
  }

  function installElectronSession(electronSession, label) {
    invariant(
      typeof electronSession?.webRequest?.onBeforeRequest === "function",
      "Electron session does not expose webRequest.onBeforeRequest",
    );
    electronSession.webRequest.onBeforeRequest(
      {
        urls: [
          "http://*/*",
          "https://*/*",
          "ws://*/*",
          "wss://*/*",
        ],
      },
      (details, callback) => {
        try {
          const result = inspect(details.url, {
            source: `electron-session:${label}`,
            method: details.method,
          });
          callback(result.allowed ? {} : { cancel: true });
        } catch {
          callback({ cancel: true });
        }
      },
    );
  }

  return Object.freeze({
    auditPath: resolvedAuditPath,
    inspect,
    installElectronSession,
    installGlobalFetch,
    mode,
  });
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   storageRoot: string,
 * }} options
 */
export function createNetworkAuditFromEnvironment({
  env = process.env,
  storageRoot,
}) {
  const mode = env.AGENCYAI_NETWORK_AUDIT_MODE?.trim() ?? "";
  if (!mode) return null;
  const auditPath = env.AGENCYAI_NETWORK_AUDIT_FILE?.trim() ?? "";
  invariant(auditPath, "AGENCYAI_NETWORK_AUDIT_FILE is required when audit mode is enabled");
  return createNetworkAudit({ mode, auditPath, storageRoot });
}
