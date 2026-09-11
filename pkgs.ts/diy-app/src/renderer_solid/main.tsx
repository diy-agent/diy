import { render } from "solid-js/web";
import { bindRendererApi } from "./lib/renderer-api-impl";
import { applyTheme, getTheme } from "./lib/theme";
import App from "./App";
import "./index.css";

// 主题先于首屏应用，避免深/浅闪烁（daisyUI 默认 dark，localStorage 有浅色偏好则覆盖）
applyTheme(getTheme());

declare global {
  interface Window {
    transport: import("@diy/rpc").EnvelopeTransport;
  }
}

// Renderer 侧 RPC 服务端 — 处理来自 Main 进程或 CLI 的 RPC 调用（diy.ui.*）
// window.transport 由 preload/index.ts 暴露
if (window.transport) {
  const rendererBinding = bindRendererApi(window.transport);
  // 页面卸载时清理
  window.addEventListener("beforeunload", () => rendererBinding.destroy());
  console.log("[renderer] RPC binding started");
} else {
  console.warn("[renderer] window.transport not available — RPC disabled");
}

render(() => <App />, document.getElementById("root")!);
