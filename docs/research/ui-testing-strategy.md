# UI 级意图测试：怎么做才快（研究 + 方案）

> 2026-11-10 · 任务 ##518 · 背景：以 CLI 子进程为基础的意图测试已停用 ——
> 一条断言一个 `./diy.sh` 进程（0.3–4 s），几百条就是几十分钟，**无法配合 agent 的高速迭代**。
> 本文回答：既要「UI 级意图」（用户看得见的行为），又要「秒级」（改一次跑一次），怎么做。

## 1. 先说结论

**把「UI 级意图」和「真窗口」解耦。** 意图测试的判据是「用户看到什么、点到什么、系统变成什么」，
这与「有没有一个真的 Electron 窗口」无关。当前架构（dev-ui 起）已经把 UI 做成**纯投影**
（store → 组件，动作走 client），于是可以在 happy-dom 里渲染真组件、喂真快照、点真按钮，
断言 DOM 与 core 状态 —— 每个用例 **10–50 ms**，且不需要 Electron / IPC / 进程。

真窗口只在最后一层保留个位数用例，验「壳能起来、CDP 能连、关键按钮点得动」。

## 2. 为什么旧的慢（根因，不是"测试写得差"）

| 成本项 | 旧做法 | 量级 |
|---|---|---|
| 入口 | 每条断言 `spawn ./diy.sh`（node 冷启动 + 参数解析 + rpc） | 0.3–4 s/条 |
| 环境 | 每个测试文件起一次 Electron（`electron-test.ts`） | 2–4 s/文件 |
| 断言通道 | DOM 查询要走 CDP 往返 | 10–60 ms/次 |
| 隔离 | 每文件独立 HOME + 真端口 | 启动开销放大 |
| 并行 | 曾经只能串行（抢 CPU/端口） | 全量 884 s |

结论：**慢在"每做一件事都要跨进程"**，不在用例本身。把跨进程次数从「每断言」降到「每文件 0 次」，
速度问题自然消失。

## 3. 目标分层（新）

| 层 | 跑什么 | 要 Electron 吗 | 单条耗时 | 何时跑 |
|---|---|---|---|---|
| **L0 纯逻辑** | store / slots / client / core 纯函数 | 否 | < 1 ms | 每次保存 |
| **L1 UI 意图**（**新增，主力**） | happy-dom 渲染 React 组件 + 真 core（进程内 mem rpc） | 否 | 10–50 ms | 每次改动 |
| **L2 契约** | api-def / rpc schema / 快照形状（跨进程边界的类型） | 否 | < 5 ms | 每次改动 |
| **L3 e2e** | 真 Electron + CDP 真鼠标（现有 `@diy-agent/ui-testing`） | 是 | 2–5 s | 发布前 / 改壳 |

L1 是这次要建的新东西；L0/L2/L3 已有或部分已有。

## 4. L1 怎么做到「UI 级」又「快」

三个前提，我们**已经具备**：

1. **UI 是纯投影**：`dev-ui` 的组件只读 store、只调 `client`。没有 DOM 之外的副作用。
2. **client 是接口**：`DevClient` 有 `createDevClient(bridge)`（真 IPC）。给它第二个实现
   `createMemoryClient(services)` —— 直连 core 函数或 mem transport，即可在测试里替代。
3. **快照是数据**：`DevSnapshot` 是纯 JSON，测试可以「意思性」地造场景（一条 launch 在跑 /
   两个 worktree / 一个外部实例），不用准备目录与进程。

于是 L1 用例长这样（真组件、真交互、毫秒级）：

```ts
const ui = await renderUi({
  snapshot: snap({ launches: [launch({ app: "chat", launch: "lab", running: false })] }),
  onStart: () => snap({ ...running: true }),   // 假 core：记录调用 + 返回新快照
});

await ui.click("启动");                        // 按可访问名找元素，找不到即失败
expect(ui.text()).toContain("运行中");          // 断言「用户看得到的东西」
expect(ui.calls).toEqual([{ method: "start", ref: { app: "chat", launch: "lab" } }]);
```

要点：

- **按钮用「名字」找**（`getByRole("button", { name: "启动" })`），不是 CSS 选择器、也不是
  `querySelector`。找不到就说明用户也找不到 —— 这顺带把可访问名变成了硬约束（a11y 免费得到）。
- **断言优先用「用户可见」的面**：文本、角色、`aria-pressed`、可见性；**尽量不**断言 class/样式。
- **动作一定是 client 调用**：`ui.calls` 能直接验「点了按钮是否发了对的 rpc」，而且不用真发。
- **不 mock 组件**：渲染的是线上同一个组件，测试里没有"简化版 UI"。

## 5. 需要建的三样东西

### 5.1 `@diy-agent/ui-testkit`（新包，约 300 行）

