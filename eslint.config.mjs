import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  {
    rules: {
      // `const { legs: _legs, ...rest } = x` is how we omit a field; `_`-prefixed names are intentionally unused.
      "@typescript-eslint/no-unused-vars": ["warn", { ignoreRestSiblings: true, varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],
    },
  },
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Superseded SSM/SPM flows kept for reference only.
    "archive/**",
    // Local browser profiles (Chrome extension bundles), generated graphs and screenshots — not our code.
    ".chrome-bot/**",
    ".browser-profiles/**",
    "graphify-out/**",
    "engine-screenshots/**",
    "new_pictures/**",
    "placed/**",
  ]),
]);

export default eslintConfig;
