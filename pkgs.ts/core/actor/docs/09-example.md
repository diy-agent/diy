# 09 · 范例：三个进程跑一遍

> 对应源码：`examples/`（`lib/serve.ts` / `lib/net-link.ts` / `lib/store-jsonl.ts` / `demo/*`）
> 运行：`./sha.sh demo`（约 1.5 秒，起 3 个子进程后自己收拾干净）

## 一、它回答什么问题

`tests/` 里的用例全是**同进程**的：链路是两个 `Set` 互投，重启是假的，掉线是造出来的。
这一页的范例换掉这三件事：

| 同进程用例证明不了 | 范例怎么证 |
|---|---|
| 帧过一趟真实序列化还对不对 | 帧走 unix socket 的换行 JSON |
| 掉线时业务怎么看 | `kill -9` 一个成员节点，名册里那一项变 `unknown` 并带 code |
| 崩溃后状态还在不在 | `kill -9` 房间节点，同一数据目录重启，`read` 仍是同一条消息 |

一句话：**内核在 `src/`，证据在 `examples/`**。

## 二、和 rpc 的对照（为什么"像 rpc 那样的示范"）

| rpc（`@diy-agent/rpc`） | actor（本包） |
|---|---|
| `defineService({ name, api })` 定契约 | `defineKind({ name, state, initial, events })` 定契约 |
| 服务端 `service.bind(server, handlers)` | 服务端 `serveActor({ kind, uri, socket, dataDir })` |
| 客户端 `service.use(client)` | 客户端 `connectActor({ kind, socket })` |
| 契约 = **方法**的集合 | 契约 = 方法 + **状态** + **事件** |
| 断线重连、鉴权、多路复用都在框架里 | 那些都在「链路」里，actor 只要一个 `Link` |

差别只有一处值得记住：rpc 的契约是"有哪些方法"；actor 的契约还包括**状态长什么样**和
**会产生哪些事件**——所以服务端不用再把每个 handler 绑一遍（kind 里已经写完了）。

## 三、拓扑

```
        scenario.ts（剧本，自己不是节点）
        │  spawn ×3 + 客户端
        ├──────────────► room 节点        diy://demo/room
        │                 │  port: 按 target 拨号
        │                 ├──────────────► peer-a 节点   diy://demo/peer-a
        │                 └──────────────► peer-b 节点   diy://demo/peer-b
        └── 直接连 peer-a（用同一个 kind 的另一个客户端）

每个节点：一个 actor + 一个 unix socket + 一个数据目录（commits.jsonl）
名字只出现在日志与扇出回执里 —— 真正的寻址是 socket 路径，而**哪条路径**只有 room 的 state 知道
```

房间节点**不认识**成员节点：`roster` 该问谁，是从 `state.members[].target` 算出来的，
端口只负责"按地址拨号"（[05](./05-multi-target.md)：摆放知识只属于 actor）。

## 四、九步（`./sha.sh demo` 的输出）

| 步 | 做什么 | 证明了哪条口径 |
|---|---|---|
| ① | 起 3 个进程 | 一个实例 = 一个 actor；节点之间只靠链路 |
| ② | `join` ×2 + `post` | `done` 回执带 `seq`（这个命令的事件末尾） |
| ③ | `read` | `ok` + `watermark`：这份答案物化到哪 |
| ④ | **同一个 `commandId` 再 `post`** | 幂等：消息数不动，`seq` 也不动（[04](./04-runtime.md)） |
| ⑤ | `roster` | 一次查询扇出到两个**进程**；`running` / `idle` 是两种"答了" |
| ⑥ | `kill -9` peer-b 后 `roster` | 三态里的第三种：`unknown` + `reason: E_UNAVAILABLE`；整体仍是 `ok`（[05](./05-multi-target.md)） |
| ⑦ | `kill -9` 房间，同目录重启 | 状态从提交日志恢复（`commits.jsonl` 一行一次提交） |
| ⑧ | 重启后重发同一个 `commandId` | **已知空洞**：幂等表在内存里，重启就丢 ⇒ 写了第二条（[08](./08-roadmap.md) 刀7） |
| ⑨ | `watch({ include: ['posted'] })` | 重启前后的事件在同一个 `seq` 空间里补得出来 |

⑧ 是**故意留着**的：让"还没做的"在范例里显形，比写在路线图里更不容易忘。

