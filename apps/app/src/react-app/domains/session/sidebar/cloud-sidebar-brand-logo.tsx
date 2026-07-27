/** @jsxImportSource react */
import { useBrandLogoUrl } from "../../cloud/brand-theme";

export function CloudSidebarBrandLogo() {
  const brandLogoUrl = useBrandLogoUrl();
  if (!brandLogoUrl) return null;
  return (
    <div
      data-testid="brand-logo"
      className="flex h-14 shrink-0 items-center px-3 pb-3 pt-2 mac:pt-0"
    >
      <img
        src={brandLogoUrl}
        alt="Organization logo"
        className="max-h-9 w-auto max-w-[140px] object-contain object-left"
      />
    </div>
  );
}
