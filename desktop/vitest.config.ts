import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// 组件测试走这里；纯逻辑（.ts）仍然由 `node --test` 直接跑，两边都在 CI 里。
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.tsx"],
    restoreMocks: true,
  },
});
