# diy-app Electron 重写计划（零 Python）

**目标：** 将 diy 生态全部移植为 Electron + TypeScript。无 Python，无 PySide6。

## 架构现状（2026-07-10 更新）

```
┌─────────────────────────────────────────────────────────────────┐
│  @diy/rpc (3 层) — 纯 TS，零 Node.js 依赖                     │
│                                                                │
│  第3层: rpc.unary / rpc.serverStream / router / createHandler  │
│  第2层: Client (invoke/stream) + Server (onUnary/onServer...)  │
│  第1层: Transport 接口 + Envelope 信封协议                      │
│  + CLI-RPC 桥接 (CliApp ← CliApp.parse(argv))                  │
└─────────────────────────────────────────────────────────────────┘
        ↕ Envelope (JSON)              ↕ Envelope
        ↕                              ↕
┌───────────────┐            ┌──────────────────────┐
│ @diy/rpc-     │            │ @diy/rpc-transport-  │
│ transport     │            │ electron             │
│ (WebSocket /  │            │ (Electron IPC)       │
│  HTTP/2)      │            │ createMainTransport  │
└───────────────┘            └──────────────────────┘
        ↕                              ↕
   外部客户端                ┌──────────────────────┐
                            │  main/index.ts        │
                            │  Server + createHandler│
                            │  api.ts (单源真相)      │
                            ├──────────────────────┤
                            │  core/ + services/    │
                            ├──────────────────────┤
                            │  renderer/ (React)    │
                            │  Client + Transport   │
                            └──────────────────────┘
```

### 单源真相：api.ts

命令定义不再分 CL​I/RPC/IPC 三套适配器。`api.ts` 用 `rpc.unary()` / `rpc.serverStream()` 定义 procedure，
`@diy/rpc` 的 `createHandler` 自动绑定到所用 Transport（Electron IPC / WebSocket / HTTP/2）。
CLI 通过 `CliApp` 消费同一套 router。

### 包结构

| 包 | 说明 |
|----|------|
| `@diy/rpc` | 纯内核，Transport 接口 + Client/Server + 声明式 RPC + CLI-RPC 桥 |
| `@diy/rpc-transport` | 传输实现（WebSocket, HTTP/2） |
| `@diy/rpc-transport-electron` | Electron IPC 传输 |
| `diy-desktop2` | Electron 应用（main + renderer + preload） |

### 迁移状态

- ✅ api.ts 已定义所有 procedure（rpc.unary / rpc.serverStream）
- ✅ main/index.ts 已用 Server + createHandler 接入 IPC
- ✅ renderer 用 Client + Electron Transport 消费 api
- ❌ CLI 仍用旧 command/defs/（待迁移到 CliApp）
- ❌ 旧 command/defs/ + rpc-server.ts + rpc-client.ts 待清理

## Tech Stack

