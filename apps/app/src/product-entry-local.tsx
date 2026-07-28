/** @jsxImportSource react */
import { LocalAppProviders } from "./react-app/shell/providers-local";
import { LocalAppRoot } from "./react-app/shell/app-root-local";

export async function loadProductApp() {
  return {
    Providers: LocalAppProviders,
    Root: LocalAppRoot,
  };
}
