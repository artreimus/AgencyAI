import { createHash, randomBytes } from "node:crypto";

export const AGENCYAI_DESKTOP_APPROVAL_HEADER = "X-AgencyAI-Desktop-Approval";
export const DEFAULT_DESKTOP_APPROVAL_CREDENTIAL_TTL_MS = 30_000;

export const TRUSTED_DESKTOP_OPERATIONS = [
  "config.runtime_migrate",
  "config.patch",
  "config.write",
  "skills.upsert",
  "skills.delete",
  "mcp.add",
  "mcp.remove",
  "mcp.enable",
  "mcp.disable",
  "commands.upsert",
  "commands.delete",
  "config.import",
  "workspace.inbox.upload",
  "workspace.files.session.ops",
  "workspace.file.write",
] as const;

export type TrustedDesktopOperation = (typeof TRUSTED_DESKTOP_OPERATIONS)[number];

export type DesktopApprovalActor = {
  type: "desktop";
  credentialId: string;
  webContentsId: number;
  workspaceId: string;
  operation: TrustedDesktopOperation;
};

export type ApiApprovalActor = {
  type: "api";
  clientId: string;
};

export type ApprovalActor = DesktopApprovalActor | ApiApprovalActor;

export type DesktopApprovalGrant = {
  credential: string;
  credentialId: string;
  serverOrigin: string;
  workspaceId: string;
  operation: TrustedDesktopOperation;
  issuedAt: number;
  expiresAt: number;
};

export type DesktopApprovalCredentialIssueInput = {
  bearerToken: string;
  rendererOrigin: string;
  serverOrigin: string;
  webContentsId: number;
  workspaceId: string;
  operation: TrustedDesktopOperation;
};

export type DesktopApprovalCredentialAuthenticationInput = {
  credential: string;
  bearerToken: string;
  rendererOrigin: string;
  serverOrigin: string;
  workspaceId: string;
  operation: TrustedDesktopOperation;
};

export type DesktopApprovalCredentialErrorCode =
  | "desktop_approval_invalid"
  | "desktop_approval_scope_mismatch";

export class DesktopApprovalCredentialError extends Error {
  readonly status: 401 | 403;
  readonly code: DesktopApprovalCredentialErrorCode;

  constructor(status: 401 | 403, code: DesktopApprovalCredentialErrorCode) {
    super(
      code === "desktop_approval_invalid"
        ? "Invalid desktop approval credential"
        : "Desktop approval credential is outside its authorized scope",
    );
    this.name = "DesktopApprovalCredentialError";
    this.status = status;
    this.code = code;
  }
}

type DesktopApprovalCredentialRecord = {
  credentialId: string;
  tokenHash: string;
  bearerTokenHash: string;
  rendererOrigin: string;
  serverOrigin: string;
  webContentsId: number;
  workspaceId: string;
  operation: TrustedDesktopOperation;
  issuedAt: number;
  expiresAt: number;
};

export type DesktopApprovalCredentialServiceOptions = {
  ttlMs?: number;
  now?: () => number;
};

const trustedDesktopOperations = new Set<string>(TRUSTED_DESKTOP_OPERATIONS);
const CREDENTIAL_PATTERN = /^aai_da_[A-Za-z0-9_-]{43}$/;

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRequiredValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(`${label} is required`);
  }
  return normalized;
}

function normalizeOrigin(value: string, label: string): string {
  const normalized = normalizeRequiredValue(value, label);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new TypeError(`${label} must be an absolute origin`);
  }
  if (
    !parsed.protocol ||
    !parsed.host ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError(`${label} must be an origin without credentials, path, query, or fragment`);
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function normalizeOperation(value: string): TrustedDesktopOperation {
  if (!trustedDesktopOperations.has(value)) {
    throw new TypeError(`Unsupported trusted desktop operation: ${value}`);
  }
  return value as TrustedDesktopOperation;
}

function normalizeWebContentsId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("webContentsId must be a positive safe integer");
  }
  return value;
}

function invalidCredential(): never {
  throw new DesktopApprovalCredentialError(401, "desktop_approval_invalid");
}

function scopeMismatch(): never {
  throw new DesktopApprovalCredentialError(403, "desktop_approval_scope_mismatch");
}

/**
 * Issues process-local, single-use credentials for reviewed desktop wrapper
 * operations. Only hashes and non-secret binding metadata are retained.
 */