| 层 | 技术 |
|----|------|
| 桌面壳 | Electron + electron-vite |
| 前端 | React 18 + TypeScript |
| 样式 | TailwindCSS (Material3 暗色) |
| 状态 | zustand |
| 类型检查 | TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` 全开) |
| 运行时验证 | zod (schema + handler，单源真相) |
| CLI 解析 | commander (仅 argv parse + help，可替换) |
| RPC 传输 | net.Server (Unix socket) / fastify (HTTP) / Electron IPC |
| 测试 | vitest (环境隔离：DIY_HOME → /tmp/xxx，不碰生产) |
| ACP 客户端 | fetch → Hermes agent |
| 数据持久化 | 直接读写 ~/.diy/ (js-yaml + node:fs) |
| 文件监控 | chokidar (替代 QFileSystemWatcher) |

---

## 文件结构

```
pkgs/diy-desktop/
├── package.json
├── tsconfig.json              # strict: true, noUncheckedIndexedAccess
├── vite.config.ts
├── vitest.config.ts
├── tailwind.config.js
├── postcss.config.js
├── electron-builder.json
│
├── electron/                   # 主进程 (Node.js)
│   ├── main.ts
│   ├── preload.ts
│   │
│   ├── core/                   # 纯函数数据层 (文件 I/O)
│   │   ├── state.ts            # state.yaml + AGENTS.md + star
│   │   ├── task.ts             # 任务 CRUD + 校验
│   │   ├── subject.ts          # subject 管理
│   │   ├── task-tree.ts        # 任务树遍历
│   │   └── fs-lock.ts          # 文件锁
│   │
│   ├── command/                # 命令定义层 (单源真相)
│   │   ├── types.ts            # ArgDef<T>, CommandDef<P> 类型
│   │   ├── define.ts           # defineCommand() 工厂
│   │   ├── schema.ts           # 从 CommandDef 提取 zod schema
│   │   ├── registry.ts         # 命令注册表
│   │   └── defs/               # 各命令定义
│   │       ├── task.ts         # task create/show/list/edit/delete/star/unstar
│   │       ├── subject.ts      # subject add/list/remove
│   │       ├── ui.ts           # ui tree/status/agents
│   │       └── doctor.ts       # doctor
│   │
│   ├── adapters/               # 适配器 (CLI/RPC/GUI 各一)
│   │   ├── cli-runner.ts       # commander 适配
│   │   ├── rpc-server.ts       # Unix socket RPC (无 commander)
│   │   └── ipc-handlers.ts     # Electron IPC 适配
│   │
│   └── services/               # 服务层
│       ├── acp-agent.ts        # ACP 客户端
│       ├── file-watcher.ts     # chokidar
│       ├── llm-proxy.ts        # Fastify 代理
│       └── health.ts           # 健康检查
│
├── src/                        # 渲染进程 (React)
│   ├── App.tsx
│   ├── index.css
│   ├── components/
│   │   ├── TitleBar.tsx
│   │   ├── StatusBar.tsx
│   │   ├── TaskTree.tsx
│   │   ├── DetailPanel.tsx
│   │   ├── AgentChatPanel.tsx
│   │   ├── LLMPage.tsx
│   │   ├── LogPanel.tsx
│   │   └── Notification.tsx
│   ├── store/
│   │   ├── taskStore.ts
│   │   └── agentStore.ts
│   └── hooks/
│
├── tests/                      # 测试 (vitest, 环境隔离)
│   ├── setup.ts                # 强制 DIY_HOME → /tmp/xxx
│   ├── helper.ts               # 创建模拟目录/任务
│   ├── core/                   # 数据层测试
│   │   ├── state.test.ts
│   │   └── task.test.ts
│   └── command/                # 命令定义测试
│       └── task-def.test.ts
```

---

## Phase 0: 工具链 + 类型安全

### Task 0.1: 初始化项目 + strict tsconfig + vitest

**Files:**
- Create: `pkgs/diy-desktop/package.json`
- Create: `pkgs/diy-desktop/tsconfig.json`
- Create: `pkgs/diy-desktop/vite.config.ts`
- Create: `pkgs/diy-desktop/vitest.config.ts`
- Create: `pkgs/diy-desktop/tailwind.config.js`
- Create: `pkgs/diy-desktop/postcss.config.js`
- Create: `pkgs/diy-desktop/src/index.css`
- Create: `pkgs/diy-desktop/src/index.html`
- Create: `pkgs/diy-desktop/electron/main.ts`（骨架）
- Create: `pkgs/diy-desktop/electron/preload.ts`（骨架）
- Create: `pkgs/diy-desktop/src/App.tsx`（骨架）

**package.json:**

```json
{
  "name": "diy-desktop",
  "version": "0.1.0",
  "type": "module",
  "description": "diy 管控台 — Electron",
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "dist": "electron-vite build && electron-builder",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "typecheck:watch": "tsc --noEmit --watch"
  },
  "dependencies": {
    "zod": "^3.23.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "zustand": "^4.5.0",
    "js-yaml": "^4.1.0",
    "commander": "^12.0.0",
    "chokidar": "^3.6.0",
    "fastify": "^4.28.0",
    "@fastify/cors": "^9.0.0",
    "@fastify/http-proxy": "^9.0.0"
  },
  "devDependencies": {
    "electron": "^30.0.0",
    "electron-vite": "^2.3.0",
    "electron-builder": "^24.13.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^20.0.0",
    "typescript": "^5.5.0",
    "tailwindcss": "^3.4.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vitest": "^2.0.0"
  }
}
```

**tsconfig.json — strict 全开：**

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,     // obj[k] → T | undefined
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "exactOptionalPropertyTypes": true,
    "forceConsistentCasingInFileNames": true,

    "module": "ESNext",
    "moduleResolution": "bundler",
    "target": "ESNext",
    "lib": ["ESNext", "DOM"],
    "jsx": "react-jsx",
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,

    "baseUrl": ".",
    "paths": {
      "@/*": ["electron/*"],
      "@renderer/*": ["src/*"]
    },

    "outDir": "out",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["electron/**/*.ts", "src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["node_modules", "out", "dist"]
}
```

**vitest.config.ts — 环境隔离：**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
  },
})
```

**tests/setup.ts — 强制测试隔离（关键安全措施）：**

```ts
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ═══════════════════════════════════════════════
// 🛡️ 安全：每次测试运行分配一次性临时目录
//    测试代码读 process.env.DIY_HOME 时指向此处
//    绝不可能触及 ~/.diy/ 的生产数据
//    测试目录不删除（rm -rf 生产数据事故防范）
// ═══════════════════════════════════════════════

const testHome = mkdtempSync(join(tmpdir(), 'diy-desktop-test-'))
process.env['DIY_HOME'] = testHome
```

**App.tsx (骨架):**

```tsx
function App() {
  return (
    <div className="h-screen bg-[#1e1e2e] text-[#cdd6f4] flex flex-col">
      <div className="flex-1 flex items-center justify-center text-[#a6adc8]">
        diy 管控台
      </div>
    </div>
  )
}
```

**Verify:**
```bash
cd pkgs/diy-desktop
npm install
npx tsc --noEmit       # 0 errors
npm run test            # 0 tests (pass)
npm run dev             # Electron 窗口弹出
```

**Commit:**
```bash
git add pkgs/diy-desktop/
git commit -m "feat(diy-desktop): scaffold — strict TS, vitest with /tmp isolation, Electron"
```

---

### Task 0.2: 测试基础设施 + preload

**Files:**
- Create: `tests/helper.ts`
- Create: `tests/core/state.test.ts`（首个真实测试，验证隔离生效）
- Modify: `electron/preload.ts`
- Modify: `electron/main.ts`

**tests/helper.ts — 测试辅助：**

```ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import { diyHome } from '../electron/core/state'

