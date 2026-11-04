import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: { cli: "src/index.ts", index: "src/config/index.ts" },
    format: ["esm"],
    dts: true,
    clean: true,
    target: "node20",
    // keep `.js` / `.d.ts`, matching package.json `bin` and `exports`
    fixedExtension: false,
  },
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
  },
  lint: {
    ignorePatterns: ["**/node_modules/**", "**/dist/**"],
  },
});
