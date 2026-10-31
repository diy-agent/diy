# apps/remote-shell —— A1 远程壳

本地 Electron 壳加载**远程** web UI（`apps/web`，##473）。窗口里只有两个互相独立的
`WebContentsView`：

```
┌──────────────────────────────────────────────┐
│ ● 本机 lab   ○ srv tailnet   ＋ 连接…   ⟳     │ ← 横条 32px（本地 data: 页，壳渲染）
├──────────────────────────────────────────────┤
│            远程页面（http://…）                │ ← y 从 32 开始
└──────────────────────────────────────────────┘
```

## 三条硬规则（##481 body）

1. **横条由 shell 渲染，不是远程页面的一部分。** 远程一坏，用户就不知道自己在哪台机器上。
   横条是独立的 webContents + 独立 preload，页面区的 y 从 `BAR_HEIGHT` 开始 ⇒
   远程页面画什么都到不了横条那一行（`bar.layout()` 给结构证据：几何不重叠 + 两个 webContents id）。
2. **横条只做「当前位置 + 切换」**，没有二次确认 / 危险操作拦截 —— 按本机操作一致原则
   （VSCode remote ssh 同理）。
3. **单窗口；连接保留。** 切走的页面只 `setVisible(false)`，不销毁、不 LRU 淘汰；切回来是原来的状态。

## 起

```bash
./sha.sh lab --app remote-shell --url http://127.0.0.1:8080   # 仓库根
apps/remote-shell/sha.sh lab --url http://127.0.0.1:8080      # 本目录
```

- `--url` 是初始要连的 endpoint（不写就停在占位页，等横条里选）。
- `--width` / `--height` 可调窗口尺寸；其余 argv（Electron / Chromium 自己的开关）一律忽略。
- `DIY_REMOTE_ENDPOINTS=http://a:9400,http://b:9400` 往横条列表里补手动候选（测试 / 临时用）。

## 发现器（##479）

横条列表来自 ##479 的发现器（local / mdns / tailscale / manual）。`discover.ts` 在**运行时**
动态 import `@diy-agent/remote/node` 的 `discoverAll`：

- 包在了就用它（联调时不用改本壳一行代码）；
- 包不在（当前 main 的现状）就退回 manual 这一路（`--url` / `DIY_REMOTE_ENDPOINTS`），横条照样能用。

`DiscoveredInstance` 的形状与 ##479 逐字段一致（`index.ts` 顶部注释标了真源位置）；合入后
把那份类型改成 `import type` 即可。

## 状态与探活

- 加载事件（`did-finish-load` / `did-fail-load` / `render-process-gone` / `unresponsive`）→ 立即改状态。
- 加一道心跳：每 3s 探一次当前实例的 `/ping`，**任何 HTTP 响应都算通**（404 也算：壳只关心
  机器通不通，不解析字段）；超时 / 网络错误 → 横条变红 + 显示原因。
- 断线后再点同一台 = 重新加载；连着的时候切回来**不重载**。

## 不做

- 不做二次确认 / 危险操作拦截（硬规则二）。
- 不做多窗口（`cmd+N` 留给将来）。
- 不做本地文件与远程文件的桥接；不做鉴权（同 ##479）。
- 不改远程页面（`apps/web` 一行不动）。
- **不落盘**：连接列表只活在内存里（用户口径「以内存开发为主，非必要不存储」）。

## 验证

```bash
apps/remote-shell/sha.sh verify
```

起两个假远程实例（一个带计数 / 输入状态、一个全屏红），真 Electron + CDP 过一遍判据：
能起 · 横条显示 displayName/状态 · 横条与页面几何不重叠且是两个 webContents ·
切换 + 切回来状态还在 · 停掉远程后横条变红并给原因 · 列表来自发现链。
