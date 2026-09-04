# diy-app 开发规范

## 架构原则

### 构建

- **无 electron-vite**，直接使用 Vite 8 三独立配置（main / preload / renderer）
- `scripts/electron-dev.mts` 自有开发编排，不依赖 electron-vite 封装

### 开发参数

```
npm run dev                    # 默认 ./build/home + port 18888（与 ./diy.sh 同数据）
npm run dev -- --port 18888    # 指定端口（测试端口冲突）
```

数据隔离由 `DIY_HOME` 驱动（`diy.sh` / `electron-dev.mts` 默认 `./build/home`，测试用 `mkdtemp`），不再有 `--temp` flag。

### 入口与运行配置（环境变量契约）

两个 CLI 入口只负责**注入环境变量**，业务侧统一由 `src/runtime.ts readRuntimeConfig()` 读取组装，不做路径/模式派生。

| 入口 | 场景 | 跑什么 | 注入 |
|------|------|--------|------|
| `./diy.sh`（仓库根） | worktree 开发/测试 | `tsx src/cli/index.ts` | `DIY_HOME=./build/home`、`DIY_APP_ROOT=pkgs.ts/diy-app` |
| `bin/diy` | 发布后（npm 全局/PATH） | `node out/cli/index.js` | `DIY_HOME=~/.diy`、`DIY_APP_ROOT=<自定位包根>` |

环境变量契约（`src/runtime.ts`）：

