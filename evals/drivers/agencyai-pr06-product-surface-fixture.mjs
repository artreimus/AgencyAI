import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RESULT_MARKER = "AGENCYAI_PR06_RESULT ";
const DRIVER_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = resolve(DRIVER_ROOT, "../..");
const EXPECTED_DOC_FILES = Object.freeze([
  "browser-and-computer-use.mdx",
  "docs.json",
  "getting-started.mdx",
  "mcp-and-skills.mdx",
  "privacy-and-security.mdx",
  "providers.mdx",
  "troubleshooting.mdx",
]);

export const FRAME_DEFINITIONS = Object.freeze([
  Object.freeze({
    frame: 1,
    id: "brand-and-build-composition",
    claim: "AgencyAI identity and the local renderer entry are selected before application startup",
  }),
  Object.freeze({
    frame: 2,
    id: "local-welcome-and-settings",
    claim: "Welcome, task creation, providers, extensions, and navigation expose only local product surfaces",
  }),
  Object.freeze({
    frame: 3,
    id: "curated-docs-and-prompts",
    claim: "Only the reviewed offline AgencyAI guides and local prompt sources are staged",
  }),
  Object.freeze({
    frame: 4,
    id: "local-docs-tools",
    claim: "The packaged local agent can search and read curated docs without hosted guidance",
  }),
  Object.freeze({
    frame: 5,
    id: "about-licenses-and-artifact-scan",
    claim: "About exposes required attribution while the renderer artifact rejects upstream product copy and vendor destinations",
  }),
  Object.freeze({
    frame: 6,
    id: "packaged-product-surface",
    claim: "The actual packaged app carries the exact AgencyAI docs, licenses, plugins, and local runtime",
  }),
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function repositoryRoot(value) {
  const root = resolve(value?.trim() || DEFAULT_REPOSITORY_ROOT);
  assert(
    statSync(join(root, "PLAN_AGENCYAI_DESKTOP_MVP.md")).isFile(),
    "AgencyAI implementation plan is missing",
  );
  return root;
}

function commandOutput(result) {
  return [
    String(result.stdout ?? "").trim(),
    String(result.stderr ?? "").trim(),
    result.error?.message ?? "",
  ].filter(Boolean).join("\n");
}

function run(root, command, args, timeoutMs = 180_000) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    shell: false,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${commandOutput(result)}`,
    );
  }
  return String(result.stdout ?? "").trim();
}

function source(root, relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function parseLastJson(output, label) {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .findLast((entry) => entry.startsWith("{") && entry.endsWith("}"));
  if (!line) throw new Error(`${label} did not print JSON evidence`);
  return JSON.parse(line);
}

function createChecks() {
  const checks = [];
  return {
    expect(condition, label, actual) {
      assert(condition, `${label}${actual === undefined ? "" : `: ${JSON.stringify(actual)}`}`);
      checks.push({
        label,
        passed: true,
        ...(actual === undefined ? {} : { actual }),
      });
    },
    list: checks,
  };
}

async function frameBrandAndComposition(root, check) {
  run(root, "node", [
    "--test",
    "apps/desktop/scripts/agencyai-brand-assets.test.mjs",
  ]);
  const entry = source(root, "apps/app/src/product-entry-local.tsx");
  const index = source(root, "apps/app/index.html");
  const overlay = source(root, "apps/app/overlay.html");
  const publicRoot = join(root, "apps/app/public");
  const desktopIcons = join(root, "apps/desktop/resources/icons");

  check.expect(
    entry.includes("LocalAppProviders")
      && entry.includes("LocalAppRoot")
      && !entry.includes("/domains/cloud/"),
    "Local build entry selects only the local provider and route composition",
  );
  check.expect(
    index.includes("<title>AgencyAI</title>")
      && overlay.includes("<title>AgencyAI Overlay</title>"),
    "Window and overlay titles use AgencyAI",
  );
  check.expect(
    existsSync(join(publicRoot, "agencyai-mark.png"))
      && !existsSync(join(publicRoot, "agencyai-mark.svg"))
      && !existsSync(join(publicRoot, "openwork-logo.svg"))
      && !existsSync(join(publicRoot, "openwork-mark.svg")),
    "Renderer assets contain only the generated AgencyAI raster mark and no upstream logo files",
  );
  check.expect(
    statSync(join(desktopIcons, "icon.icns")).size > 100_000
      && statSync(join(desktopIcons, "icon.ico")).size > 50_000
      && statSync(join(desktopIcons, "dev/icon-dev.icns")).size > 100_000,
    "Production and development desktop icon families are populated",
  );
  return {
    product: "AgencyAI",
    entry: "product-entry-local.tsx",
    rendererMark: "agencyai-mark.png",
    iconFormats: ["icns", "ico", "png"],
  };
}

async function frameLocalWelcomeAndSettings(root, check) {
  run(root, "bun", [
    "test",
    "apps/app/tests/local-renderer-composition.test.ts",
    "apps/app/tests/local-renderer-policy.test.ts",
  ]);
  const localRoot = source(root, "apps/app/src/react-app/shell/app-root-local.tsx");
  const welcome = source(root, "apps/app/src/react-app/shell/welcome-route-local.tsx");
  const hero = source(root, "apps/app/src/react-app/domains/session/chat/session-empty-hero.tsx");
  const composer = source(root, "apps/app/src/react-app/domains/session/chat/new-task-composer.tsx");
  const settings = source(root, "apps/app/src/react-app/shell/settings-route-local.tsx");
  const combined = [localRoot, welcome, hero, composer, settings].join("\n");

  check.expect(
    localRoot.includes('path="/signin/*"')
      && localRoot.includes("<Navigate to=\"/session\" replace />")
      && localRoot.includes("LocalSettingsRoute"),
    "Cloud and sign-in routes redirect into the local route graph",
  );
  check.expect(
    welcome.includes("showOpenWorkModels={false}")
      && !welcome.includes("DenAuthProvider")
      && !welcome.includes("createDenClient"),
    "First workspace setup disables hosted models and cloud bootstrap",
  );
  check.expect(
    hero.includes("What do you need done?")
      && hero.includes("Review local files")
      && composer.includes("LOCAL_BLOCKED_MCP_NAMES")
      && composer.includes('origin: "local"')
      && composer.includes("No MCP servers loaded."),
    "Task surfaces foreground local workspaces, skills, and MCP servers",
  );
  check.expect(
    settings.includes("AI Providers")
      && settings.includes('title="Extensions"')
      && settings.includes("MCP servers")
      && settings.includes("About & Licenses")
      && !combined.includes("OpenWork Cloud"),
    "Local settings expose providers, extensions, and legal information without cloud guidance",
  );
  return {
    routes: ["session", "welcome", "settings"],
    settings: ["general", "ai", "extensions", "appearance", "about"],
    hostedSurfaces: 0,
  };
}

async function frameCuratedDocsAndPrompts(root, check) {
  run(root, "node", [
    "--test",
    "apps/desktop/scripts/stage-agencyai-docs.test.mjs",
  ]);
  const output = run(root, "node", [
    "apps/desktop/scripts/stage-agencyai-docs.mjs",
  ]);
  const staged = JSON.parse(output);
  const docsRoot = join(root, "apps/desktop/.generated/agencyai-docs");
  const files = readdirSync(docsRoot).sort();
  const docsText = files.map((file) => source(docsRoot, file)).join("\n");
  const browserPrompt = source(
    root,
    "apps/app/src/app/data/commands/browser-setup.md",
  );
  const skillPrompt = source(root, "apps/app/src/app/data/skill-creator.md");

  check.expect(
    staged.ok === true
      && JSON.stringify(files) === JSON.stringify(EXPECTED_DOC_FILES),
    "Docs staging produces the exact reviewed seven-file closure",
    files,
  );
  check.expect(
    docsText.includes("Settings → AI Providers")
      && docsText.includes("Privacy and security")
      && docsText.includes("Troubleshooting"),
    "Curated docs cover setup, privacy, and recovery",
  );
  check.expect(
    !/openworklabs\.com|OpenWork Cloud|search_capabilities|execute_capability/i.test(
      docsText,
    ),
    "Curated docs contain no upstream destination or hosted capability guidance",
  );
  check.expect(
    browserPrompt.includes("AgencyAI browser")
      && skillPrompt.includes(".opencode/skills/<skill-name>/SKILL.md")
      && !/OpenWork Cloud|search_capabilities|execute_capability/i.test(
        `${browserPrompt}\n${skillPrompt}`,
      ),
    "Browser and skill prompt sources steer only to local product capabilities",
  );
  return {
    docs: files,
    prompts: ["browser-setup", "skill-creator"],
  };
}

async function frameLocalDocsTools(root, check) {
  run(root, "bun", [
    "test",
    "apps/server/src/opencode-plugins/agencyai-local-capabilities.test.ts",
  ]);
  run(root, "pnpm", ["--filter", "openwork-server", "build"]);
  const bundle = join(
    root,
    "apps/server/dist/opencode-plugins/agencyai-local-capabilities.js",
  );
  const module = await import(
    `${pathToFileURL(bundle).href}?agencyai-pr06=${Date.now()}`
  );
  const plugin = await module.AgencyAiLocalCapabilities();
  const search = JSON.parse(
    await plugin.tool.agencyai_docs_search.execute({
      query: "configure provider API key",
    }),
  );
  const read = JSON.parse(
    await plugin.tool.agencyai_docs_read.execute({ path: "providers.mdx" }),
  );
  const hosted = JSON.parse(
    await plugin.tool.agencyai_docs_search.execute({
      query: "OpenWork Cloud Den organization team",
    }),
  );

  check.expect(
    Object.keys(plugin.tool).includes("agencyai_docs_search")
      && Object.keys(plugin.tool).includes("agencyai_docs_read"),
    "Packaged local capabilities expose both curated docs tools",
    Object.keys(plugin.tool),
  );
  check.expect(
    search.matches?.[0]?.path === "providers.mdx",
    "Docs search ranks the provider guide first",
    search.matches?.[0]?.path,
  );
  check.expect(
    read.path === "providers.mdx"
      && read.content.includes("Settings → AI Providers"),
    "Docs read returns the exact curated provider guide",
  );
  check.expect(
    Array.isArray(hosted.matches) && hosted.matches.length === 0,
    "Hosted-product search terms return no guidance",
    hosted.matches,
  );
  return {
    tools: ["agencyai_docs_search", "agencyai_docs_read"],
    providerGuide: search.matches[0].path,
    hostedMatches: hosted.matches.length,
    bundleBytes: statSync(bundle).size,
  };
}

async function frameAboutAndArtifact(root, check) {
  const output = run(root, "node", [
    "apps/desktop/scripts/check-agencyai-product-surface.mjs",
  ]);
  const result = JSON.parse(output);
  const about = source(
    root,
    "apps/app/src/react-app/shell/local-about-view.tsx",
  );
  const openWorkLicense = source(
    root,
    "apps/desktop/resources/licenses/OPENWORK-LICENSE.txt",
  );
  const openCodeLicense = source(
    root,
    "apps/desktop/resources/licenses/OPENCODE-LICENSE.txt",
  );

  check.expect(
    result.ok === true
      && result.renderer.files > 500
      && result.renderer.legalSource.startsWith("assets/app-"),
    "Built renderer passes the AgencyAI product-surface artifact scan",
    result.renderer,
  );
  check.expect(
    about.includes("A local-first desktop agent")
      && about.includes("Includes software derived from the OpenWork project")
      && about.includes("Includes OpenCode"),
    "About explains the local boundary and factual non-endorsement attribution",
  );
  check.expect(
    openWorkLicense.includes("MIT License")
      && openCodeLicense.includes("MIT License")
      && !openWorkLicense.includes("Functional Source License"),
    "Both applicable offline MIT texts are present without the enterprise-license preamble",
  );
  check.expect(
    result.renderer.upstreamCompatibilityLiterals.length === 3,
    "Only reviewed legal and compatibility OpenWork literals remain",
    result.renderer.upstreamCompatibilityLiterals,
  );
  return {
    artifactFiles: result.renderer.files,
    legalSource: result.renderer.legalSource,
    licenses: ["OpenWork MIT", "OpenCode MIT"],
    compatibilityLiterals: result.renderer.upstreamCompatibilityLiterals,
  };
}

async function framePackagedProduct(root, check) {
  const args = ["apps/desktop/scripts/run-packaged-smoke.mjs"];
  const requestedApp = process.env.AGENCYAI_PR06_APP_PATH?.trim();
  if (requestedApp) args.push("--app", requestedApp);
  const output = run(root, "node", args, 300_000);
  const result = parseLastJson(output, "Packaged AgencyAI smoke");

  check.expect(
    result.ok === true
      && result.app === "AgencyAI"
      && result.profile === "local-mvp",
    "Actual packaged application launches the immutable AgencyAI local profile",
  );
  check.expect(
    result.docs?.search === "providers.mdx"
      && result.docs?.read === "providers.mdx"
      && result.docs?.hostedMatches === 0
      && JSON.stringify(result.docs?.files) === JSON.stringify(EXPECTED_DOC_FILES),
    "Packaged docs search, read, and closure checks pass",
    result.docs,
  );
  check.expect(
    JSON.stringify(result.licenses)
      === JSON.stringify([
        "OPENWORK-LICENSE.txt",
        "OPENCODE-LICENSE.txt",
        "THIRD_PARTY_NOTICES.txt",
        "ELECTRON-LICENSE.txt",
        "LICENSES.chromium.html",
      ]),
    "Packaged resources contain the complete reviewed license and notice closure",
    result.licenses,
  );
  check.expect(
    result.opencode === "1.17.11"
      && result.opencodeSource === "bundled-patched"
      && result.sqlite === "embedded-server-loaded"
      && result.pty === "agencyai-packaged-pty-ok",
    "Packaged runtime keeps the verified OpenCode and native local stack",
  );
  return {
    app: result.app,
    profile: result.profile,
    rendererOrigin: result.rendererOrigin,
    docs: result.docs,
    licenses: result.licenses,
    opencode: result.opencode,
    native: { sqlite: result.sqlite, pty: result.pty },
  };
}

const FRAME_RUNNERS = Object.freeze({
  1: frameBrandAndComposition,
  2: frameLocalWelcomeAndSettings,
  3: frameCuratedDocsAndPrompts,
  4: frameLocalDocsTools,
  5: frameAboutAndArtifact,
  6: framePackagedProduct,
});

export async function runFrame(frameInput, rootInput) {
  const frame = Number(frameInput);
  const definition = FRAME_DEFINITIONS.find((entry) => entry.frame === frame);
  const runner = FRAME_RUNNERS[frame];
  assert(definition && runner, "frame must be an integer from 1 through 6");
  const root = repositoryRoot(rootInput);
  const check = createChecks();
  const evidence = await runner(root, check);
  return {
    passed: true,
    frame,
    id: definition.id,
    checks: check.list,
    evidence,
  };
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  runFrame(process.argv[2], process.argv[3]).then(
    (result) => {
      process.stdout.write(`${RESULT_MARKER}${JSON.stringify(result)}\n`);
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