/**
 * 在测试临时目录下创建 ~/.diy/state.yaml
 */
export function createStateYaml(data: Record<string, unknown>): string {
  const home = diyHome()
  mkdirSync(home, { recursive: true })
  const p = join(home, 'state.yaml')
  writeFileSync(p, yaml.dump(data, { indent: 2, noRefs: true }), 'utf-8')
  return p
}

/**
 * 在测试临时目录下创建一条任务 AGENTS.md
 * 返回任务 URI
 */
export function createTaskFile(params: {
  uri: string
  title?: string
  state?: string
  subject?: string
  body?: string
}): string {
  const { uri, title, state, subject, body } = params
  const home = diyHome()
  const taskPath = join(home, 'task', uri, 'AGENTS.md')
  mkdirSync(join(home, 'task', uri), { recursive: true })

  const front: Record<string, string | undefined> = { title, state, subject }
  const cleaned: Record<string, string> = {}
  for (const [k, v] of Object.entries(front)) {
    if (v !== undefined) cleaned[k] = v
  }

  const fm = yaml.dump(cleaned, { indent: 2, noRefs: true })
  writeFileSync(taskPath, `---\n${fm}---\n${body ?? ''}`, 'utf-8')
  return uri
}
```

**electron/preload.ts — 完整类型导出：**

```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { TaskNode } from './core/task-tree'
import type { TaskData } from './core/state'
import type { AgentStatus } from './services/acp-agent'

export interface AgentUpdateEvent {
  readonly agentId: string
  readonly state: string
  readonly taskUri: string
}

export interface DiyApi {
  loadTaskTree(allTasks?: boolean): Promise<TaskNode[]>
  getTask(uri: string): Promise<TaskData | null>
  listAgents(): Promise<AgentStatus[]>
  sendChat(uri: string, msg: string): Promise<string>
  onStateChange(cb: () => void): () => void
  onAgentUpdate(cb: (data: AgentUpdateEvent) => void): () => void
  executeCommand<R = unknown>(command: string, args: Record<string, unknown>): Promise<R>
}

contextBridge.exposeInMainWorld('diy', {
  loadTaskTree: (allTasks?: boolean) =>
    ipcRenderer.invoke('task:tree', allTasks),
  getTask: (uri: string) =>
    ipcRenderer.invoke('task:get', uri),

  listAgents: () =>
    ipcRenderer.invoke('agent:list'),
  sendChat: (uri: string, msg: string) =>
    ipcRenderer.invoke('agent:chat', uri, msg),

  onStateChange: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('event:state-change', handler)
    return () => ipcRenderer.removeListener('event:state-change', handler)
  },

  onAgentUpdate: (cb: (data: AgentUpdateEvent) => void) => {
    const handler = (_e: IpcRendererEvent, data: AgentUpdateEvent) => cb(data)
    ipcRenderer.on('event:agent-update', handler)
    return () => ipcRenderer.removeListener('event:agent-update', handler)
  },

  executeCommand: <R,>(command: string, args: Record<string, unknown>) =>
    ipcRenderer.invoke('command:execute', { command, args }) as Promise<R>,
} satisfies DiyApi)
```

**Commit:**
```bash
git add tests/helper.ts tests/setup.ts electron/preload.ts electron/main.ts
git commit -m "feat(diy-desktop): test helper + preload with full type exports"
```

---

## Phase 1: 核心数据层

> 纯函数，文件 I/O，无全局状态。每个函数直接读/写磁盘，天然请求隔离。
> 所有测试使用 `/tmp/diy-desktop-test-xxx/`，不碰 `~/.diy/`。

### Task 1.1: core/state.ts — state.yaml + AGENTS.md + star

**Files:**
- Create: `electron/core/state.ts`
- Create: `tests/core/state.test.ts`

**electron/core/state.ts — 类型全显式，无 `any`：**

```ts
import * as yaml from 'js-yaml'
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  unlinkSync, symlinkSync,
} from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'

// ═══════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════

export type TaskState =
  | 'pending' | 'active' | 'done' | 'cancelled'
  | 'blocked' | 'shelved' | 'new' | 'open' | 'closed'

export interface TaskMeta {
  readonly title?: string
  readonly state?: TaskState
  readonly subject?: string
  readonly parent?: string
  readonly detail?: string
  readonly body?: string
  readonly created?: string
  readonly updated?: string
  readonly source_type?: string
  readonly source_uri?: string
}

export interface TaskData extends TaskMeta {
  readonly uri: string
  readonly body: string
}

export interface Profile {
  readonly area: string
  readonly merge: string
  readonly approval: string | null
}

export interface SubjectInfo {
  readonly label?: string
  readonly desc?: string
}

export interface StateData {
  readonly profiles: ReadonlyMap<string, Profile>
  readonly subjects: ReadonlyMap<string, SubjectInfo>
}

// ═══════════════════════════════════════
// 路径
// ═══════════════════════════════════════

const DEFAULT_PROFILES: Record<string, Profile> = {
  quick: { area: 'main', merge: 'direct', approval: null },
  standard: { area: 'branch', merge: 'pr', approval: 'self' },
  reviewed: { area: 'worktree', merge: 'pr', approval: 'human' },
} as const

