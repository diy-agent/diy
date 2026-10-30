/**
 * browser.ts — **浏览器安全**的统一入口（不含 pi-tui / Node-only 部分）。
 *
 * 为什么需要它：根入口 `index.ts` re-export 了 `providers/pi-tui.js`（Node-only），
 * 浏览器打包器一旦 import 根入口就会把 pi-tui 拖进 bundle。于是浏览器侧不得不
 * deep-import `node_modules/@diy-agent/ui/signal.js` 这种路径（脆：包管理器一换就断）。
 *
 * 浏览器侧统一从这里取：
 *   import { Signal, html, GenApp } from "@diy-agent/ui/browser";
 *
 * 组件层用 **Web Awesome**（`wa-*` 自定义元素）：diyui 只管声明式结构与响应式，
 * 交互控件交给 Web Awesome（`html.tag("wa-button", {...})`）。两者互不依赖，可换。
 */

export { Signal } from "./signal.js";
export {
  ScopeNode,
  type ScopeConfig,
  type ContextManager,
} from "./scope.js";
export { CellHost, type CellCapable } from "./cell.js";
export {
  GenApp,
  html,
  type Spec,
  type ChildGen,
  type GenNode,
  type GenAppOptions,
} from "./providers/dom-gen.js";