export class DesktopApprovalCredentialService {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly records = new Map<string, DesktopApprovalCredentialRecord>();

  constructor(options: DesktopApprovalCredentialServiceOptions = {}) {
    const ttlMs = options.ttlMs ?? DEFAULT_DESKTOP_APPROVAL_CREDENTIAL_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new TypeError("ttlMs must be a positive safe integer");
    }
    this.ttlMs = ttlMs;
    this.now = options.now ?? Date.now;
  }

  issue(input: DesktopApprovalCredentialIssueInput): DesktopApprovalGrant {
    const bearerToken = normalizeRequiredValue(input.bearerToken, "bearerToken");
    const rendererOrigin = normalizeOrigin(input.rendererOrigin, "rendererOrigin");
    const serverOrigin = normalizeOrigin(input.serverOrigin, "serverOrigin");
    const workspaceId = normalizeRequiredValue(input.workspaceId, "workspaceId");
    const operation = normalizeOperation(input.operation);
    const webContentsId = normalizeWebContentsId(input.webContentsId);
    const issuedAt = this.now();
    const expiresAt = issuedAt + this.ttlMs;

    this.pruneExpired(issuedAt);

    const credential = `aai_da_${randomBytes(32).toString("base64url")}`;
    const credentialId = `aai_dac_${randomBytes(16).toString("base64url")}`;
    const tokenHash = hashSecret(credential);
    this.records.set(tokenHash, {
      credentialId,
      tokenHash,
      bearerTokenHash: hashSecret(bearerToken),
      rendererOrigin,
      serverOrigin,
      webContentsId,
      workspaceId,
      operation,
      issuedAt,
      expiresAt,
    });

    return {
      credential,
      credentialId,
      serverOrigin,
      workspaceId,
      operation,
      issuedAt,
      expiresAt,
    };
  }

  /**
   * Authenticates and consumes a credential synchronously. Once a known raw
   * credential is presented, it is deleted before any binding checks so a
   * failed or racing attempt cannot reuse it.
   */
  authenticateAndConsume(
    input: DesktopApprovalCredentialAuthenticationInput,
  ): DesktopApprovalActor {
    if (typeof input.credential !== "string" || !CREDENTIAL_PATTERN.test(input.credential)) {
      return invalidCredential();
    }

    const tokenHash = hashSecret(input.credential);
    const record = this.records.get(tokenHash);
    if (!record) {
      return invalidCredential();
    }
    this.records.delete(tokenHash);

    if (this.now() >= record.expiresAt) {
      return invalidCredential();
    }

    const bearerToken =
      typeof input.bearerToken === "string" ? input.bearerToken.trim() : "";
    if (!bearerToken || hashSecret(bearerToken) !== record.bearerTokenHash) {
      return invalidCredential();
    }

    let rendererOrigin: string;
    let serverOrigin: string;
    try {
      rendererOrigin = normalizeOrigin(input.rendererOrigin, "rendererOrigin");
      serverOrigin = normalizeOrigin(input.serverOrigin, "serverOrigin");
    } catch {
      return scopeMismatch();
    }

    const workspaceId =
      typeof input.workspaceId === "string" ? input.workspaceId.trim() : "";
    const operation =
      typeof input.operation === "string" && trustedDesktopOperations.has(input.operation)
        ? input.operation as TrustedDesktopOperation
        : null;

    if (
      rendererOrigin !== record.rendererOrigin ||
      serverOrigin !== record.serverOrigin ||
      workspaceId !== record.workspaceId ||
      operation !== record.operation
    ) {
      return scopeMismatch();
    }

    return {
      type: "desktop",
      credentialId: record.credentialId,
      webContentsId: record.webContentsId,
      workspaceId: record.workspaceId,
      operation: record.operation,
    };
  }

  revokeForWebContents(webContentsId: number): number {
    let revoked = 0;
    for (const [tokenHash, record] of this.records) {
      if (record.webContentsId !== webContentsId) continue;
      this.records.delete(tokenHash);
      revoked += 1;
    }
    return revoked;
  }

  revokeAll(): number {
    const revoked = this.records.size;
    this.records.clear();
    return revoked;
  }

  private pruneExpired(now: number): void {
    for (const [tokenHash, record] of this.records) {
      if (now >= record.expiresAt) {
        this.records.delete(tokenHash);
      }
    }
  }
}