/** 获取 DIY_HOME。测试环境通过 setup.ts 的 process.env.DIY_HOME 隔离。 */
export function diyHome(): string {
  return process.env['DIY_HOME'] ?? join(homedir(), '.diy')
}

function stateFilePath(): string {
  return join(diyHome(), 'state.yaml')
}

function dataRoot(): string {
  const r = join(diyHome(), 'task')
  mkdirSync(r, { recursive: true })
  return r
}

export function taskDir(uri: string): string {
  return join(dataRoot(), uri)
}

export function taskFilePath(uri: string): string {
  return join(taskDir(uri), 'AGENTS.md')
}

// ═══════════════════════════════════════
// state.yaml 读写
// ═══════════════════════════════════════

export function loadState(): StateData {
  const p = stateFilePath()
  const raw: Record<string, unknown> = existsSync(p)
    ? (yaml.load(readFileSync(p, 'utf-8')) as Record<string, unknown> ?? {})
    : {}

  const profilesRaw = raw['profiles'] as Record<string, unknown> | undefined
  const profiles = new Map<string, Profile>(
    Object.entries({ ...DEFAULT_PROFILES, ...profilesRaw })
  )

  const subjectsRaw = raw['subjects'] as Record<string, unknown> | undefined
  const subjects = new Map<string, SubjectInfo>(
    Object.entries(subjectsRaw ?? {})
  )

  return { profiles, subjects }
}

export function saveState(data: {
  profiles?: ReadonlyMap<string, Profile> | Record<string, Profile>
  subjects?: ReadonlyMap<string, SubjectInfo> | Record<string, SubjectInfo>
}): void {
  const current = loadState()
  const merged: Record<string, unknown> = {}

  if (data.profiles) {
    const src = data.profiles instanceof Map
      ? Object.fromEntries(data.profiles)
      : data.profiles
    merged['profiles'] = { ...Object.fromEntries(current.profiles), ...src }
  }
  if (data.subjects) {
    const src = data.subjects instanceof Map
      ? Object.fromEntries(data.subjects)
      : data.subjects
    merged['subjects'] = { ...Object.fromEntries(current.subjects), ...src }
  }

  const p = stateFilePath()
  mkdirSync(dirname(p), { recursive: true })
  const tmp = p + '.tmp'
  writeFileSync(tmp, yaml.dump(merged, { indent: 2, noRefs: true }), 'utf-8')
  renameSync(tmp, p)
}

// ═══════════════════════════════════════
// AGENTS.md 解析
// ═══════════════════════════════════════

const FM_SEP = '---'

/** 解析 AGENTS.md: YAML frontmatter → TaskMeta + body */
export function parseTaskFile(raw: string): TaskMeta | null {
  if (!raw.startsWith(FM_SEP)) return null
  const endIdx = raw.indexOf(FM_SEP, 3)
  if (endIdx === -1) return null

  const headRaw = raw.slice(3, endIdx).trim()
  const body = raw.slice(endIdx + 3).trim()
  const front = yaml.load(headRaw) as Record<string, unknown> | null
  if (!front) return null

  return {
    title: front['title'] as string | undefined,
    state: front['state'] as TaskState | undefined,
    subject: front['subject'] as string | undefined,
    parent: front['parent'] as string | undefined,
    detail: front['detail'] as string | undefined,
    body,
    created: front['created'] as string | undefined,
    updated: front['updated'] as string | undefined,
    source_type: front['source_type'] as string | undefined,
    source_uri: front['source_uri'] as string | undefined,
  }
}

export function getTask(uri: string): TaskData | null {
  const fp = taskFilePath(uri)
  if (!existsSync(fp)) return null
  const meta = parseTaskFile(readFileSync(fp, 'utf-8'))
  if (!meta) return null
  return { uri, body: meta.body ?? '', ...meta }
}

export function taskExists(uri: string): boolean {
  return existsSync(taskFilePath(uri))
}

// ═══════════════════════════════════════
// Star / Unstar (symlink)
// ═══════════════════════════════════════

