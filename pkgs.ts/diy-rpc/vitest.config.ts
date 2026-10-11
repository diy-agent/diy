import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // 首个失败即停（与 diy-app / 根配置同口径，见 ##255 R6③：全仓「首败即停」）
    bail: 1,
  },
});
