/** @jsxImportSource react */
import { initializeDenBootstrapConfig } from "./app/lib/den";
import { getOpenWorkDeployment } from "./app/lib/openwork-deployment";
import { AppRoot } from "./react-app/shell/app-root";
import { AppProviders } from "./react-app/shell/providers";
import { startDeepLinkBridge } from "./react-app/shell/startup-deep-links";

export async function loadProductApp(root: HTMLElement) {
  startDeepLinkBridge();
  await initializeDenBootstrapConfig();
  root.dataset.openworkDeployment = getOpenWorkDeployment();
  return {
    Providers: AppProviders,
    Root: AppRoot,
  };
}
