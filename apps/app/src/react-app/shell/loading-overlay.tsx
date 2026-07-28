/** @jsxImportSource react */
import { getCompiledRendererProductProfile } from "../../app/lib/product-profile";
import { useBootState, useBootOverlayVisible } from "./boot-state";
import { OwDotTicker } from "./dot-ticker";

const PRODUCT = getCompiledRendererProductProfile();
const RELEASES_URL = PRODUCT.features.runtimeDownloads && PRODUCT.brand.repository
  ? `https://github.com/${PRODUCT.brand.repository.owner}/${PRODUCT.brand.repository.name}/releases`
  : null;

/**
 * Quiet, opaque boot overlay. Solid surface fill so nothing bleeds through.
 * A minimal typographic beat plus a small dot ticker. Fades once both the
 * boot hook and the first route load are ready.
 */
export function LoadingOverlay() {
  const visible = useBootOverlayVisible();
  const { phase, message, error } = useBootState();

  if (!visible) return null;

  const fading = phase === "ready";

  return (
    <div
      className={`pointer-events-auto fixed inset-0 z-[1000] flex items-center justify-center bg-dls-surface transition-opacity duration-[160ms] ${
        fading ? "opacity-0" : "opacity-100"
      }`}
      aria-live="polite"
      aria-busy={!fading}
      role="status"
    >
      <div className="flex w-full max-w-[320px] flex-col items-center gap-4 px-6 text-center">
        <OwDotTicker size="md" />
        <div className="text-[12px] leading-5 text-dls-secondary">
          {message || "Preparing workspace"}
        </div>
        {error ? (
          <div className="flex flex-col gap-2 text-[12px] leading-5 text-red-11">
            <div>{error}</div>
            {RELEASES_URL ? (
              <div className="text-dls-secondary">
                Download the latest version manually here:{" "}
                <a
                  href={RELEASES_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-dls-primary underline decoration-dls-primary/40 underline-offset-4"
                >
                  {RELEASES_URL}
                </a>
              </div>
            ) : (
              <div className="text-dls-secondary">
                Restart {PRODUCT.brand.name}. If this continues, copy diagnostics from Settings.
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
