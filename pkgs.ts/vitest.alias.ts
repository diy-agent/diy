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
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKGS = resolve(fileURLToPath(new URL(".", import.meta.url)));
const REPO = resolve(PKGS, "..");

/**
 * 包名 → 目录与**类型入口**（新增能力包 = 这里加一行）。
 * 路径相对仓根：`pkgs.ts/*` 的源码在 `src/`；`apps/*` 是 profile（摊在目录根，##458）。
 */
const LOCATIONS: Record<string, { dir: string; entry: string }> = {
    "@diy-agent/time": { dir: "pkgs.ts/diy-time", entry: "src/index.ts" },
    "@diy-agent/log": { dir: "pkgs.ts/diy-log", entry: "src/index.ts" },
    "@diy-agent/session": { dir: "pkgs.ts/diy-agent-session", entry: "src/index.ts" },
    "@diy-agent/session-store-jsonl": { dir: "pkgs.ts/diy-agent-session-store-jsonl", entry: "src/index.ts" },
    "@diy-agent/session-store-memory": { dir: "pkgs.ts/diy-agent-session-store-memory", entry: "src/index.ts" },
    "@diy-agent/compaction": { dir: "pkgs.ts/diy-compact", entry: "src/index.ts" },
    "@diy-agent/context": { dir: "pkgs.ts/diy-context", entry: "src/index.ts" },
    "@diy-agent/facts": { dir: "pkgs.ts/diy-facts", entry: "src/index.ts" },
    "@diy-agent/flow": { dir: "pkgs.ts/diy-flow", entry: "src/index.ts" },
    "@diy-agent/llm-provider": { dir: "pkgs.ts/diy-llm-provider", entry: "src/index.ts" },
    "@diy-agent/persistence": { dir: "pkgs.ts/diy-persistence", entry: "src/index.ts" },
    "@diy-agent/bot": { dir: "pkgs.ts/diy-agent-bot", entry: "src/index.ts" },
    "@diy-agent/room": { dir: "pkgs.ts/diy-room", entry: "src/index.ts" },
    "@diy-agent/talk": { dir: "pkgs.ts/diy-talk", entry: "src/index.ts" },
    "@diy-agent/template": { dir: "pkgs.ts/diy-template", entry: "src/index.ts" },
    "@diy-agent/ui-kit": { dir: "pkgs.ts/diy-ui-kit", entry: "src/index.ts" },
    "@diy-agent/rpc": { dir: "pkgs.ts/diy-rpc", entry: "src/index.ts" },
    "@diy-agent/remote": { dir: "pkgs.ts/diy-remote", entry: "src/index.ts" },
    "@diy-agent/ui": { dir: "pkgs.ts/diy-ui", entry: "src/index.ts" },
    "@diy-agent/workbench-plugin": { dir: "pkgs.ts/workbench-plugin", entry: "src/index.ts" },
    "@diy-agent/workbench": { dir: "pkgs.ts/workbench", entry: "src/index.ts" },
    "@diy-agent/workbench-ui": { dir: "pkgs.ts/ui-workbench", entry: "src/index.ts" },
    "@diy-agent/chat-page": { dir: "pkgs.ts/chat-page", entry: "src/index.ts" },
    "@diy-agent/model-catalog": { dir: "pkgs.ts/diy-agent-model-catalog", entry: "src/index.ts" },
    "@diy-agent/model-config-page": { dir: "pkgs.ts/diy-agent-model-config-page", entry: "src/index.ts" },
    "@diy-agent/bot-config-page": { dir: "pkgs.ts/diy-agent-bot-config-page", entry: "src/index.ts" },
    "@diy-agent/app-minimal": { dir: "apps/minimal", entry: "index.ts" },
    "@diy-agent/app-chat": { dir: "apps/chat", entry: "index.ts" },
};

