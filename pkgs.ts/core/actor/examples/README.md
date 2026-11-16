# examples — 真进程范例

`docs/09-example.md` 是这一页的正文；这里只放「怎么跑」和「文件在哪」。

```bash
./sha.sh demo        # 起 3 个进程跑九步剧本（约 1.5 秒，自己收拾干净）
```

```
examples/
  lib/net-link.ts      unix socket 链路（换行 JSON）—— 适配器，只搬字符串
  lib/store-jsonl.ts   落盘 store：一行一次提交（状态 + 游标 + 事件）
  lib/serve.ts         serveActor / connectActor / createSocketPort（对应 rpc 的 bind / use）
  demo/kinds.ts        两个 kind：demo.room（房间）+ demo.peer（成员会话）
  demo/peer-node.ts    一个成员节点（独立进程）
  demo/room-node.ts    房间节点（多一个扇出端口）
  demo/scenario.ts     剧本：九步、kill -9、重启、补历史
```

**这里的东西不是内核**：`src/` 的判据是零 IO、不 import `node:*`；适配器与 store 实现放这里，
将来接 ws / sqlite 就照着换一份，`src/` 一行都不用动。
