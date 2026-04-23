import { defineConfig } from "vite";

// GitHub Pages for a user/repo site serves from https://<user>.github.io/<repo>/
// so the production build's asset URLs must be prefixed with the repo name.
// Dev server serves from /, so only apply the prefix to `build`.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/sheets-db/" : "/",
  server: {
    port: 5173,
  },
  build: {
    outDir: "dist",
  },
}));
