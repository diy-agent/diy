// @ts-nocheck
import { render } from "solid-js/web";
import { bindRendererApi } from "./lib/renderer-api-impl";
import App from "./App";
import "./index.css";

// Renderer 侧 RPC 服务端 — 处理来自 Main 进程或 CLI 的 RPC 调用（diy.ui.*）
// window.transport 由 preload/index.ts 暴露
if ((window as any).transport) {
  const rendererBinding = bindRendererApi((window as any).transport);
  // 页面卸载时清理
  window.addEventListener("beforeunload", () => rendererBinding.destroy());
  console.log("[renderer] RPC binding started");
} else {
  console.warn("[renderer] window.transport not available — RPC disabled");
}

render(() => <App />, document.getElementById("root")!);
