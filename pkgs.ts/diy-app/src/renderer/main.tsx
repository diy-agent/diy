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
  const rendererServer = bindRendererApi(window.transport);
  // 页面卸载时清理
  window.addEventListener("beforeunload", () => rendererServer.destroy());
  console.log("[renderer] RpcServer started");
} else {
  console.warn("[renderer] window.transport not available — RpcServer disabled");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </TooltipProvider>
  </StrictMode>,
);
