import { defineConfig } from "oxlint"
import core from "ultracite/oxlint/core"
import react from "ultracite/oxlint/react"

export default defineConfig({
  extends: [core, react],
  options: { typeAware: true },
  // preload/ runs inside the plugin's own process, patching its grammy where it stands.
  ignorePatterns: ["**/.hutch/**", "**/dist/**", "**/build/**", "preload/**"],
})
