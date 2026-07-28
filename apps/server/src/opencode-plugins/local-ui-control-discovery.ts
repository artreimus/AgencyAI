import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

type LocalUiControlDiscoveryOptions = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
}>;

export function localUiControlDiscoveryPaths(
  options?: LocalUiControlDiscoveryOptions,
): string[] {
  const env = options?.env ?? process.env;
  const explicit = env.OPENWORK_UI_CONTROL_DISCOVERY?.trim();
  const storageRoot = env.OPENWORK_STORAGE_ROOT?.trim();
  if (
    !explicit
    || !storageRoot
    || !isAbsolute(explicit)
    || !isAbsolute(storageRoot)
  ) {
    return [];
  }

  const root = resolve(storageRoot);
  const candidate = resolve(explicit);
  const child = relative(root, candidate);
  if (
    child === ".."
    || child.startsWith(`..${sep}`)
    || isAbsolute(child)
  ) {
    return [];
  }
  return [candidate];
}
