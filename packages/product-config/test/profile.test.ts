import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"
import {
  deepFreezeProductProfile,
  LOCAL_MVP_FEATURES,
  narrowFeatures,
  parseProductProfile,
  parseProductProfileName,
  PRODUCT_FEATURES,
} from "../src/schema.js"

const packageDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
)

function loadProfile(name: "local-mvp" | "upstream") {
  return parseProductProfile(
    JSON.parse(
      readFileSync(resolve(packageDirectory, "profiles", `${name}.json`), "utf8"),
    ),
  )
}

test("local-mvp is the exact 20-feature AgencyAI contract", () => {
  const profile = loadProfile("local-mvp")

  assert.equal(profile.schemaVersion, 1)
  assert.equal(profile.profile, "local-mvp")
  assert.equal(profile.networkPolicy, "user-authorized")
  assert.deepEqual(Object.keys(profile.features), [...PRODUCT_FEATURES])
  assert.equal(PRODUCT_FEATURES.length, 20)
  assert.deepEqual(profile.features, LOCAL_MVP_FEATURES)
  assert.deepEqual(profile.brand, {
    name: "AgencyAI",
    slug: "agencyai",
    companyName: "AgencyAI",
    appId: "com.artreimus.agencyai",
    devAppId: "com.artreimus.agencyai.dev",
    executableName: "agencyai",
    artifactPrefix: "agencyai",
    rendererScheme: "agencyai-internal",
    protocol: null,
    nsisGuid: "866CE9A3-13BF-49B0-9D56-C9C43706CB0E",
    linuxDesktopName: "agencyai.desktop",
    supportEmail: null,
    docsUrl: null,
    feedbackUrl: null,
    issueUrl: "https://github.com/artreimus/AgencyAI/issues",
    repository: {
      owner: "artreimus",
      name: "AgencyAI",
    },
    computerUse: {
      displayName: "AgencyAI Computer Use",
      bundleName: "AgencyAI Computer Use.app",
      bundleId: "com.artreimus.agencyai.computer-use",
    },
  })
})

test("upstream compatibility profile records the current stable identities", () => {
  const profile = loadProfile("upstream")

  assert.equal(profile.profile, "upstream")
  assert.equal(profile.brand.appId, "com.differentai.openwork")
  assert.equal(profile.brand.devAppId, "com.differentai.openwork.dev")
  assert.equal(profile.brand.protocol, "openwork")
  assert.equal(profile.brand.rendererScheme, "openwork-internal")
  assert.equal(profile.brand.nsisGuid, "29165F8A-586B-5470-A1CC-CFFF30A85ED3")
  assert.deepEqual(profile.brand.repository, {
    owner: "different-ai",
    name: "openwork",
  })
  assert.ok(PRODUCT_FEATURES.every((feature) => profile.features[feature]))
})

test("strict schemas reject extra top-level, brand, feature, and helper keys", () => {
  const local = loadProfile("local-mvp")
  const candidates = [
    { ...local, extra: true },
    { ...local, brand: { ...local.brand, extra: true } },
    { ...local, features: { ...local.features, extra: true } },
    {
      ...local,
      brand: {
        ...local.brand,
        computerUse: { ...local.brand.computerUse, extra: true },
      },
    },
  ]

  for (const candidate of candidates) {
    assert.throws(() => parseProductProfile(candidate))
  }
})

test("cloud subfeatures fail closed when openworkCloud is disabled", () => {
  const upstream = loadProfile("upstream")
  const cloudSubfeatures = [
    "cloudBootstrap",
    "connectLinks",
    "dynamicOrgBranding",
    "remoteWorkspaces",
    "remoteAccess",
    "workspaceSharing",
    "freshStart",
    "openworkModels",
    "googleWorkspace",
  ] as const
  const cloudDisabled = { ...upstream.features, openworkCloud: false }
  for (const feature of cloudSubfeatures) {
    cloudDisabled[feature] = false
  }

  assert.doesNotThrow(() =>
    parseProductProfile({
      ...upstream,
      features: cloudDisabled,
    }))

  for (const feature of cloudSubfeatures) {
    assert.throws(
      () => parseProductProfile({
        ...upstream,
        features: { ...cloudDisabled, [feature]: true },
      }),
      new RegExp(`${feature} requires openworkCloud`),
    )
  }
})

