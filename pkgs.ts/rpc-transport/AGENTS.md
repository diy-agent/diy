# @diy/rpc-transport — 传输实现聚合包

聚合 WebSocket、HTTP/2 等传输实现，未来 stdio 等也放在此包。

```
src/
├── websocket/index.ts   ← WebSocket Transport
├── http2/index.ts       ← HTTP/2 Transport（NDJSON over 长连接流）
└── index.ts             ← barrel
```

## 浏览器安全

**本包不可在浏览器中使用**。`ws` 需要 Node.js 原生模块，`http2/` 使用 `node:http2`。
仅在 Node.js 服务端或 Electron 主进程中使用。

依赖 `@diy/rpc`（Transport 类型接口）。