function starLink(uri: string): string {
  return join(diyHome(), 'star', uri.replace(/\//g, '__'))
}

export function starTask(uri: string): void {
  const sd = join(diyHome(), 'star')
  mkdirSync(sd, { recursive: true })
  const link = starLink(uri)
  if (!existsSync(link)) symlinkSync(taskDir(uri), link)
}

export function unstarTask(uri: string): void {
  const link = starLink(uri)
  if (existsSync(link)) unlinkSync(link)
}

export function isStarred(uri: string): boolean {
  return existsSync(starLink(uri))
}

// ═══════════════════════════════════════
// 路径规范化
// ═══════════════════════════════════════

export function norm(p: string): string {
  const home = homedir()
  const expanded = resolve(p.replace(/^~/, home))
  if (expanded === home) return '~'
  if (expanded.startsWith(home + '/')) return '~' + expanded.slice(home.length)
  return expanded
}
```

**tests/core/state.test.ts — 意图测试，数据在临时目录：**

```ts
import { describe, it, expect } from 'vitest'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { diyHome } from '../../electron/core/state'
import {
  loadState, saveState, parseTaskFile, getTask,
  starTask, unstarTask, isStarred,
} from '../../electron/core/state'

describe('state.yaml 读写', () => {
  it('无 state.yaml 时返回默认值', () => {
    const state = loadState()
    expect(state.profiles.get('quick')?.area).toBe('main')
    expect(state.profiles.get('standard')?.merge).toBe('pr')
    expect(state.subjects.size).toBe(0)
  })

  it('保存后再加载数据一致', () => {
    saveState({ subjects: new Map([['~/work', { label: 'Work' }]]) })
    const loaded = loadState()
    expect(loaded.subjects.get('~/work')?.label).toBe('Work')
  })
})

describe('parseTaskFile', () => {
  it('解析标准 AGENTS.md', () => {
    const raw = `---
title: 测试任务
state: active
subject: ~/work
---
这是正文`
    const meta = parseTaskFile(raw)
    expect(meta?.title).toBe('测试任务')
    expect(meta?.state).toBe('active')
    expect(meta?.subject).toBe('~/work')
    expect(meta?.body).toBe('这是正文')
  })

  it('纯文本返回 null', () => {
    expect(parseTaskFile('纯文本')).toBeNull()
  })
})

describe('star / unstar', () => {
  it('star → unstar 状态正确', () => {
    const uri = 'test-star'
    mkdirSync(join(diyHome(), 'task', uri), { recursive: true })
    writeFileSync(join(diyHome(), 'task', uri, 'AGENTS.md'),
      '---\ntitle: Star测试\n---')

    expect(isStarred(uri)).toBe(false)
    starTask(uri)
    expect(isStarred(uri)).toBe(true)
    unstarTask(uri)
    expect(isStarred(uri)).toBe(false)
  })
})

describe('getTask', () => {
  it('读取已有任务、不存在的返回 null', () => {
    const uri = 'test-get'
    mkdirSync(join(diyHome(), 'task', uri), { recursive: true })
    writeFileSync(join(diyHome(), 'task', uri, 'AGENTS.md'),
      '---\ntitle: T\nstate: pending\n---\nbody')

    const task = getTask(uri)
    expect(task?.title).toBe('T')
    expect(task?.uri).toBe(uri)
    expect(task?.body).toBe('body')

    expect(getTask('nonexistent')).toBeNull()
  })
})
```

**Verify:**
```bash
npx vitest run tests/core/state.test.ts
# 验证隔离：DIY_HOME 指向 /tmp/diy-desktop-test-xxx
echo $DIY_HOME  # 不应包含 ~/.diy
```

**Commit:**
```bash
git add electron/core/state.ts tests/core/state.test.ts
git commit -m "feat(diy-desktop): core/state — state.yaml R/W, task parser, star, full tests"
```

---

### Task 1.2: core/task.ts — 任务 CRUD + zod 校验

**Files:**
- Create: `electron/core/task.ts`
- Create: `tests/core/task.test.ts`

核心实现在之前已有完整代码示例，这里只列测试意图的关键模式：

```ts
// tests/core/task.test.ts — 意图测试模式
// 🎯 每条用例验证一个明确的行为意图

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { diyHome, saveState } from '../../electron/core/state'
import {
  createTask, updateTask, deleteTask, listTasks, ValidationError,
} from '../../electron/core/task'

describe('createTask', () => {
  it('创建后文件存在、内容正确、自动 star', () => {
    saveState({ subjects: new Map([['~/work', { label: '工作' }]]) })
    const uri = createTask({ title: '测试任务', subject: '~/work' })

    const fp = join(diyHome(), 'task', uri, 'AGENTS.md')
    expect(existsSync(fp)).toBe(true)

    const content = readFileSync(fp, 'utf-8')
    expect(content).toContain('title: 测试任务')
    expect(content).toContain('state: pending')
  })

  it('空标题 → ValidationError', () => {
    expect(() => createTask({ title: '', subject: '~/work' }))
      .toThrow(ValidationError)
  })

  it('未注册 subject → ValidationError', () => {
    expect(() => createTask({ title: '任务', subject: '~/unknown' }))
      .toThrow(ValidationError)
  })
})
```

**Commit:**
```bash
git add electron/core/task.ts tests/core/task.test.ts
git commit -m "feat(diy-desktop): core/task — CRUD with zod validation + intent tests"
```

---

### Task 1.3: core/task-tree.ts — 任务树遍历

**Files:**
- Create: `electron/core/task-tree.ts`
- Create: `tests/core/task-tree.test.ts`

类型定义：

```ts
export interface TaskNode {
  readonly kind: 'subject' | 'task'
  readonly uri?: string
  readonly title?: string
  readonly state?: TaskState
  readonly subjectPath?: string
  readonly parentUri?: string
  readonly starred: boolean
  readonly children: readonly TaskNode[]
}
```

核心函数：

```ts
export function loadTaskTree(allTasks?: boolean): TaskNode[]
export function renderTreeText(nodes: readonly TaskNode[], indent?: string): string
```

**Commit:**
```bash
git commit -m "feat(diy-desktop): core/task-tree — disk tree walk + text render"
```

---

### Task 1.4: core/subject.ts + fs-lock.ts

**Files:**
- Create: `electron/core/subject.ts`
- Create: `electron/core/fs-lock.ts`

```ts
// electron/core/subject.ts
export function addSubject(path: string, label?: string, desc?: string): void
export function removeSubject(path: string): void
export function listSubjects(): Array<{ path: string; info: SubjectInfo }>
```

```ts
// electron/core/fs-lock.ts
export function tryLock(lockPath: string, timeout?: number): { release(): void } | null
```

**Commit:**
```bash
git commit -m "feat(diy-desktop): core/subject + fs-lock"
```

---

## Phase 1B: 命令定义层

> `command/defs/*.ts` 是单源真相：CLI、RPC、GUI 三套适配器都从 registry 消费同一份定义。
> 每条命令 = `zod schema` + `async handler`。添加新命令只需加一个 `defs/*.ts` 文件 + 注册到 registry。

### Task 1B.1: command/types.ts + define.ts + schema.ts

**Files:**
- Create: `electron/command/types.ts`
- Create: `electron/command/define.ts`
- Create: `electron/command/schema.ts`

```ts
// electron/command/types.ts
// 所有类型显式定义，IDE 可精确导航到每个字段的用法

import type { z } from 'zod'

export interface ArgDef<T extends z.ZodType = z.ZodType> {
  /** zod 类型（含验证规则） */
  readonly type: T
  /** CLI 短选项，例 't' → -t */
  readonly short?: string
  /** CLI 位置参数索引，0 = 第1个位置参数 */
  readonly positional?: number
  /** CLI --help 显示文本 */
  readonly help?: string
}

/** 命令定义 — 单源真相。
 *  P 是 args 的键到 ArgDef 的映射，handler 的 params 类型由此推断。
 */
export interface CommandDef<P extends Record<string, ArgDef> = Record<string, ArgDef>> {
  /** 命令全名，例 'task create' */
  readonly name: string
  /** --help 顶部描述 */
  readonly description: string
  /** 参数定义 */
  readonly args: P
  /** 执行函数（纯 async，无全局变量依赖）
   *  params 类型 = { [K in keyof P]: z.infer<P[K]['type']> }
   */
  readonly handler: (
    params: { [K in keyof P]: z.infer<P[K]['type']> }
  ) => Promise<unknown>
}
```

```ts
// electron/command/define.ts
import type { CommandDef } from './types'

/** 定义一条命令。纯数据声明，无副作用。 */
export function defineCommand<P extends Record<string, any>>(
  def: CommandDef<P>
): CommandDef<P> {
  return def
}
```

```ts
// electron/command/schema.ts
import { z } from 'zod'
import type { CommandDef } from './types'

/** 从 CommandDef.args 提取 zod schema（CLI / RPC 共用验证入口） */
export function buildSchema(def: CommandDef): z.ZodObject<Record<string, z.ZodType>> {
  const shape: Record<string, z.ZodType> = {}
  for (const [key, arg] of Object.entries(def.args)) {
    shape[key] = arg.type
  }
  return z.object(shape)
}
```

**Commit:**
```bash
git add electron/command/types.ts electron/command/define.ts electron/command/schema.ts
git commit -m "feat(diy-desktop): command DSL — ArgDef, CommandDef, defineCommand, buildSchema"
```

---

### Task 1B.2: 各命令定义 + registry

**Files:**
- Create: `electron/command/defs/task.ts`
- Create: `electron/command/defs/subject.ts`
- Create: `electron/command/defs/ui.ts`
- Create: `electron/command/defs/doctor.ts`
- Create: `electron/command/registry.ts`

命令定义示例：

```ts
// electron/command/defs/task.ts
import { z } from 'zod'
import { defineCommand } from '../define'
import { createTask, updateTask, deleteTask, listTasks, ValidationError } from '../../core/task'
import { getTask, starTask, unstarTask, TaskState } from '../../core/state'

export const taskCreateDef = defineCommand({
  name: 'task create',
  description: '创建一个新任务',
  args: {
    title: {
      type: z.string().min(1, '标题不能为空').max(200),
      positional: 0,
      short: 't',
      help: '任务标题',
    },
    subject: {
      type: z.string(),
      positional: 1,
      short: 's',
      help: '所属 subject 路径',
    },
    parent: {
      type: z.string().optional(),
      short: 'p',
      help: '父任务 URI',
    },
  },
  handler: async ({ title, subject, parent }) => {
    const uri = createTask({ title, subject, parent })
    return { status: 'ok', data: { uri } }
  },
})

export const taskListDef = defineCommand({
  name: 'task list',
  description: '列出任务',
  args: {
    subject: {
      type: z.string().optional(),
      short: 's',
      help: '按 subject 筛选',
    },
  },
  handler: async ({ subject }) => {
    const uris = listTasks(subject)
    return { status: 'ok', data: { tasks: uris } }
  },
})

export const taskShowDef = defineCommand({
  name: 'task show',
  description: '查看任务详情',
  args: {
    uri: {
      type: z.string(),
      positional: 0,
      help: '任务 URI',
    },
  },
  handler: async ({ uri }) => {
    const task = getTask(uri)
    if (!task) return { status: 'error', msg: `任务 ${uri} 不存在` }
    return { status: 'ok', data: task }
  },
})
```

**registry.ts — 所有适配器通过它取命令：**

```ts
// electron/command/registry.ts
import type { CommandDef } from './types'
import { taskCreateDef, taskListDef, taskShowDef, taskEditDef, taskDeleteDef, taskStarDef, taskUnstarDef } from './defs/task'
import { subjectAddDef, subjectListDef, subjectRemoveDef } from './defs/subject'
import { uiTreeDef, uiStatusDef } from './defs/ui'
import { doctorDef } from './defs/doctor'

export const allCommands: readonly CommandDef[] = [
  taskCreateDef, taskListDef, taskShowDef,
  taskEditDef, taskDeleteDef, taskStarDef, taskUnstarDef,
  subjectAddDef, subjectListDef, subjectRemoveDef,
  uiTreeDef, uiStatusDef,
  doctorDef,
]

export function findCommand(name: string): CommandDef | undefined {
  return allCommands.find(c => c.name === name)
}
```

**Commit:**
```bash
git add electron/command/defs/ electron/command/registry.ts
git commit -m "feat(diy-desktop): command defs — task/subject/ui/doctor + registry"
```

---

## Phase 2: 适配器层（CLI + RPC + GUI）

> 三套适配器从 registry 消费同一份 command def。commander 只做 argv → params 映射，
> 不参与 RPC 路径。RPC 路径直接用 JSON dispatch，无 commander 状态问题。

### Task 2.1: adapters/cli-runner.ts — Commander 适配

```ts
import { Command } from 'commander'
import * as yaml from 'js-yaml'
import { allCommands } from '../command/registry'
import { buildSchema } from '../command/schema'

/** CLI 入口：commander 仅做 argv → {key: value} 映射 + --help 生成 */
export function runCli(argv: string[]): void {
  const program = new Command()
  program.name('diy').description('diy 管控台 CLI')

  for (const def of allCommands) {
    const cmd = program.command(def.name).description(def.description)

    // 位置参数
    const positional = Object.entries(def.args)
      .filter((entry): entry is [string, typeof entry[1] & { positional: number }] =>
        entry[1].positional !== undefined)
      .sort((a, b) => a[1].positional - b[1].positional)

    for (const [key, arg] of positional) {
      cmd.argument(`<${key}>`, arg.help ?? '')
    }

    // 命名参数
    for (const [key, arg] of Object.entries(def.args)) {
      if (arg.positional !== undefined) continue
      const flag = arg.short ? `-${arg.short}, --${key}` : `--${key}`
      cmd.option(flag, arg.help ?? '')
    }

    cmd.action(async (...rawArgs: unknown[]) => {
      const options = rawArgs[rawArgs.length - 2] as Record<string, unknown> ?? {}
      const positionalVals = rawArgs.slice(0, positional.length) as string[]

      const params: Record<string, unknown> = { ...options }
      for (let i = 0; i < positionalVals.length; i++) {
        const key = positional[i]?.[0]
        if (key) params[key] = positionalVals[i]
      }

      const schema = buildSchema(def)
      const parsed = schema.safeParse(params)
      if (!parsed.success) {
        console.error('参数错误:', JSON.stringify(parsed.error.issues, null, 2))
        process.exit(1)
      }

      try {
        const result = await def.handler(parsed.data)
        console.log(yaml.dump(result, { indent: 2, noRefs: true }))
      } catch (e) {
        console.error('错误:', e instanceof Error ? e.message : String(e))
        process.exit(1)
      }
    })
  }

  program.parse(argv)
}
```

**Commit:**
```bash
git add electron/adapters/cli-runner.ts
git commit -m "feat(diy-desktop): CLI adapter — commander wraps defs, output YAML"
```

---

### Task 2.2: adapters/rpc-server.ts — Unix socket RPC

```ts
import net from 'net'
import { unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { diyHome } from '../core/state'
import { findCommand } from '../command/registry'
import { buildSchema } from '../command/schema'

/** RPC 服务器：纯 JSON dispatch，无 commander 参与，每条请求独立执行 */
export class RpcServer {
  private server: net.Server | null = null

  private async handleOne(
    payload: { command: string; args: Record<string, unknown> }
  ): Promise<string> {
    const def = findCommand(payload.command)
    if (!def) {
      return JSON.stringify({ status: 'error', msg: `未知命令: ${payload.command}` })
    }

    const schema = buildSchema(def)
    const parsed = schema.safeParse(payload.args)
    if (!parsed.success) {
      return JSON.stringify({ status: 'error', errors: parsed.error.issues })
    }

    try {
      const result = await def.handler(parsed.data)
      return JSON.stringify(result)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return JSON.stringify({ status: 'error', msg })
    }
  }

  start(): void {
    const socketPath = join(diyHome(), 'app.sock')
    if (existsSync(socketPath)) unlinkSync(socketPath)

    this.server = net.createServer((socket) => {
      let buf = ''
      socket.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        if (buf.endsWith('\n')) {
          try {
            const payload = JSON.parse(buf.trim()) as {
              command: string
              args: Record<string, unknown>
            }
            this.handleOne(payload).then((resp) => {
              socket.write(resp + '\n')
              socket.end()
            })
          } catch (e) {
            socket.write(JSON.stringify({
              status: 'error',
              msg: e instanceof Error ? e.message : 'JSON parse error',
            }) + '\n')
            socket.end()
          }
          buf = ''
        }
      })
    })
    this.server.listen(socketPath)
  }

  stop(): void {
    this.server?.close()
    const socketPath = join(diyHome(), 'app.sock')
    if (existsSync(socketPath)) unlinkSync(socketPath)
  }
}
```

**RPC 调用示例：**
```bash
echo '{"command":"task list","args":{}}' | nc -U ~/.diy/app.sock
# → {"status":"ok","data":{"tasks":["local/abc"]}}
```

**Commit:**
```bash
git add electron/adapters/rpc-server.ts
git commit -m "feat(diy-desktop): RPC adapter — Unix socket, JSON dispatch, no commander"
```

---

### Task 2.3: adapters/ipc-handlers.ts — Electron IPC

```ts
import { ipcMain } from 'electron'
import { findCommand, allCommands } from '../command/registry'
import { buildSchema } from '../command/schema'

