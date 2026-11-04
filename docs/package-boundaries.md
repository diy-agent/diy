# 包边界：barrel 只给 Node 侧用

> 2026-11-04 定。起因是一次**真事故**（窗口纯黑），不是理论洁癖。

## 规则

> **包的 `index.ts`（barrel）只给 Node 侧用；renderer 一律走具体子路径。**

```ts
// ✅ Node 侧（main / 脚本 / 测试）：可以用 barrel
import { createRun, listRuns } from "@diy-agent/jobs";

// ✅ renderer：只取它真正需要的那一块
import { stateLabel, formatDuration } from "@diy-agent/jobs/run-status";

// ❌ renderer 用 barrel
export * from "@diy-agent/jobs";   // 会把 run-registry → node:child_process 一起拖进来
```

## 为什么

**barrel 是「包的全集」**，而包必然包含 Node 侧能力（spawn / fs / 进程管理）。
renderer 只需要其中一小块纯函数时，用 barrel 等于**把整个依赖图拖进浏览器 bundle**。

而 npm 包 `exports` 只做**出入口映射**，不做依赖裁剪 —— `export *` 会真的把目标文件
及其全部 `import` 一起拉进来（ESM 静态图，没有 tree-shaking 的运行时语义）。

## 真事故（2026-11-04）

```
prod 产物 index-92oAXqGe.js:347
  ReferenceError: process is not defined   ⇒ 窗口纯黑
```

来源链：

```
shared/run-view.ts（renderer 用）
  → shared/run-status.ts  ← 这里写了 `export * from "@diy-agent/jobs"`
    → @diy-agent/jobs/index.ts
      → run-registry.ts
        → @diy-agent/tools/shell/run
          → node:child_process     ← 模块顶层读 process.platform
```

**为什么三层检查都没抓到**：

| 检查 | 为什么漏 |
|---|---|
| `tsc` | 只做类型检查，看不出「运行时会不会求值到」 |
| `oxlint` | 不分析跨包 import 图 |
| `check-os-boundary.mjs` | 是**文本正则**扫令牌；这次源码里只有一行干净的 `export *` |

⇒ 必须**真遍历 import 图**。

## 三层防护

| 层 | 实现 | 时机 | 谁能绕过 |
|---|---|---|---|
| **规范** | 本文档 | 编码/评审 | 人会忘 |
| **图分析** | `scripts/check-renderer-boundary.mjs` | `./sha.sh check`（秒级）| 动态 `import()` |
| **构建拦截** | `apps/diy-app/vite.renderer.config.ts` 的 `browserSafe` 插件 | build | 几乎不能 |

**两层都要**：插件依赖 Vite 的解析行为（版本 / 插件顺序会变），脚本是纯静态、稳定。
反过来说，脚本测不到的动态 import 由插件兜底。

## 常见误报：`import type` 是安全的

```ts
// ✅ 编译期擦除，运行时零依赖
import type { SteerItem } from "../../main/core/drafts";
```

`check-renderer-boundary.mjs` 会跳过所有 `import type` / `export type` —— 这条很重要，
否则 renderer 里一堆「从 main 拿类型」的 import 会刷出大量假阳性。

**判据**：`import type` 安全；`import { 值 }` 不安全（哪怕只用一个）。

## 转发层的正确写法

**转发层按「用途」切，不按「来源包」切**：

```ts
// ❌ 图省事：整包转发
export * from "@diy-agent/jobs";

// ✅ 只转纯呈现判据
export * from "@diy-agent/jobs/run-status";

// ✅ 或者显式列出
export { stateLabel, formatDuration, exitText } from "@diy-agent/jobs/run-status";
```

## 新增包时自查

```bash
# 1. 从 renderer 入口扫一遍（秒级）
node scripts/check-renderer-boundary.mjs

# 2. 自证脚本还能抓到问题（注入事故 → 断言报错）
node scripts/check-renderer-boundary.mjs --self-test
```