## 五、三层各看哪个文件

```ts
// ① 契约（唯一真源）：examples/demo/kinds.ts
export const roomKind = defineKind({ name: 'demo.room', state: RoomState, initial, events })
    .command('post', …, (ctx, input) => ({ output, state, events }))
    .fanoutQuery('roster', { subquery: 'live', targets: (ctx) => …, aggregate: ({ results }) => … })
    .build();

// ② 服务端：examples/demo/room-node.ts
const served = await serveActor({ kind: roomKind, uri, socket, dataDir, port: createSocketPort() });

// ③ 调用方：examples/demo/scenario.ts
const client = await connectActor({ kind: roomKind, socket });
const done = await client.cmd('post', { text: '大家好' }, { commandId });   // 重试就复用这个 id
```

`examples/lib/net-link.ts` 是**适配器**：它只会 `encodeFrame` / `decodeFrame` + 换行，不认识业务。
接 ws / stdio / electron 就是把这 130 行换个底层 API —— 而 `src/` 一行都不用改
（`rg "from 'node:" src/` = 0 是硬判据，[06](./06-transport.md) §九）。

## 六、落盘 store：为什么是「一行一次提交」

`examples/lib/store-jsonl.ts` 把「状态 + 游标 + 这次提交产生的事件」写成**同一行**：

```
{"cursor":"e3","state":{"messages":[…],"members":[…]}, "entries":[{seq:"e2",…},{seq:"e3",…}]}
```

理由只有一个：`append` 与 `save` 之间崩一次就会出现「事件说发生过、查询说没发生」。
一行一次提交后，崩的形态只有一种——**写了一半的行**，读的时候把它截掉就行（状态回到上一次提交）。

两个坑都在 `tests/examples.store.test.ts` 里锁着：

1. **尾部半行必须截断**。不截的话，下一次 `append` 会接在半行后面，把「半行 + 新提交」拼成一行
   非法 JSON——一条坏尾巴吃掉之后**所有**提交（这条测试真的红过）；
2. `append` 不 `save` 就等于没发生（缓冲里的东西对读者不可见）。

## 七、这个范例抓到的两个真 bug

写完并跑通之前，`src/` 里有两处只有真链路才暴露的问题：

**① 空 `data` 的帧过不了 JSON。** `output: z.void()` 的命令回 `done` 时 `data` 是 `undefined`，
`JSON.stringify` 把这个键删掉，对面 `decodeFrame` 判「帧结构不符」→ 整帧被链路层丢掉 →
调用方干等 30 秒超时。进程内链路对象直投、不过编解码，所以 23 条用例全绿也发现不了。

修法（[02](./02-wire.md) §八）：`encodeFrame` 只对 `data` 这一位做归一化（`undefined` → `null`），
可选的元字段继续「没有这个键」；runtime 解析入参前把 `null` 换回 `undefined`。
锁在 `tests/intent.wire.test.ts`（把归一化删掉立刻红）。

**② 坏尾巴会吃掉后来的提交**（见上一节第 1 条）。

## 八、留给你（或下一刀）的作业

| 没做 | 现在什么样 | 什么时候必须做 |
|---|---|---|
| 连接池 | 每次扇出拨一条新连接，用完就关 | 成员多 / 扇出频繁（现在 3 个成员，无所谓） |
| 断线重连 | 链路断了就断了（CLI 重连，长连的 UI 得自己重连） | 接 UI 的常驻连接时 |
| 跨重启幂等 | 幂等表在内存（⑧ 那个空洞） | 想让「重试」跨进程可靠之前（[08](./08-roadmap.md) 刀7） |
| 日志裁剪 / 快照 | `commits.jsonl` 一直长（每行都带一份完整状态） | 状态变大之后（现在整份 state 才几百字节） |
| 真 ws / http 适配器 | 只有 unix socket 这一份 | 跨机器（[08](./08-roadmap.md) 刀4） |

## 九、判据

```bash
./sha.sh demo                      # 九步全 ✔（剧本自己 check，失败退出码非 0）
npx vitest run tests/examples.scenario.test.ts   # CI 记住这九条
rg "from 'node:" pkgs.ts/core/actor/src           # = 0（内核不碰 IO）
rg "room|member" pkgs.ts/core/actor/src/transport.ts   # = 0（适配器没有业务词汇）
```
