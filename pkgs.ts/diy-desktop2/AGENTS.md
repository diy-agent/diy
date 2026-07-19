# diy-desktop2 开发规范

## 架构原则

### 构建

- **无 electron-vite**，直接使用 Vite 8 三独立配置（main / preload / renderer）
- `scripts/electron-dev.mts` 自有开发编排，不依赖 electron-vite 封装

### 开发参数

```
npm run dev                    # 生产模式（port 18888）
npm run dev -- --temp          # 临时模式（独立目录 + 随机端口）
npm run dev -- --temp --port 18888  # 指定端口（测试冲突）
```

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
- ✅ 默认 dark 模式：html 标签加 `class="dark"`（不改官方 `.dark` 块）

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