test("updates and connect links require owned delivery identities", () => {
  const upstream = loadProfile("upstream")

  assert.throws(
    () => parseProductProfile({
      ...upstream,
      brand: { ...upstream.brand, repository: null },
    }),
    /Automatic updates require/,
  )

  assert.throws(
    () => parseProductProfile({
      ...upstream,
      brand: {
        ...upstream.brand,
        repository: { owner: "attacker", name: "payload" },
      },
    }),
    /owned delivery repository/,
  )

  assert.throws(
    () => parseProductProfile({
      ...upstream,
      brand: { ...upstream.brand, protocol: null },
    }),
    /Connect links require/,
  )
})

test("public and renderer schemes, helper IDs, and package identities are product-owned", () => {
  const upstream = loadProfile("upstream")
  const invalidBrands = [
    { ...upstream.brand, rendererScheme: "other-internal" },
    { ...upstream.brand, protocol: "other" },
    { ...upstream.brand, devAppId: "com.example.dev" },
    {
      ...upstream.brand,
      computerUse: {
        ...upstream.brand.computerUse,
        bundleId: "com.example.computer-use",
      },
    },
    { ...upstream.brand, executableName: "other" },
  ]

  for (const brand of invalidBrands) {
    assert.throws(() => parseProductProfile({ ...upstream, brand }))
  }
})

test("local-mvp rejects upstream identity and every attempted capability broadening", () => {
  const local = loadProfile("local-mvp")
  const upstream = loadProfile("upstream")

  assert.throws(
    () => parseProductProfile({
      ...local,
      brand: { ...local.brand, docsUrl: upstream.brand.docsUrl },
    }),
    /forbidden upstream fragment/,
  )

  for (const feature of PRODUCT_FEATURES) {
    if (local.features[feature]) continue
    assert.throws(
      () => parseProductProfile({
        ...local,
        features: { ...local.features, [feature]: true },
      }),
      new RegExp(`local-mvp build feature ${feature} is immutable|requires openworkCloud|require`),
    )
  }
})

test("local-mvp rejects identity, GUID, network-policy, and enabled-protocol overrides", () => {
  const local = loadProfile("local-mvp")
  const candidates = [
    { ...local, brand: { ...local.brand, name: "Other" } },
    {
      ...local,
      brand: {
        ...local.brand,
        nsisGuid: "29165F8A-586B-5470-A1CC-CFFF30A85ED3",
      },
    },
    {
      ...local,
      brand: { ...local.brand, protocol: "agencyai" },
      features: { ...local.features, connectLinks: true },
    },
    { ...local, networkPolicy: "air-gapped" },
  ]

  for (const candidate of candidates) {
    assert.throws(() => parseProductProfile(candidate))
  }
})

test("narrowFeatures may disable but never enable build-disabled capabilities", () => {
  const local = loadProfile("local-mvp")
  const buildBefore = structuredClone(local.features)
  const runtime = {
    ...local.features,
    openworkCloud: true,
    hostedWebSearch: true,
    browserAutomation: false,
  }
  const runtimeBefore = structuredClone(runtime)
  const effective = narrowFeatures(local.features, runtime)

  assert.equal(effective.openworkCloud, false)
  assert.equal(effective.hostedWebSearch, false)
  assert.equal(effective.browserAutomation, false)
  assert.equal(effective.computerUse, true)
  assert.deepEqual(Object.keys(effective), [...PRODUCT_FEATURES])
  assert.deepEqual(local.features, buildBefore)
  assert.deepEqual(runtime, runtimeBefore)
  assert.ok(Object.isFrozen(effective))
})

