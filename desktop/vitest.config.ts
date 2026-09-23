import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(desktopRoot, "..");

// 组件测试走这里；纯逻辑（.ts）仍然由 `node --test` 直接跑，两边都在 CI 里。
export default defineConfig({
  plugins: [react()],
  server: { fs: { allow: [desktopRoot, repoRoot] } },
  test: {
    environment: "jsdom",
    // Testing Library 靠全局 afterEach 自动卸载上一条用例画出来的东西；
    // 关掉 globals 会让几条用例共用一个 DOM，第二次查询就撞上「找到多个」。
    globals: true,
    include: ["src/**/*.test.tsx"],
    restoreMocks: true,
  },
});
