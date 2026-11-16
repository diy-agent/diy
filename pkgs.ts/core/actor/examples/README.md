# examples — 三个档次的范例

从下往上读；每一档只加一件新东西，读完一档再开下一档。

| 档       | 跑                   | 文件                                   | 讲什么                                              | 正文                                  |
| -------- | -------------------- | -------------------------------------- | --------------------------------------------------- | ------------------------------------- |
| 入门一   | `./sha.sh hello`     | `hello-counter.ts` + `hello-inproc.ts` | 契约怎么写；方法怎么调（函数级得值）。**没有网络**  | [09-hello](../docs/09-hello.md)       |
| 入门二   | `./sha.sh hello-net` | `hello-net.ts`                         | 同样几行调用，对面换成另一个**进程**（unix socket） | [09-hello](../docs/09-hello.md)       |
| 完整剧本 | `./sha.sh demo`      | `demo/*` + `lib/*`                     | 3 进程 + 扇出 + `kill -9` + 崩溃重启 + 事件补历史   | [10-scenario](../docs/10-scenario.md) |

```
examples/
  hello-counter.ts     入门用的那一个 kind（两个入门范例共用）
  hello-inproc.ts      入门一：单进程，约 40 行（useKind 函数层 + 一行 raw 对照）
  hello-net.ts         入门二：两个进程，约 55 行（自己 spawn 自己当服务端）

  lib/net-link.ts      unix socket 链路（换行 JSON）—— 适配器，只搬字符串
  lib/store-jsonl.ts   落盘 store：一行一次提交（状态 + 游标 + 事件）
  lib/serve.ts         serveActor / connectActor / createSocketPort（对应 rpc 的 bind / use）
  demo/kinds.ts        两个 kind：demo.room（房间）+ demo.peer（成员会话）
  demo/peer-node.ts    一个成员节点（独立进程）
  demo/room-node.ts    房间节点（多一个扇出端口）
  demo/scenario.ts     剧本：九步、kill -9、重启、补历史
```

> 两个入门范例用的 `useKind`（函数层）**不在 examples 里**，它是内核的一部分：`src/api.ts`。
> 分层：契约 `defineKind` → 服务端 `serveActor` → 调用方 `useKind`（或 raw 的 `client`）。

**这里的东西不是内核**：`src/` 的判据是零 IO、不 import `node:*`；适配器与 store 实现放这里，
将来接 ws / sqlite 就照着换一份，`src/` 一行都不用动。
