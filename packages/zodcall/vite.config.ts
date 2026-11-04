import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "es2022",
    // keep `.js` / `.cjs` / `.d.ts` / `.d.cts`, matching package.json `exports`
    fixedExtension: false,
  },
  test: {
    include: ["test/**/*.test.ts"],
    typecheck: {
      include: ["test/**/*.test-d.ts"],
      tsconfig: "./tsconfig.json",
    },
  },
  lint: {
    ignorePatterns: ["**/node_modules/**", "**/dist/**"],
  },
});