第二条**不是可选项** —— 一个从不报警的检查等于没有检查。

## 现状清单（2026-11-04 审计全仓 34 个包）

自动生成方式：从每个包的 `src/index.ts` 出发遍历 import 图，看能否到达 `node:*` / `electron`。

### ⚠️ barrel 危险（index.ts 可达 Node）—— 11 个

| 包 | 经由 | 说明 |
|---|---|---|
| `@diy-agent/workbench` | `electron` | 壳本身，只该 main 用 |
| `@diy-agent/jobs` | `run-registry` → `node:child_process` | **本次事故源头** |
| `@diy-agent/bot` | `store-fs` → `node:fs/promises` | renderer 该走 `bot/protocol` / `bot/persona` |
| `@diy-agent/bot-config-page` | `catalog` → `node:fs` | 页面本身是 renderer 用的 ⇒ **该拆子路径** |
| `@diy-agent/model-catalog` | `catalog` → `node:fs` | 同上 |
| `@diy-agent/hub` | `keychain` → `node:child_process` | |
| `@diy-agent/tools` | `file-edit` → `node:fs` | |
| `@diy-agent/os` | `fs-lock` → `node:fs` | |
| `@diy-agent/persistence` | `seek` → `node:crypto` | |
| `@diy-agent/session-store-jsonl` | `store` → `node:fs/promises` | |
| `@diy-agent/log` | `sanitize` → `node:buffer` | |

### ✅ barrel 安全（纯数据 / 纯函数）—— 23 个

`chat-page` `compaction` `context` `facts` `flow` `llm-provider` `model-config-page`
`remote` `room` `rpc` `serial-queue` `session` `session-store-memory` `store-contract`
`talk` `template` `test-llm` `time` `ui` `ui-kit` `ui-testing` `workbench-plugin` `workbench-ui`

> `@diy-agent/rpc` 是安全的 —— 它虽然有 `./http` `./ws` `./electron` 子路径，
> 但 `index.ts` **不导出它们**。这正是「子路径隔离」的正确示范。

### ⚠️ 这份清单的正确读法（别被"危险"吓到）

`--barrels` 判的是**单入口**：`src/index.ts` 能否到达 Node。
但对**双入口包**（`*-page`）来说，`.` 本来就是给主进程的，带 Node 是**应该的**。

```
@diy-agent/bot-config-page   .  ← main 侧方法表（读写 bot 存储，要 node:fs）✅
                             ./renderer  ← 浏览器视图（纯 DOM）✅
```

**这类包的正确性由主检查（默认模式）保证** —— 它从 renderer 入口出发，
看到的是 `./renderer` 而不是 `.`，所以报 ✓。

### 真实的待办

