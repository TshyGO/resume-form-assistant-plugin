import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(desktopRoot, "..");

export default defineConfig({
  plugins: [react()],
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    fs: { allow: [desktopRoot, repoRoot] },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