/**
 * 子路径**不镜像** `src/` 目录的包：显式给出真源（值 = 仓内相对路径）。
 *
 * 为什么需要：下面的通用子路径规则是 `<包>/<其后>` → `src/<其后>`，它默认包内布局与包名子路径同构
 * （`@diy-agent/facts/node` → `src/node/index.ts` 成立）。rpc 的传输层不成立 ——
 * `@diy-agent/rpc/http` 的真源在 `src/transport/http/index.ts`，通用规则会指向不存在的 `src/http`
 * （vite 报 `Cannot find package '@diy-agent/rpc/http'`）。新增这类包 = 这里加一行。
 */
const SUBPATH_SOURCES: Record<string, string> = {
    "@diy-agent/rpc/http": "pkgs.ts/diy-rpc/src/transport/http/index.ts",
    "@diy-agent/rpc/ws": "pkgs.ts/diy-rpc/src/transport/ws/index.ts",
    "@diy-agent/rpc/electron": "pkgs.ts/diy-rpc/src/transport/electron/index.ts",
    "@diy-agent/rpc/cli": "pkgs.ts/diy-rpc/src/cli/index.ts",
    "@diy-agent/remote/node": "pkgs.ts/diy-remote/src/node/index.ts",
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 子路径别名优先取 package.json 的 `exports["types"]`：
 * 各包导出布局并不统一（`@diy-agent/rpc/http` 在 `src/transport/http/index.ts`，
 * `@diy-agent/compaction/compaction` 在 `src/compaction.ts`），按目录硬套 `src/<sub>` 会漏。
 */
function exportAliases(name: string, dir: string): Array<{ find: RegExp; replacement: string }> {
    const abs = resolve(REPO, dir);
    let exports: Record<string, unknown> = {};
    try {
        exports = (JSON.parse(readFileSync(resolve(abs, "package.json"), "utf8")) as { exports?: Record<string, unknown> })
            .exports ?? {};
    } catch {
        return [];
    }
    const out: Array<{ find: RegExp; replacement: string }> = [];
    for (const [key, value] of Object.entries(exports)) {
        if (key === ".") continue;
        const target = typeof value === "string" ? value : (value as { types?: unknown } | null)?.types;
        if (typeof target !== "string" || !target.endsWith(".ts")) continue;
        const rel = target.replace(/^\.\//, "");
        if (key.includes("*")) {
            // `./*` → `./src/*.ts`：把 `*` 换成正则捕获 `$1`
            out.push({ find: new RegExp(`^${esc(name)}/(.*)$`), replacement: resolve(abs, rel).replace(/\*/g, "$1") });
        } else {
            out.push({ find: new RegExp(`^${esc(name)}/${esc(key.replace(/^\.\//, ""))}$`), replacement: resolve(abs, rel) });
        }
    }
    return out;
}

/**
 * 裸包名与子路径都指回源码（子路径 `$1` 不带扩展名，由 vite 按 extensions 补 .ts）。
 *
 * 优先级（高 → 低）——合并时的两边**都要**（各自解决真问题）：
 *   ① `SUBPATH_SOURCES` 精确匹配：子路径不镜像 `src/` 的包（如 `@diy-agent/remote/node`）；
 *   ② 裸包名 → 包入口；
 *   ③ `exports["types"]` 驱动的精确子路径（见 `exportAliases`，解决非镜像布局）；
 *   ④ 兜底：`<包>/<其后>` → 入口同级目录下的 `<其后>`。
 */
export const workspaceAliases = [
    ...Object.entries(SUBPATH_SOURCES).map(([name, file]) => ({
        find: new RegExp(`^${esc(name)}$`),
        replacement: resolve(REPO, file),
    })),
    ...Object.entries(LOCATIONS).flatMap(([name, { dir, entry }]) => {
    const abs = resolve(REPO, dir);
    return [
        { find: new RegExp(`^${esc(name)}$`), replacement: resolve(abs, entry) },
        ...exportAliases(name, dir),
        { find: new RegExp(`^${esc(name)}/(.*)$`), replacement: `${resolve(abs, dirname(entry))}/$1` },
    ];
    }),
];
