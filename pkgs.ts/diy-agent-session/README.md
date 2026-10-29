# @diy/agent-session

diy **单会话内核**：消息列表 + 一次 LLM 调用 + 流式增量。

零 IO、零 task、零第三方 SDK —— 能力全部靠注入：

| 端口           | 作用                                                | 缺省   |
| -------------- | --------------------------------------------------- | ------ |
| `LlmPort`      | `chat(messages, opts): AsyncIterable<SessionDelta>` | 必填   |
| `Clock`        | `now(): number`（补 `at`）                          | 真时间 |
| `Compactor`    | 每轮调用前决定「这一轮看到的历史」                  | 不压缩 |
| `SessionStore` | `save(snapshot)` 落盘                               | 纯内存 |

```ts
import { createSession, type LlmPort } from '@diy/agent-session';

const llm: LlmPort = {
    async *chat(messages, { signal } = {}) {
        yield { type: 'text', text: '你好' };
        yield { type: 'usage', inputTokens: 12, outputTokens: 3 };
        yield { type: 'done', stopReason: 'stop' };
    },
};

const session = createSession({ id: 's1', llm });
for await (const delta of session.send('在吗')) {
    if (delta.type === 'text') process.stdout.write(delta.text);
}
session.messages; // [user, assistant]
session.usage; // { inputTokens: 12, outputTokens: 3, turns: 1 }
```

## 消息分类（5 种 kind，##456「数据分层修订」）

| kind               | 来源                     | 进 Room 主线？     |
| ------------------ | ------------------------ | ------------------ |
| `human`            | 人说的话                 | ✅                 |
| `agent-conclusion` | 一轮结束时的自然语言答复 | ✅                 |
| `agent-trace`      | 中间步骤 / 过渡语        | ❌（只在二级日志） |
| `tool-call`        | 工具调用                 | ❌                 |
| `tool-result`      | 工具结果                 | ❌                 |

判据：字节在遇到 `tool-call` 时先 flush 成 `agent-trace`（说明这一轮还没结束），
本轮最后剩下的一段字节才是 `agent-conclusion`。`kind` 不传时按 role 推导
（user→human / assistant→agent-conclusion / tool→tool-result）。

## 边界

- **属于本包**：消息列表、一次 LLM 调用与流式增量、单会话压缩（注入策略）、token 计量
- **不属于本包**：多成员投递与主线日志（`@diy/room`）、任务状态、文件系统、`diyHome()`

判据（意图测试 S7 静态扫 `src/**`）：文件系统模块 / `electron` / 应用数据根 / 任务标识 命中即红。

需求真源：[`tests/intent.session.test.ts`](./tests/intent.session.test.ts)（S1–S7）。