```ts
renderUi({ snapshot, handlers })  → { click, type, text, calls, rerender, unmount }
```

- 基于 happy-dom + `@testing-library/react`（或同类的 `@testing-library/dom` 瘦封装）；
- `handlers` = 「方法名 → (args) => 新快照」，默认抛错（**没实现的方法一调就红**，不静默）；
- `waitFor` 只等"下一次快照"，不做固定 sleep（固定 sleep 是慢测试的第二个来源）。

### 5.2 `createMemoryClient`（每个 app 的 UI 包各一份，≤50 行）

实现自己的 `Client` 接口，把方法映射到「测试给的 handlers」；生产用 `createDevClient(bridge)`。
两者签名完全一致 ⇒ 组件不知道自己在测试里。

### 5.3 把 diy-app 的 `memRpc` 提成公共件

`apps/diy-app/tests/harness/rpc.ts` 已经能在进程内起真 core（`ChannelServerBinding` +
`createMemTransportPair`）并直连。提到 `@diy-agent/rpc/testing` 或 `ui-testkit` 里，
L1 里要"跑真 core 而不是假快照"的场景（数据形状易错的那些）直接用它。

## 6. 一个完整例子：dev 的「启动 / 停止」

**旧写法**（停用了）：起 Electron → `./diy.sh start ...` 等 3 s → `ui inspect` 查 DOM → 断言。
**新写法（L1）**：

```ts
it("点启动 → 按钮变成「停止」，且发了 start", async () => {
  const ui = await renderUi({ snapshot: snapWithLaunch({ running: false }) });
  await ui.click("启动");
  expect(ui.calls).toEqual([{ method: "start", ref: expect.objectContaining({ launch: "lab" }) }]);
});

it("运行中 → 详情里能看到 PID / 端口（来自快照，不是硬编码）", async () => {
  const ui = await renderUi({ snapshot: snapWithLaunch({ running: true, pid: 4242, port: 18888 }) });
  await ui.click("chat.lab");     // 选中
  expect(ui.text()).toMatch(/4242/);
  expect(ui.text()).toMatch(/18888/);
});
```

**仍要留在 L3 的**（真窗口才有的东西）：窗口标题、全屏/聚焦、CDP 能连、
`window.workbench` 桥确实注入了、拖拽分栏的指针事件。

## 7. 迁移与验收

1. 建 `ui-testkit` + dev-ui 的 `tests/*.intent.test.tsx`（happy-dom 环境），先写 10 条覆盖
   启停 / 选中 / 页签切换 / 外部实例只读 / 文件树渲染。
2. **验收指标**：单文件 < 1 s、单条 < 50 ms、全套 L1 < 20 s；`npm test` 默认只跑 L0+L1+L2。
3. 老 CLI 意图测试：能改成 L1 的逐个搬，搬不了的在文件头写清楚"为什么必须真窗口"，进 L3。
4. L3 预算：**≤ 8 条**、只在发布前 / 改壳时跑。

## 8. 风险与边界

| 风险 | 应对 |
|---|---|
| happy-dom 与真 Electron 有差异（布局、滚动、`:hover`、真实命中测试） | 只把差异断言留给 L3；L1 断言「状态与结构」，不断言像素 |
| 假 client 与真 core 行为漂移 | 关键路径用 `memRpc` 跑**真 core**；同时 L2 契约测试盯 api schema |
| 快照造假导致"测试很绿但真机是错的" | 快照类型由 `dev-core/shared` 的生成类型约束；造场景的工厂集中在 `fixtures.ts`，改字段编译期就红 |
| 组件依赖全局单例（transport / bridge） | 已经收进 `fs.ts` / `client.ts`，测试里替换那一处即可（这也是当初分离的原因） |

## 9. 一句话总结

**意图测试的对象是「界面行为」而不是「真窗口」**。只要 UI 保持纯投影 + client 是接口，
UI 级意图就能在进程内以毫秒级跑起来；真窗口只留个位数用例兜底。这不是妥协，
而是把「慢在哪」修对了 —— 慢的是跨进程，不是 UI。

---

## 10. 采用口径：能真就真，只在两处让路（2026-11-10 用户定）

> 意图测试尽量走**端到端全套**：真 UI + 真 rpc + 真 core 服务；只有「难以频繁运行」或
> 「不可预测」的活动才用 mock / stub / 黄金数据。上一版的 L1「假快照 + 假 client」降级为**快测层**，
> 主力改为**进程内全栈（in-process full stack）**。

### 10.1 为什么本仓做得到（已核实）

