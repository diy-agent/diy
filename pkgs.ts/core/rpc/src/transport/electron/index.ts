// electron/index.ts — **故意不实现任何东西**，只说明该用哪个入口。
//
// 2026-11-05 拆分：main 与 renderer 分属两个进程，必须分开 import。
// 原来两者写在同一文件里，`import { ipcMain, ipcRenderer } from 'electron'` 在
// **主进程**里是加载期 SyntaxError（Node ESM 会静态校验导出）：
//
//   SyntaxError: The requested module 'electron' does not provide an export named 'ipcRenderer'
//
// ⇒ 整个 app 起不来（实测：窗口白屏 / CDP 无 target）。
//
//   main 进程：    import { createMainTransport } from "@diy-agent/rpc/electron/main"
//   preload/renderer：import { createRendererTransport } from "@diy-agent/rpc/electron/renderer"
//
// 留这个文件是为了让旧引用报得清楚（"用错了入口"比 "Cannot find module" 好排查）。
export {};
