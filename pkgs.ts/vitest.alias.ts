// pkgs.ts/vitest.alias.ts — 测试期把 workspace 能力包解析回 **src**（##453 方案 B）
//
// 为什么需要：各包的 package.json 的 main/exports 已指 `lib/*.js`（Electron 在
// `Resources/runtime/node_modules/` 里用 **Node 直接 import**，Node 加载不了 `.ts`）。
// 但单测要跑的是**源码**：改了 src 立刻生效、不必先 build，报错栈也落在源码上。
// 判据：只影响 vitest（`vite` 构建 / Electron 运行仍读 lib）—— 运行形态与开发期各取所需。
//
// 用法（每个会 import 能力包的 vitest 配置里）：
//   import { workspaceAliases } from "../vitest.alias";
//   resolve: { alias: [...workspaceAliases] }
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKGS = resolve(fileURLToPath(new URL(".", import.meta.url)));

/** 包名 → 仓内目录（新增能力包 = 这里加一行） */
const PKG_DIRS: Record<string, string> = {
    "@diy/agent-session": "diy-agent-session",
    "@diy/compact": "diy-compact",
    "@diy/context": "diy-context",
    "@diy/facts": "diy-facts",
    "@diy/flow": "diy-flow",
    "@diy/persistence": "diy-persistence",
    "@diy/room": "diy-room",
    "@diy/talk": "diy-talk",
    "@diy/template": "diy-template",
    "@diy/ui-kit": "diy-ui-kit",
    "@diy-agent/rpc": "diy-rpc",
    "@diy-agent/ui": "diy-ui",
    "@diy-agent/workbench-plugin": "workbench-plugin",
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 裸包名与子路径都指回 src（子路径 `$1` 不带扩展名，由 vite 按 extensions 补 .ts） */
export const workspaceAliases = Object.entries(PKG_DIRS).flatMap(([name, dir]) => [
    { find: new RegExp(`^${esc(name)}$`), replacement: resolve(PKGS, dir, "src/index.ts") },
    { find: new RegExp(`^${esc(name)}/(.*)$`), replacement: `${resolve(PKGS, dir, "src")}/$1` },
]);