| 组件 | 对 Electron 的依赖 | 结论 |
|---|---|---|
| `dev-core`（快照 / worktreeInstances / 外部实例） | **0**（只 import node 内置） | 可直接在测试进程里跑 |
| `dev-page`（页面方法表） | **0** | 同上（`runner` 的 `spawnFn` 可注入） |
| `dev-fs`（list/read/write + jail） | **0** | 同上 |
| `dev-ui`（React 组件） | 只依赖 `window.transport` / `window.workbench` | 注入内存 transport 即可 |

也就是说：**去掉 Electron 之后，业务链路一条不少**。差的只是三样东西的实现：
进程真的被 spawn、窗口真的存在、IPC 真的是 IPC。

### 10.2 真实度分级（这张表就是判据）

| 环节 | 意图测试里 | 理由 |
|---|---|---|
| React 组件 / 交互 | **真**（happy-dom 或 Chromium 挂真组件） | 被测对象本身 |
| rpc 传输 | **真**（`createMemTransportPair` + Channel 两端） | 序列化 / 校验 / 错误映射都是 bug 高发区 |
| core 服务（快照、fs jail、ref 读 diy.yaml） | **真**（临时目录 + 临时 git 仓） | 数据形状错最贵 |
| 存储（快照 store / 命令输出） | **内存型真 store**（`SnapshotStore`） | 快、可断言「通知了几次」 |
| **LLM 请求** | **黄金/回放**（fixture 逐帧重放） | 花钱 + 不确定 |
| **拉起 app 实例**（`spawn` Electron） | **stub**：写一条注册记录 + 写日志文件 + 返回 pid | 一个真实例 ≈ 2–4 s，且抢端口/抢锁 |
| 窗口 / 全屏 / CDP / 拖拽指针 | 不进意图测试（留给 e2e，≤8 条） | 只有真窗口才有 |

一句话：**「不花时间、不随机、可复现」的都真的跑；剩下的才让路。**

### 10.3 进程内全栈长什么样

```ts
// dev-ui/src/testing/harness.ts —— 一次装配，三处真实、两处让路
const fx = await createDevFixture();              // 临时 DIY_HOME + 临时 git 仓 + 注册表记录

const server = new ChannelServerBinding(fx.serverTx);   // ① 真 rpc（服务端）
bindFsHandlers(server);                                  // 真 dev-fs（jail 在临时目录里）
bindDevPage(server, {                                    // 真页面方法表，只换 spawnFn
  spawnFn: fx.fakeSpawn,                                 // ② 让路：不真起 Electron
});
const client = createDevClient(fx.pageBridge);           // 真 client（走同一套 transport）

renderUi(<App ctx={ctx} />);                             // ③ 真 React 组件
await ui.click("启动");                                   // 真点击
expect(fx.registry.records()).toHaveLength(1);            // 真注册表被写了
expect(ui.text()).toContain("运行中");                    // 真 UI 反映真快照
```

要点：

- **不用假 client**：`createDevClient` 照原样用，它面对的 transport 是内存管道；
  `client.ts` 里那层领域封装因此**被测到**（过去它是唯一没测的地方，也是 `Unknown method` 差点漏过的地方）。
- **不用假快照**：`snapshot()` 由真 `buildSnapshot()` 从真注册表 + 真 worktree 算出来；
  造场景的方式是**造盘上的事实**（写 `<pid>.json`、写 `diy.yaml`、建目录），不是拼对象。
- **fake spawn** 只做三件事：立刻给一个 pid、把 `diyHome/argv` 写进注册表、把启动日志写进日志文件。
  它让 `watchLog` 的 tail 逻辑也能被真测到。
- LLM：`fixtures/llm/gen/*.gen.ts` 走既有黄金录制品；断言「发了哪几个请求 + 界面怎么变」，
  不比对模型自由文本。

### 10.4 三层归属（修订）

| 层 | 真实度 | 何时跑 |
|---|---|---|
| **L1 意图（进程内全栈）** | 真 UI + 真 rpc + 真 core，spawn 与 LLM 让路 | **每次改动**（目标 < 300 ms/条、全量 < 30 s） |
| **L2 浏览器**（Vitest Browser Mode） | 同上，但真 Chromium | 改布局 / CSS / 拖拽时 |
| **L3 e2e** | 全真（真 Electron + CDP） | 发布前，≤8 条 |

> 上一版把「假 client + 假快照」当主力 —— 那是快，但测不到协议与数据形状；
> 现在把它降级为「组件级微测」（只验渲染分支），主力换成进程内全栈。

### 10.5 验收

- 单条 < 300 ms（含真 fs/真 rpc），单文件 < 2 s，全量 L1 < 30 s；
- 覆盖：启停（含 fake spawn + 注册表断言）、多实例、外部实例只读、文件读写（真临时文件）、
  ref 列表（真临时 git 仓）、交叉表折叠/过滤（真 localStorage 替身）；
- **禁止**：在 L1 里 `spawn` 真 Electron、读真实 `~/.diy`、发真 LLM 请求。
