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

### Renderer 双框架（React → Solid 迁移中）

电控台 renderer 正在从 React 迁移到 Solid：
- **`renderer_solid/`（主线，构建默认）** — SolidJS 渲染层，改 UI 必改这里
- **`renderer/`（React 遗留，仅参考）** — 老 UI；构建已切 `vite.renderer.config.ts`（root=`renderer_solid` + vite-plugin-solid），React 版另存 `vite.renderer.react.config.ts`

### 组件分层（Solid 主线）

```
renderer_solid/
  ├── components/          ← 业务组件（daisyUI 高阶组件组合）
  ├── store/               ← Solid signal 单例（「值 getter」暴露，别暴露裸 getter 函数）
  ├── lib/                 ← rpc client / renderer-api-impl(diy.ui.* handler) / 共享入口
  ├── main.tsx             ← render() + bind diy.ui.* handler
  └── index.css/html
```

- ✅ 业务组件用 daisyUI 高阶组件组合（drawer/navbar/card/modal/chat/tabs），JSX 少裸 Tailwind（接近 Flutter 只管结构）
- ✅ store 「值 getter」单例：`get nodes(){return nodes()}` —— 否则组件 `for...of` 遍历 getter 函数 → 页面空白
- ✅ 任务树拖拽用 `@dnd-kit/solid`（dnd-kit 官方 Solid 包），`sensors={[PointerSensor]}` 禁键盘拖拽
- ❌ 不开发通用 UI 组件

renderer_solid/ 全部文件首行 `// @ts-nocheck`，根 `tsconfig.json` exclude `renderer_solid`（类型检查待还债）。

### 样式策略

- ✅ daisyUI 主题类管组件外观（card/modal/drawer/menu/chat）
- ✅ 布局/间距仍用 Tailwind（`flex-1`/`w-56`/`absolute` 等）
- ✅ 自定义色用 `diy-` 前缀，在 `@theme inline` 块末尾追加（例 `--color-diy-state-pending` → `bg-diy-state-pending`）
- 注意 daisyUI drawer 需渲染 `<input class="drawer-toggle">`，漏了侧栏 `visibility:hidden` 消失

### UI 验证（两层，互补）

- **`diy.ui.*`（handler 层）**：CLI 经 RPC 直接调 renderer 的共享入口函数（与按钮 onClick 同一批）。测行为/契约/状态，稳定适合 test:intent 基线；**测不到真实 DOM 事件链的 bug**。
- **Playwright/CDP（真实事件层）**：Electron 开 `--remote-debugging-port`，Playwright `connect_over_cdp` 复用，用**真实鼠标事件**（mouse.move/down/up 分步）驱动真实 renderer。能抓 gesture bug（拖拽整屏被拖出、isDropTarget 高亮、点穿透、折叠状态），是目前唯一的验证手段——UI 交互改动后跑一遍。
- `diy.ui.inspect`：renderer 内 DOM 遍历生成无障碍树，agent 可 `./diy.sh ui inspect` 看 UI 全貌。

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

### 注意事项

- ❌ 永不绑 `0.0.0.0` — 会占用 Tailscale 接口 IP 导致冲突
- ✅ Tailscale Serve 自动处理外部访问 + TLS 证书
- ✅ TLS 证书如需额外配置，放 `~/.diy/`，不入项目

### 依赖管理

- `npm update --save` 保持所有依赖 latest
- 新增业务依赖（zod、js-yaml、chokidar 等）写入 `dependencies`
- 构建工具依赖（vite、typescript 等）写入 `devDependencies`（当前已 latest）
