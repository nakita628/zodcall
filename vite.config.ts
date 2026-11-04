import { defineConfig } from "vite-plus";

export default defineConfig({
  // Vite+ merges this root config into every workspace config, so packages inherit the
  // formatting options and only declare what is specific to them (pack / test / lint).
  fmt: {
    ignorePatterns: ["**/node_modules/**", "**/dist/**"],
  },
  lint: {
    ignorePatterns: ["**/node_modules/**", "**/dist/**"],
  },
});
