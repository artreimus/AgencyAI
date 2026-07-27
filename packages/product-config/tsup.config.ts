import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "tsup"
import {
  parseProductProfile,
  parseProductProfileName,
} from "./src/schema"

const packageDirectory = dirname(fileURLToPath(import.meta.url))
const selectedProfileName = parseProductProfileName(
  process.env.OPENWORK_PRODUCT_PROFILE ?? "local-mvp",
)
const selectedProfilePath = resolve(
  packageDirectory,
  "profiles",
  `${selectedProfileName}.json`,
)
const selectedProfile = parseProductProfile(
  JSON.parse(readFileSync(selectedProfilePath, "utf8")),
)

if (selectedProfile.profile !== selectedProfileName) {
  throw new Error(
    `Profile selector ${selectedProfileName} loaded mismatched profile ${selectedProfile.profile}`,
  )
}

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  clean: true,
  dts: true,
  splitting: false,
  sourcemap: false,
  define: {
    __OPENWORK_COMPILED_PRODUCT_PROFILE__: JSON.stringify(selectedProfile),
  },
})