- [ ] **命名问题**：`*-page` 后缀让人以为是纯 UI 包，实际是「页面 = 主进程贡献 + renderer 视图」
      的双入口包。三个都是这个模式：
      `bot-config-page` / `chat-page` / `model-config-page`
      ⇒ 建议在各自 `package.json` 的 description 里写清「.` = 主进程，`./renderer` = 浏览器」，
      或改名成 `*-page-contribution`（代价大，先靠文档）
- [ ] 其余 9 个包：确认 renderer 侧确实走了子路径（当前主检查 ✓，清单的作用是**防未来误用**）

### `model-catalog` 的情况

只有 `.` 一个入口，且 renderer **没直接引它**（只有 `apps/chat/main.ts` 的注释提到）。
它带 `node:fs` 是因为要读 `models.dev.json` —— 这是它的本职，不是问题。

## 如何复现这份审计

```bash
node scripts/check-renderer-boundary.mjs          # 只看 renderer 是否越界（会阻断）
node scripts/check-renderer-boundary.mjs --list   # 看入口与统计
```

## 附：`@diy-agent/rpc` 的入口原则（2026-11-04 用户确认）

> **根 `index.ts` 只导出最基本接口，不导出带特殊依赖的具体实现。**

理由：将来要把 electron / http / ws 拆成独立包时，根入口不跟着动。

现状（正确）：

```json
"exports": {
  ".":          "./src/index.ts",       // 平台无关核（纯 TS + zod）
  "./http":     ...,                     // 各自带 Node/浏览器依赖
  "./ws":       ...,
  "./electron": ...,                     // 带 electron
  "./cli":      ...
}
```

`index.ts` 不 re-export 任何 transport ⇒ 它在浏览器里安全（审计里它是「✅ 安全」那一类）。

**反例**：`@diy-agent/jobs` 的 index 导出了 `run-registry`（要 spawn）⇒ 用 barrel 的
renderer 直接被拖下水。如果当初把「账本」（IO）和「呈现判据」（纯函数）分成两个入口，
这次事故不会发生。

## 包级组合根：`<Pkg>Module`（2026-11-04 用户定）

### 问题

`Bot` 类被导出到包外的**唯一理由**是「装配 `BotStore` 时需要它」：

```ts
// ❌ 现在
export { createBot, ensureBot, openBot } from "./bot.js";
export type { Bot } from "./types.js";
```

但 `Bot` 是**包内部逻辑**，外部（页面 / CLI / Web）根本不需要知道它长什么样。
「装配需要」不是「使用需要」—— 这正是之前 `Bot.newSession()` 被导出但零调用方的根源。

### 命名约定

| 名字 | 职责 | 导出 |
|---|---|---|
| **`<Pkg>Module`** | **组合根**：知道所有具体实现，负责实例化 + 连接依赖 | ✅ 导出（唯一入口）|
| `<Pkg>Service` | 服务接口：外部能用的**能力**清单 | ✅ 导出（留给以后）|
| 具体类（`Bot` / `BotStore` / `createBot`） | 实现细节 | ❌ 包内私有 |

**为什么不是 `Service` 当组合根**：`xxxService` 这个名字要留给「服务接口」（能力清单），
两者职责不同 —— Service 回答「能做什么」，Module 回答「怎么装起来」。
以后每个包可能都有 `xxxModule`（组合根）+ `xxxService`（接口）。

> 不是 Service Locator、不是 DI 容器 —— 只是**一个函数/对象**，把依赖接好返回服务接口。
> 对应 Seemann 的 **Composition Root**（组合根）：全包唯一、不被外部 import、只做装配。

### 形态

```ts
// pkgs.ts/agent/bot/src/module.ts（新增）
import { createBot } from "./bot.js";              // ← 内部，不外露
import { createFileBotStore } from "./store-fs.js";

/**
 * Bot 包唯一的组合根。
 * 外部只拿到 BotService，拿不到 Bot / BotStore / createBot。
 */
export function createBotModule(opts: { home: string; store?: BotStore }): BotService {
    const store = opts.store ?? createFileBotStore({ home });
    // 内部怎么建 Bot、怎么串 store，全在这里消化
    return {
        snapshot: () => ...,
        create: (input) => ...,
        // ...
    };
}
```

### 判据（可写进评审清单）

> **一个包对外导出的每个符号，都要能回答「谁会用它」。**
> 答不上来（或答案是「装配需要」）⇒ 它该是包内私有的，用 Module 藏起来。

### 待办

- [ ] `@diy-agent/bot`：加 `createBotModule`，导出面收窄到 `createBotModule` + `BotService` 类型
- [ ] `Bot.newSession` / `sessions` 降级为包内函数（产品上 bot 只有一条永久会话）
- [ ] `nextBotId` 三份实现合并到一处（`bot.ts:170` / `chat.ts:835` / `bot-config-page/actions.ts:272`）
- [ ] `bot-config-page` 的 `actions.ts`（313 行）瘦身成校验 + 转调（core 逻辑进 `BotService`）
