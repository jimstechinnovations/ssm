import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  // fast-check v4.8.0 packaging issue: exports "import" condition resolves to a
  // CJS file inside a "type":"module" package. Adding "require" before "import"
  // in the conditions list makes Vite pick up lib/cjs/fast-check.js instead.
  resolve: {
    conditions: ['require', 'node', 'import', 'default'],
  },
  test: {
    environment: 'jsdom',
    include: [
      '**/__tests__/**/*.test.{ts,tsx}',
      '**/*.test.{ts,tsx}',
    ],
    exclude: ['node_modules', '.next'],
  },
})