test("deepFreezeProductProfile recursively freezes the validated profile", () => {
  const profile = deepFreezeProductProfile(loadProfile("local-mvp"))

  assert.ok(Object.isFrozen(profile))
  assert.ok(Object.isFrozen(profile.brand))
  assert.ok(Object.isFrozen(profile.brand.repository))
  assert.ok(Object.isFrozen(profile.brand.computerUse))
  assert.ok(Object.isFrozen(profile.features))
  assert.equal(Reflect.set(profile.features, "openworkCloud", true), false)
  assert.equal(profile.features.openworkCloud, false)
})

test("deepFreezeProductProfile traverses a profile whose outer object is already frozen", () => {
  const profile = loadProfile("local-mvp")
  Object.freeze(profile)

  deepFreezeProductProfile(profile)

  assert.ok(Object.isFrozen(profile.brand))
  assert.ok(Object.isFrozen(profile.brand.repository))
  assert.ok(Object.isFrozen(profile.brand.computerUse))
  assert.ok(Object.isFrozen(profile.features))
  assert.equal(Reflect.set(profile.features, "browserAutomation", false), false)
  assert.equal(profile.features.browserAutomation, true)
})

test("profile selectors reject missing, malformed, and hostile values", () => {
  assert.equal(parseProductProfileName("local-mvp"), "local-mvp")
  assert.equal(parseProductProfileName("upstream"), "upstream")

  for (const value of [
    "",
    "LOCAL-MVP",
    "local-mvp;upstream",
    "../upstream",
    true,
    null,
    undefined,
  ]) {
    assert.throws(
      () => parseProductProfileName(value),
      /Invalid OPENWORK_PRODUCT_PROFILE selector/,
    )
  }
})

test("the default build embeds a frozen local profile importable by raw Node", () => {
  const distPath = resolve(packageDirectory, "dist", "index.js")
  const moduleUrl = pathToFileURL(distPath).href
  const probe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        `const module = await import(${JSON.stringify(moduleUrl)});`,
        "const profile = module.getBuildProductProfile();",
        "const mutation = Reflect.set(profile.features, 'openworkCloud', true);",
        "process.stdout.write(JSON.stringify({",
        "profile: profile.profile,",
        "name: profile.brand.name,",
        "featureCount: Object.keys(profile.features).length,",
        "cloud: profile.features.openworkCloud,",
        "mutation,",
        "same: profile === module.getBuildProductProfile(),",
        "frozen: Object.isFrozen(profile) && Object.isFrozen(profile.features),",
        "}));",
      ].join(""),
    ],
    { encoding: "utf8" },
  )

  assert.equal(probe.status, 0, probe.stderr)
  assert.deepEqual(JSON.parse(probe.stdout), {
    profile: "local-mvp",
    name: "AgencyAI",
    featureCount: 20,
    cloud: false,
    mutation: false,
    same: true,
    frozen: true,
  })

  const builtSource = readFileSync(distPath, "utf8")
  assert.doesNotMatch(builtSource, /process\.env/)
  assert.doesNotMatch(builtSource, /openworklabs\.com/)
  assert.doesNotMatch(builtSource, /different-ai\/openwork/)
  assert.doesNotMatch(builtSource, /\bZod(?:Error|Object|String)\b/)
  assert.doesNotMatch(builtSource, /ProductProfileSchema/)
})

test("an invalid build selector fails before producing a broadened bundle", () => {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
  const result = spawnSync(command, ["run", "build"], {
    cwd: packageDirectory,
    encoding: "utf8",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      OPENWORK_PRODUCT_PROFILE: "../upstream",
    },
  })

  assert.notEqual(result.status, 0)
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Invalid OPENWORK_PRODUCT_PROFILE selector/,
  )
})
