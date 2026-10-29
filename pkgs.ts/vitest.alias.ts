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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKGS = resolve(fileURLToPath(new URL(".", import.meta.url)));
const REPO = resolve(PKGS, "..");

/**
 * 包名 → 目录与**类型入口**（新增能力包 = 这里加一行）。
 * 路径相对仓根：`pkgs.ts/*` 的源码在 `src/`；`apps/*` 是 profile（摊在目录根，##458）。
 */
const LOCATIONS: Record<string, { dir: string; entry: string }> = {
    "@diy/agent-session": { dir: "pkgs.ts/diy-agent-session", entry: "src/index.ts" },
    "@diy/agent-session-store-jsonl": { dir: "pkgs.ts/diy-agent-session-store-jsonl", entry: "src/index.ts" },
    "@diy/compact": { dir: "pkgs.ts/diy-compact", entry: "src/index.ts" },
    "@diy/context": { dir: "pkgs.ts/diy-context", entry: "src/index.ts" },
    "@diy/facts": { dir: "pkgs.ts/diy-facts", entry: "src/index.ts" },
    "@diy/flow": { dir: "pkgs.ts/diy-flow", entry: "src/index.ts" },
    "@diy/persistence": { dir: "pkgs.ts/diy-persistence", entry: "src/index.ts" },
    "@diy/room": { dir: "pkgs.ts/diy-room", entry: "src/index.ts" },
    "@diy/talk": { dir: "pkgs.ts/diy-talk", entry: "src/index.ts" },
    "@diy/template": { dir: "pkgs.ts/diy-template", entry: "src/index.ts" },
    "@diy/ui-kit": { dir: "pkgs.ts/diy-ui-kit", entry: "src/index.ts" },
    "@diy-agent/rpc": { dir: "pkgs.ts/diy-rpc", entry: "src/index.ts" },
    "@diy-agent/ui": { dir: "pkgs.ts/diy-ui", entry: "src/index.ts" },
    "@diy-agent/workbench-plugin": { dir: "pkgs.ts/workbench-plugin", entry: "src/index.ts" },
    "@diy/workbench": { dir: "pkgs.ts/workbench", entry: "src/index.ts" },
    "@diy/ui-workbench": { dir: "pkgs.ts/ui-workbench", entry: "src/index.ts" },
    "@diy/chat-page": { dir: "pkgs.ts/chat-page", entry: "src/index.ts" },
    "@diy/app-minimal": { dir: "apps/minimal", entry: "index.ts" },
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 裸包名与子路径都指回源码（子路径 `$1` 不带扩展名，由 vite 按 extensions 补 .ts） */
export const workspaceAliases = Object.entries(LOCATIONS).flatMap(([name, { dir, entry }]) => {
    const abs = resolve(REPO, dir);
    return [
        { find: new RegExp(`^${esc(name)}$`), replacement: resolve(abs, entry) },
        { find: new RegExp(`^${esc(name)}/(.*)$`), replacement: `${resolve(abs, dirname(entry))}/$1` },
    ];
});
