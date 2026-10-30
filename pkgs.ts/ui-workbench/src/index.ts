// index.ts — 工作台布局骨架的公开入口。
//
// 用法（renderer 装配入口）：
//   import { mountWorkbench, registerPage } from '@diy-agent/workbench-ui';
//   registerPage(myPageView);                       // 每个页面插件各来一行
//   await mountWorkbench(document.getElementById('app')!, window.bridge);

export { registerPage, getPage, registeredPages, resetPages } from "./registry.js";
export { mountWorkbench } from "./frame.js";
export type { MountOptions } from "./frame.js";
export { WorkbenchUiError } from "./errors.js";
export type { PageContext, PageInfo, PageView, WorkbenchFrame, WorkbenchGateway } from "./contract.js";
