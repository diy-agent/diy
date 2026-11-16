# 05 · 多目标：逐项结果，没有 `partial`

> 对应源码：`src/fanout.ts`、`src/kinds.ts` 的 `fanoutQuery`、`src/runtime.ts` 的扇出分支
> 测试：`tests/intent.fanout.test.ts`

## 一、一句话

> **多目标扇出返回 `ok` + 逐项状态；「哪个 target 没答」是执行回执，进 `meta.fanout`。
> 协议里没有 `partial`，也永远不会有。**

## 二、为什么

查 10 台机器：8 台 running、1 台 stopped、1 台 agent 没应答。这是**业务答案**，不是查询失败。

| 轴 | 载体 | 本例 |
|---|---|---|
| 执行轴 | 帧 `type` | `ok`（查询跑完了） |
| 业务轴 | `data.items[i].state` | `running` / `stopped` / `unknown` |

唯一算执行失败的情形是**一条答案都没拿到**（10 台全问不到 / 没有权限 / 参数写错）→ `err`。

`partial` 这个 tag 的危害（也写在 [07](./07-naming-ledger.md) C4）：

1. 客户端要写两遍同一份渲染（`ok` 一份、`partial` 一份），且极易不同步；
2. 重试语义变糊：`partial` 该重试全部还是失败的？`ok` + 逐项状态时，重试就是**再问一次**；
3. 它会**蔓延**：任何「部分成功」都往协议挤，最后协议变成业务状态机；
4. 它强迫 runtime 去判「什么叫一项」「什么算失败」——**runtime 不知道**，知道的是 kind。

## 三、摆放知识只属于 actor

```ts
.fanoutQuery('roster', {
    subquery: 'live',                                        // 在 target 上跑什么
    targets: (ctx) => ctx.state.members.map((m) => ({        // 问谁（从 state 算）
        target: m.backend.taskUri,
        memberId: m.id,
    })),
    aggregate: ({ ctx, results }) => ({ /* … */ }),
})
```

帧里**没有** `targets`（也没有 `routing`）。理由三条：

- 客户端若自己填 `targets`，等于把 placement 复制到 UI/CLI，**必然过期**（成员重绑 task、节点迁移后不会通知每个客户端）；
- 「扇出后部分目标不可达怎么办」恰恰是 actor 该替调用方兜住的，不是调用方的负担；
- 一份 placement 只有一个写者（actor 的 state），才有机会保持一致。

## 四、`meta.fanout`：执行回执

```jsonc
{
  "type": "ok", "id": "req_7", "watermark": "e91w",
  "data": { "members": [
      { "memberId": "m1", "state": "running", "label": "rg -n …" },
      { "memberId": "m3", "state": "unknown", "reason": "NODE_DOWN" }
  ]},
  "meta": { "fanout": [
      { "target": "diy://node-a/m1", "ok": true,  "ms": 12 },
      { "target": "diy://node-b/m3", "ok": false, "code": "E_NOT_FOUND", "ms": 3000 }
  ]}
}
```

| 谁读 | 读什么 | 为什么 |
|---|---|---|
| runtime | 写 `meta.fanout` | 重试、超时、熔断要靠它 |
| kind 的 `aggregate` | 读 `results`（含 `answered: false`） | 把「没答」映射成业务状态（`unknown` + `reason`） |
| 调用方 | **只读 `data`** | UI 读 `meta.fanout` = 把 placement 又拖回渲染层（判据：`rg "meta\.fanout" pkgs.ts/ui` = 0） |

## 五、业界同口径

| 系统 | 部分目标失败怎么表达 | 顶层状态 |
|---|---|---|
| AWS S3 `DeleteObjects` | body 里 `Deleted` + `Errors`（逐 key） | HTTP **200** |
| DynamoDB `BatchWriteItem` | `UnprocessedItems` | HTTP **200** |
| Elasticsearch `_bulk` | 逐项 `status`，顶层 `errors: true` | HTTP **200** |
| Google AIP-231（batch Get） | 逐项 response / 逐项 error | RPC status 只说这次调用 |
| GraphQL | `data` 与 `errors` 并存 | 但 `errors` **只**表示执行期解析失败；「找不到」是 `data: null` |
| Kubernetes `GET /nodes` | 节点 `Ready=False` 是 `conditions` | **200** |
| gRPC / AIP-193 | status code 只描述调用，资源状态属资源 | — |

反例只有两个，且都是公认的失败设计：

- **WebDAV `207 Multi-Status`** —— 唯一把「部分成功」抬到协议状态层的知名规范，客户端普遍当 200 处理；
- HTTP `206 Partial Content` —— 名字像，但它说的是**一份资源的字节区间**，不是「多项里成了几项」。

## 六、三条硬规则

1. **全败 = `err E_UNAVAILABLE`**（一条答案都没拿到）。有测试守着。
2. **空目标集 = 合法空答案**（`ok`，`aggregate` 收到空数组）。「确实没有成员」与「问不到成员」是两件事。
3. **同一个 target 只问一次**（state 里可能有重复地址；runtime 去重，回执也去重）。

## 七、`mapEach`：让「读不到就当没有」写不出来

```ts
const rows = mapEach(
    results,
    (value, target) => `${target.memberId}:${value.running ? 'running' : 'idle'}`,
    (code, _message, target) => `${target.memberId}:unknown(${code})`,   // ← 必须给
);
// 返回数组与 results 等长同序
```

两个回调都是必填参数，所以：

- 只想处理「拿到的」→ 编译不过；
- 想用 `results.filter(r => r.answered)` 悄悄丢掉没答的 → 丢掉之后长度对不上，
  而 `roster` 这类 UI 是**按成员列表渲染**的，少一项就是「这个成员凭空消失」。

这是 [07](./07-naming-ledger.md) A2 那个 bug（`entry: null` 兼职「没有」和「读不到」）的长效防护：
不是靠 review 记得，是靠签名写不出来。

## 八、接一个端口

runtime 只认这个接口，不认识任何传输：

```ts
interface FanoutPort {
    query(args: { target: string; name: string; data: unknown; timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>;
}
```

- 进程内：`createLocalPort((target) => clientByTarget.get(target))`（`src/local.ts`）；
- 跨节点：适配器按 target 找链路，转发一个 `query` 帧，把 `ok.data` 还回来、把 `err.code` 抛出；
- 找不到 target → 抛 `E_NOT_FOUND`（`runFanout` 会折成一条 `answered: false`）。

**端口只读不写**：扇出只发 `query`。跨节点写 = 两次命令 + 补偿策略，属于业务（[01](./01-model.md) §六）。

## 九、判据

1. `rg "partial" pkgs.ts/core/actor/src` 只命中「已否决」的注释；`FrameSchema` 枚举里没有它。
2. 每个 `output` schema 里，「读不到」有独立取值（不用 `null` / `undefined` 兼职）。
3. `aggregate` 里要么用 `mapEach`，要么显式写两个分支（`rg "answered"` 覆盖到）。
4. UI 不读 `meta.fanout`。
5. 全败用例、空目标用例各有一条测试（有）。
