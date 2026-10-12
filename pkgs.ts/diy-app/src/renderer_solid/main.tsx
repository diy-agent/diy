import { render } from "solid-js/web";
import { bindRendererApi } from "./lib/renderer-api-impl";
import { startUiWatch } from "./lib/ui-watch";
import { applyTheme, getTheme } from "./lib/theme";
import { applySkin, getSkin } from "./lib/skin";
import App from "./App";
import "./index.css";

// 主题先于首屏应用，避免深/浅闪烁（daisyUI 默认 dark，localStorage 有浅色偏好则覆盖）
applyTheme(getTheme());
// 界面样式（皮肤）同样先于首屏挂上：数据属性一处挂载，样式全在 index.css 的 [data-skin] 段
applySkin(getSkin());

declare global {
  interface Window {
    transport: import("@diy/rpc").EnvelopeTransport;
  }
}

// Renderer 侧 RPC 服务端 — 处理来自 Main 进程或 CLI 的 RPC 调用（diy.ui.*）
// window.transport 由 preload/index.ts 暴露
if (window.transport) {
  const rendererBinding = bindRendererApi(window.transport);
  // UI 状态变化流的事件源（diy.ui.watch.uiState 的推送端）
  startUiWatch();
  // 页面卸载时清理
  window.addEventListener("beforeunload", () => rendererBinding.destroy());
  console.log("[renderer] RPC binding started");
} else {
  console.warn("[renderer] window.transport not available — RPC disabled");
}

render(() => <App />, document.getElementById("root")!);