export function registerIpcHandlers(): void {
  ipcMain.handle('command:execute', async (_e, payload: {
    command: string
    args: Record<string, unknown>
  }) => {
    const def = findCommand(payload.command)
    if (!def) return { status: 'error', msg: `未知命令: ${payload.command}` }

    const schema = buildSchema(def)
    const parsed = schema.safeParse(payload.args)
    if (!parsed.success) return { status: 'error', errors: parsed.error.issues }

    return def.handler(parsed.data)
  })

  // GUI 构建菜单用
  ipcMain.handle('command:list', async () => {
    return allCommands.map(def => ({
      name: def.name,
      description: def.description,
      args: Object.entries(def.args).map(([key, arg]) => ({
        key,
        positional: arg.positional,
        short: arg.short,
        help: arg.help,
      })),
    }))
  })
}
```

**Commit:**
```bash
git add electron/adapters/ipc-handlers.ts
git commit -m "feat(diy-desktop): IPC adapter — GUI calls same command defs via Electron IPC"
```

---

## Phase 3: 代码检查闭环

在每个 `command/defs/*.ts` 文件旁，加意图测试确保 handler 行为正确：

```ts
// tests/command/task-def.test.ts
import { describe, it, expect } from 'vitest'
import { taskCreateDef, taskListDef } from '../../electron/command/defs/task'
import { buildSchema } from '../../electron/command/schema'
import { saveState } from '../../electron/core/state'

describe('taskCreateDef schema', () => {
  it('拒绝空标题', () => {
    const schema = buildSchema(taskCreateDef)
    const result = schema.safeParse({ title: '', subject: '~/work' })
    expect(result.success).toBe(false)
  })

  it('接受有效参数', () => {
    const schema = buildSchema(taskCreateDef)
    const result = schema.safeParse({ title: '有效', subject: '~/work' })
    expect(result.success).toBe(true)
  })
})

describe('taskCreateDef handler', () => {
  it('返回值含 uri', async () => {
    saveState({ subjects: new Map([['~/work', { label: 'W' }]]) })
    const result = await taskCreateDef.handler({ title: '测试', subject: '~/work' })
    const data = result as { status: string; data: { uri: string } }
    expect(data.status).toBe('ok')
    expect(data.data.uri).toBeTruthy()
  })
})
```

---

## 实施时间线

| Phase | 内容 | 预计工时 |
|-------|------|---------|
| 0 | 工具链 + 类型安全 + 测试隔离 | 1 天 |
| 1 | 核心数据层 (state, task, task-tree, subject, fs-lock) | 2-3 天 |
| 1B | 命令定义层 (types, define, schema, defs/*, registry) | 1 天 |
| 2 | 适配器层 (CLI + RPC + IPC) | 1-2 天 |
| 3 | 服务层 (ACP agent, file-watcher, llm-proxy, health) | 1 天 |
| 4 | React UI (6-8 个组件) | 3-4 天 |
| 5 | 收尾 + 打包 | 1 天 |

**总计：约 10-13 天**

---

## 安全/质量约束（必读）

### 测试隔离

```
❌ 测试代码绝不可读写 ~/.diy/
✅ tests/setup.ts 强制 DIY_HOME → /tmp/diy-desktop-test-xxx/
✅ 每个测试运行新建临时目录，不删除（防 rm -rf 事故）
```

### 类型安全

```
❌ export function foo(data: Record<string, unknown>)
✅ export function foo(data: { title: string; state?: TaskState })
❌ const result = yaml.load(raw) as any
✅ const result = yaml.load(raw) as Record<string, unknown> | null
   然后逐个字段 as string | undefined 转换
```

### 命令定义原则

```
✅ 命令定义 (defs/*.ts) 不 import 任何适配器
✅ 适配器不修改命令定义，只做输入格式映射
✅ 添加适配器 = 新文件，零改动现有 defs/
```

### M1 里程碑（可独立使用）

1. ✅ `npx tsc --noEmit` 0 errors
2. ✅ `npm run test` 全部通过（数据在 /tmp/，不碰生产）
3. ✅ `diy ui tree` 等 CLI 命令正常工作
4. ✅ `echo '{...}' | nc -U ~/.diy/app.sock` RPC 正常响应
5. ✅ React 窗口渲染任务树 + 详情面板
6. ✅ 文件变化自动推送（chokidar → IPC → React）
