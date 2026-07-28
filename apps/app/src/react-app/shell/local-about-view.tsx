/** @jsxImportSource react */
import { ExternalLink, ShieldCheck } from "lucide-react";
import { AGENCYAI_OPENCODE_BINARY_VERSION } from "@openwork/product-config";

import { Button } from "@/components/ui/button";
import type { AppBuildInfo } from "@/app/lib/desktop";
import openWorkLicense from "../../../../desktop/resources/licenses/OPENWORK-LICENSE.txt?raw";
import openCodeLicense from "../../../../desktop/resources/licenses/OPENCODE-LICENSE.txt?raw";

type LocalAboutViewProps = {
  buildInfo: AppBuildInfo | null;
  onOpenLink: (url: string) => void;
};

const OPEN_SOURCE_PROJECTS = Object.freeze([
  {
    name: "OpenWork",
    license: "MIT",
    copyright: "Copyright © 2026 Different AI",
    licenseText: openWorkLicense,
    sources: [
      {
        label: "Fork source",
        url: "https://github.com/artreimus/AgencyAI",
      },
      {
        label: "Upstream",
        url: "https://github.com/different-ai/openwork",
      },
    ],
  },
  {
    name: "OpenCode",
    license: "MIT",
    copyright: "Copyright © 2025 opencode",
    licenseText: openCodeLicense,
    sources: [
      {
        label: "Patched source",
        url: "https://github.com/artreimus/AgencyAI-OpenCode",
      },
      {
        label: "Upstream",
        url: "https://github.com/anomalyco/opencode",
      },
    ],
  },
]);

export function LocalAboutView({
  buildInfo,
  onOpenLink,
}: LocalAboutViewProps) {
  return (
    <div className="space-y-6" data-testid="agencyai-about-view">
      <section className="overflow-hidden rounded-3xl border border-border bg-muted/20">
        <div className="flex flex-col gap-6 p-6 sm:flex-row sm:items-center">
          <img
            src="/agencyai-mark.svg"
            alt="AgencyAI"
            className="size-20 rounded-[22px] shadow-sm"
          />
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight">AgencyAI</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              A local-first desktop agent for work on your machine.
            </p>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
              <span>App {buildInfo?.version ?? "development"}</span>
              <span>OpenCode {AGENCYAI_OPENCODE_BINARY_VERSION}</span>
              {buildInfo?.gitSha ? (
                <span>Build {buildInfo.gitSha.slice(0, 12)}</span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex items-start gap-3 border-t border-border px-6 py-4">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-10" />
          <p className="text-xs leading-5 text-muted-foreground">
            The MVP runs its workspace, server, and bundled agent engine locally.
            Provider and MCP network access happens only after you configure those services.
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Open-source notices</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            AgencyAI is a commercial fork that incorporates the following
            MIT-licensed projects. Their original copyright notices are preserved.
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Includes software derived from the OpenWork project under the MIT
            License. Includes OpenCode under the MIT License. AgencyAI is not
            endorsed by either upstream project.
          </p>
        </div>
        <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
          {OPEN_SOURCE_PROJECTS.map((project) => (
            <div
              key={project.name}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div>
                <div className="text-sm font-medium">{project.name}</div>
                <div className="text-xs text-muted-foreground">
                  {project.license} · {project.copyright}
                </div>
                <details className="mt-2 max-w-2xl">
                  <summary className="cursor-pointer text-xs font-medium text-primary">
                    Read license
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-muted p-3 text-[11px] leading-5 text-muted-foreground">
                    {project.licenseText}
                  </pre>
                </details>
              </div>
              <div className="flex flex-wrap gap-1">
                {project.sources.map((source) => (
                  <Button
                    key={source.url}
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onOpenLink(source.url)}
                  >
                    {source.label}
                    <ExternalLink className="ml-1.5 size-3.5" />
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          Complete dependency notices and machine-readable bills of materials
          are packaged with release candidates.
        </p>
      </section>
    </div>
  );
}
