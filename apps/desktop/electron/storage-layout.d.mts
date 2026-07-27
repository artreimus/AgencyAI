export type StorageLayout = Readonly<{
  root: string;
  userData: string;
  sessionData: string;
  logs: string;
  crashDumps: string;
  openworkConfig: string;
  openworkData: string;
  openworkCache: string;
  runtimeDb: string;
  bootstrap: string;
  opencodeConfig: string;
  opencodeData: string;
  opencodeCache: string;
  opencodeState: string;
  mcpAuth: string;
}>;

export type StorageRuntimeProjection = Readonly<{
  root: string;
  environment: Readonly<Record<string, string>>;
}>;

export type ResolveStorageLayoutOptions = {
  appDataPath: string;
  appIdentifier: string;
  platform?: NodeJS.Platform;
  storageRootOverride?: string | null;
  userDataOverride?: string | null;
};

export type ResolveElectronStorageLayoutOptions = {
  appDataPath: string;
  appIdentifier: string;
  env?: NodeJS.ProcessEnv;
  isPackaged?: boolean;
  productProfile?: string;
  platform?: NodeJS.Platform;
};

export const STORAGE_LAYOUT_ENVIRONMENT_KEYS: readonly string[];

export function resolveStorageLayout(
  options: ResolveStorageLayoutOptions,
): StorageLayout;

export function resolveElectronStorageLayout(
  options: ResolveElectronStorageLayoutOptions,
): StorageLayout;

export function storageLayoutEnvironment(
  layout: StorageLayout,
): Readonly<Record<string, string>>;

export function applyStorageLayoutEnvironment(
  target: NodeJS.ProcessEnv,
  layout: StorageLayout,
): NodeJS.ProcessEnv;

export function createStorageRuntimeProjection(
  layout: StorageLayout,
  environment: NodeJS.ProcessEnv | Readonly<Record<string, string>>,
): StorageRuntimeProjection;

export function ensureStorageLayout(
  layout: StorageLayout,
  options?: {
    mkdirFn?: (
      directory: string,
      options: { recursive: true; mode: number },
    ) => Promise<unknown>;
  },
): Promise<StorageLayout>;
