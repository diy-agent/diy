# @diy/rpc-transport-electron — Electron IPC Transport

Electron 主进程 ↔ 渲染进程的 IPC 传输实现。

```
src/
├── electron/index.ts    ← createMainTransport / createRendererTransport
└── index.ts             ← barrel
```

## 浏览器安全

**本包不可在浏览器中使用**。依赖 `electron`（IPC 通信），仅在 Electron 主进程和 preload 中使用。

依赖 `@diy/rpc`（Transport 类型接口）+ `electron`（peerDependency）。