| 变量 | 含义 | 缺省 |
|------|------|------|
| `DIY_HOME` | 数据根（state/task/**app.port**） | `~/.diy` |
| `DIY_PORT` | 首选端口；测试注入 `0`（随机） | 无 → app.port 文件 → 兜底 18888 |
| `DIY_DEV_SERVER_URL` | dev GUI 加载 Vite URL（`electron-dev.mts` 注入） | 无 → loadFile 产物 |

端口优先级：`DIY_PORT` > `app.port` 文件（上次实例） > 18888。

### 组件分层

```
components/ui/              ← shadcn 官方组件（通过 npx shadcn add 安装）
                              禁止手动修改，会被脚本覆盖
                              需要更新时：npx shadcn add <component> -o

components-diy/             ← 我们自己的业务组件
  ├── store/                ← zustand stores
  ├── lib/                  ← 业务工具函数
  └── App.tsx               ← 应用根组件（可引用 ui/ 和 diy/ 组件）

lib/                        ← shadcn 官方工具（utils.ts 等）
hooks/                      ← shadcn 官方 hooks
```

### 通用 UI 组件策略

- ❌ 不自己开发通用 UI 组件
- ✅ 优先使用 shadcn 官方组件（`components/ui/`）
- ✅ 用官方组件组合成业务组件（放 `components-diy/`）

### 样式策略

- ❌ 不修改 `@import "shadcn/tailwind.css"` 官方主题
- ❌ 不修改 `:root` / `.dark` 官方色值
- ✅ 自定义颜色用 `diy-` 前缀，在 `@theme inline` 块末尾追加
  - 例：`--color-diy-state-pending: #e5c07b;` → 用法 `bg-diy-state-pending`
- ✅ 默认 dark 模式：`index.html` 写死 `class="dark"` + `ThemeProvider defaultTheme="dark"`（不改官方 `.dark` 块）
  - ❌ 主题不得回落到 `prefers-color-scheme`（即 `defaultTheme` 不能是 `"system"`）——
    Playwright 的 `colorScheme` 默认值是 `"light"`，attach CDP 时会覆盖系统外观把界面刷白
  - ✅ 用户显式选择存 `localStorage.theme`，优先级高于 `defaultTheme`，`d` 键可切换

## UI 调试（CDP + playwright-cli）

Electron 启动时带 `--remote-debugging-port=0`（随机空闲端口），把真实窗口暴露成 CDP
端点，`playwright-cli` 可直接 attach 驱动 —— 这是验证 renderer 行为的**唯一可靠手段**，
CLI 的 RPC 返回成功不等于 UI 渲染正确。

### 取 CDP 地址

Chromium 把实际端口写入 `DIY_HOME/electron_user_data/DevToolsActivePort`（两行：端口、browser path）。

| 启动方式 | 行为 |
|---------|------|
| `npm run dev` | 轮询该文件，启动日志打印完整 `attach` 命令 |
| `./diy.sh <cmd>` | 冷启动 app 时在 stderr 提示 `attach` 命令 |
| `tests/electron-test.ts` | `startElectronTest()` 返回的 `cdpUrl` 已是可直接 attach 的完整 URL |

端口每次重启都变，**禁止硬编码**，按需读取：

```bash
cat "$DIY_HOME/electron_user_data/DevToolsActivePort"    # 或 curl http://127.0.0.1:<port>/json/version
```

### 标准测试流程

```bash
npm run dev                                   # 日志末尾给出 attach 命令
playwright-cli attach --cdp=ws://127.0.0.1:<port>/devtools/browser/<id>
playwright-cli snapshot                       # 拿 ref（每次交互后 ref 会变，需重拍）
playwright-cli click <ref>                    # / fill / check / select / press
playwright-cli eval "document.documentElement.className"   # 断言 DOM 状态
playwright-cli console error                  # 查渲染层报错
playwright-cli detach
```

### 陷阱

- ❌ **不要用 `playwright-cli open http://localhost:5173/`** 测 dev 界面。Vite URL 直开时
  没有 Electron preload，`window.transport` 不存在，`ChannelClientBinding` 抛
  `Cannot read properties of undefined (reading 'on')` → 白屏。要看真界面只能 attach CDP，
  或走 `npm run serve`（它在 `index.html` 注入 WS transport）。
- ⚠️ `run-code` 必须传 arrow 函数：`playwright-cli run-code "async (page) => { ... }"`；
  裸语句 `await page.x()` 会 `SyntaxError`。
- ⚠️ `.playwright/cli.config.json` 的 `contextOptions` **对 attach 无效**（只对 `open`
  新建的 context 生效）。
- ⚠️ `detach` 不复位已注入的媒体仿真，它会留在 target 上；需要显式
  `page.emulateMedia({ colorScheme: 'no-override' })`。
- 📄 机制详解与可重跑证据：`scripts/cdp-colorscheme-demo.mts`（演示 Playwright 默认
  `colorScheme:'light'` 如何覆盖系统外观）。

### 窗口定位副屏

`DIY_MIRROR_DISPLAY=1` 时窗口居中到非主屏（优先 Sidecar iPad），避免遮挡开发用的主屏。
`npm run dev` / `./diy.sh` / 意图测试均已默认注入；单屏环境自动回退默认定位。

### 硬性约束：子进程 stdio 的 pipe 规则

**判据不是「能不能 pipe」，而是「读端是否一定被排空」。** 两种情况会出事：

1. **pipe 了却没人读** —— 管道缓冲（约 64KB）填满后，子进程卡在 `write` 上假死，无报错
   （ACP agent stderr 曾踩中）
2. **pipe 的读端先消失** —— `detached + unref` 的 spawn（`./diy.sh` 冷启动路径）父进程一退出
   读端即关闭，子进程后续写 stderr 抛 `EPIPE` → 升级成未捕获异常 → Electron 内置处理器调用
   **同步** `dialog.showErrorBox` → 主进程事件循环冻死（表现为 RPC 与 CDP 同时无响应 +
   屏幕弹框），且不生成 `.ips`、`log show` 亦无记录

因此：

- 常驻/分离式 spawn（CLI、`npm run dev`）→ 一律 `inherit` 或 `ignore`
- 测试 spawn（父进程活着的 `electron-test.ts`）→ 允许 `pipe`，但**必须挂 `data` 监听持续排空**；
  只保留有界尾部（如末 4KB）供失败诊断
- ⚠️ **不得**为了解析 `DevTools listening on ...` 而 pipe stderr —— 取 CDP 地址一律读
  `DevToolsActivePort` 文件，与 stdio 接法完全解耦

### 常驻进程可观测性

`src/main/services/diagnostics.ts` 被**三个入口共用**，各落独立日志（避免互相滚掉）：

| 入口 | 调用 | 日志 |
|------|------|------|
| Electron 主进程 | `installDiagnostics(home)` | `<DIY_HOME>/log/main.log` |
| serve 模式 | `installDiagnostics(home, "serve")` | `<DIY_HOME>/log/serve.log` |
| CLI | `installDiagnostics(home, "cli")` | `<DIY_HOME>/log/cli.log` |
| ACP agent 子进程 stderr | `createLogSink(home, "acp")` | `<DIY_HOME>/log/acp.log` |

承担三件事：

| 能力 | 说明 |
|------|------|
| 日志落地 | console 全量镜像到文件（5MB 滚动为 `.1`），终端输出不受影响 |
| EPIPE 防护 | 给 `stdout`/`stderr` 挂 `error` 监听 —— 管道断线时不再升级成 `uncaughtException` |
| 异常兜底 | `uncaughtException` / `unhandledRejection` 落文件并继续运行，**覆盖 Electron 默认模态异常框** |

```bash
tail -f build/home/log/main.log        # dev（DIY_HOME=./build/home）
grep FATAL <DIY_HOME>/log/*.log        # 只看致命错误
```

覆盖面边界（别误以为无所不包）：

- ✅ 第②层覆盖**主进程任意来源**的未捕获异常，不限于 EPIPE；第①层只管 stdout/stderr 两条流
- ❌ 渲染进程 / preload 异常**不在范围内**（TODO 见 `diagnostics.ts` 内注释）
- ❌ 原生崩溃（SIGSEGV / OOM / V8 fatal）与主动 `process.exit()` 不会留痕
- ⚠️ 未捕获异常**不会**生成 `.ips` 崩溃报告，`log show` 也查不到 —— 只有这个文件有
- ✅ 异常后进程常驻，RPC / CDP 继续可用，因此远程（Tailscale + playwright-cli）排障成立
- 📊 弹框成因的可重跑证据：仓库根 `scripts/repro-epipe-dialog.mts`（EPIPE/throw × 有无防护
  四场景矩阵，用 HTTP 探针 + 文件心跳量化事件循环冻结）。其依据是 Electron 内置处理器：
  `process.on("uncaughtException", e => process.listenerCount("uncaughtException") > 1 || dialog.showErrorBox(...))`
  —— 守卫意味着 **app 只要自注册处理器就不会弹框**，与「代码里有没有 try/catch」无关。

### ACP 协议实测注意事项

落地日志后暴露出的真实行为，写代码时按此为准（均已在 opencode 上实测）：

- **`listModels` 的 `id` 与 `name` 不是一回事**：`id` 形如 `lkeap/tc-code-latest`（传给
  `set_model` 的唯一合法值），`name` 才是 `lkeap/Auto` 这种展示名。传 name 会被拒
  `Invalid params: model not found`。
- **agent 的失败可能只出现在它自己的 stderr**，不回填 JSON-RPC error → 客户端会误判成功。
  所以 `log/acp.log` 是排查 agent 侧问题的第一入口，不是可选噪音。
- **opencode 不推 `config_option_update`**，且 `session/set_model` 响应体是 `{}`。
  因此 `currentModelId` 走「实时推送 > 本端切换记账 > 建会话快照」三级优先；
  只读快照会让 `status` 永远报旧模型。
- **子进程 stderr 必须被消费**：`stdio` 里给了 `pipe` 却无人读，64KB 缓冲填满后
  子进程在 write 上阻塞 → agent 假死且无任何报错（`AcpAgentV2` 已接 `stderrSink`）。
- **不要静默吞异常**：切模型只允许放过 `-32601`（agent 未实现该方法），其余一律冒泡并
  记日志。以前一律 `catch {}` 导致「用户以为切了，实际还在旧模型上跑」。

## Serve 模式（Web / 远程开发）

云服务器无 Electron 时，通过 `src/serve/index.ts` 启动纯 Web 服务。

### 启动

```
npm run serve                    # 默认 18888
npm run serve -- --port <port>    # 指定端口
npm run serve:build              # 生产构建
```

### 架构

```
浏览器 ──WebSocket──→ http.createServer + ws.WebSocketServer
                         ↓
                      WsTransport → Server → createHandler(api)
                         ↓
                      setNotifyRenderer → wss.clients 广播
```

- HTTP 提供静态 SPA（构建产物 `out/renderer/`）
- WebSocket 承载 RPC 通信（`@diy/rpc` 协议）
- renderer 零改动：serve 在 `index.html` 注入 `<script>` 设置 `window.transport` + `window.diy.onUiCommand`
- 绑定 `127.0.0.1`，通过 Tailscale Serve 对外暴露
- ⚠️ `index.html` 在**启动时一次性读入内存**（因为要注入 WS bootstrap，见 `serve/index.ts:63`）。
  所以改完 renderer 重新 `vite build` 后，**必须重启 serve** 才生效；否则浏览器会去请求已被
  删除的旧 hash 资源，拿回 index.html 兜底页 → `Failed to load module script ... MIME type
  "text/html"` → SPA 根本不挂载（`#root` 空、body 无文本）。此时任何「页面没报错」的断言都是
  假通过，断言必须正向检查渲染出来的值。

### Tailscale 暴露

```bash
tailscale serve --bg --https 18888 http://127.0.0.1:18888
```

访问 `https://<tailscale-hostname>:<port>`（HTTPS，Tailscale 自动 TLS）。

查看当前 Tailscale 主机名：`tailscale status | grep $(hostname) | awk '{print $2}'`

访问地址：`https://<hostname>:<port>`

### 端口规划

| 用途 | 默认端口 | 说明 |
|------|---------|------|
| RPC + Web Serve | 18888 | HTTP/2（Electron）或 HTTP+WS（Serve），仅 `127.0.0.1` |
| LLM 代理 | 8000 | 内部 Fastify |
| CDP（playwright 驱动） | 随机（`--remote-debugging-port=0`） | 实际端口见 `DevToolsActivePort`，仅 `127.0.0.1` |

### 注意事项

- ❌ 永不绑 `0.0.0.0` — 会占用 Tailscale 接口 IP 导致冲突
- ✅ Tailscale Serve 自动处理外部访问 + TLS 证书
- ✅ TLS 证书如需额外配置，放 `~/.diy/`，不入项目

### 依赖管理

- `npm update --save` 保持所有依赖 latest
- 新增业务依赖（zod、js-yaml、chokidar 等）写入 `dependencies`
- 构建工具依赖（vite、typescript 等）写入 `devDependencies`（当前已 latest）
