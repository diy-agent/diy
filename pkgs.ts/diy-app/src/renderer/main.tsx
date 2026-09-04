import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { bindRendererApi } from "./components-diy/lib/renderer-api-impl";

import "./index.css";
import App from "./App";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

// Renderer 侧 RPC 服务端 — 处理来自 Main 进程或 CLI 的 RPC 调用
// window.transport 由 preload/index.ts 暴露
if (window.transport) {
  const rendererBinding = bindRendererApi(window.transport);
  // 页面卸载时清理
  window.addEventListener("beforeunload", () => rendererBinding.destroy());
  console.log("[renderer] RPC binding started");
} else {
  console.warn("[renderer] window.transport not available — RPC disabled");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      {/* defaultTheme="dark"：主题不跟随 prefers-color-scheme。
          "system" 会让 Playwright/Puppeteer 连 CDP 时注入的 colorScheme:'light'
          默认仿真把界面刷成白底（见 scripts/cdp-colorscheme-demo.mts）。
          用户显式选择的主题仍存 localStorage 优先，'d' 键可切换。 */}
      <ThemeProvider defaultTheme="dark">
        <App />
      </ThemeProvider>
    </TooltipProvider>
  </StrictMode>,
);
