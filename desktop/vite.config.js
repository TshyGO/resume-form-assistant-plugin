import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
  plugins: [
    react(),
    // pdf.js 的 cMap 是运行时按需 fetch 的静态资源，与插件同版本（见 vendor/pdfjs）。
    // vite-plugin-static-copy 默认保留源目录结构，这里用 stripBase 拍平到 dest 下。
    viteStaticCopy({
      targets: [{ src: "node_modules/pdfjs-dist/cmaps/*", dest: "pdfjs/cmaps", rename: { stripBase: true } }],
    }),
  ],
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
