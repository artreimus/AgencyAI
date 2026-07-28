export interface ProtectedStateDirectoryEntry {
  path: string;
  type: "directory";
}

export interface ProtectedStateFileEntry {
  path: string;
  type: "file";
  size: number;
  sha256: string;
}

export interface ProtectedState {
  protectedRoots: string[];
  entries: Array<ProtectedStateDirectoryEntry | ProtectedStateFileEntry>;
  sha256: string;
}

export interface CoexistenceFixtureManifest {
  schemaVersion: number;
  root: string;
  home: string;
  appData: string;
  workspace: string;
  storageRoot: string;
  manifestPath: string;
  protectedState: ProtectedState;
}

export interface CoexistenceFixtureReport {
  schemaVersion: number;
  passed: boolean;
  root: string;
  beforeSha256: string;
  afterSha256: string;
  protectedRoots: string[];
  beforeEntries: ProtectedState["entries"];
  afterEntries: ProtectedState["entries"];
}

export function snapshotProtectedState(home: string): Promise<ProtectedState>;

export function createCoexistenceFixture(
  rootInput: string,
): Promise<CoexistenceFixtureManifest>;

export function verifyCoexistenceFixture(
  rootInput: string,
): Promise<CoexistenceFixtureReport>;
