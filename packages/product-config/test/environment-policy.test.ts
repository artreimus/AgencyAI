import assert from "node:assert/strict"
import { test } from "node:test"

import { isUserEnvironmentInjectionKeyAllowed } from "../src/environment-policy.js"

test("user environment policy preserves provider, MCP, endpoint, and proxy values", () => {
  for (const name of [
    "ANTHROPIC_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_REGION",
    "AZURE_OPENAI_API_KEY",
    "GCLOUD_PROJECT",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "NOTION_TOKEN",
    "OLLAMA_HOST",
    "CUSTOM_PROVIDER_BASE_URL",
    "ORDINARY_MCP_CREDENTIAL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
  ]) {
    assert.equal(isUserEnvironmentInjectionKeyAllowed(name), true, name)
  }
})

test("user environment policy rejects runtime, loader, and installer controls", () => {
  for (const name of [
    "OPENWORK_TOKEN",
    "OPENCODE_CONFIG",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "BUN_OPTIONS",
    "BUN_PRELOAD",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "NPM_CONFIG_REGISTRY",
    "npm_config_proxy",
    "YARN_NPM_REGISTRY_SERVER",
    "PNPM_HOME",
    "COREPACK_NPM_REGISTRY",
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "BASH_ENV",
    "JAVA_TOOL_OPTIONS",
  ]) {
    assert.equal(isUserEnvironmentInjectionKeyAllowed(name), false, name)
  }
})
