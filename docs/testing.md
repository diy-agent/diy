# 测试分级与命名规范

> 两条先行结论：
> 1. **测试是二维的** —— 「层级」（谁的需求）× 「手法」（怎么冻结不确定性）。DOM 测试是单元层 + happy-dom 环境，黄金测试是手法，都不是独立层级。
> 2. **不测真模型**。有 LLM 参与的功能一律**回放录制的事件流**（golden fixture）。

判据始终是：**这条测试失败时，我关心的是什么？** 关心「用户能不能……」→ 意图；关心「点得到吗/看得见吗」→ E2E；
关心「某段算法对不对」→ 单元；关心「这个坑还会不会再犯」→ 探针。

---

## 层级（从外向内，越靠前越该优先写）

| 层 | 后缀 | 测什么 | 谁看 | 默认跑 |
|---|---|---|---|---|
| **意图·界面** | `*.intent.test.ts` | 用户操作界面的意图（打开面板、改一个人、界面对不对） | 用户/产品，**当说明书读** | ✅ |
| **意图·core（无 UI）** | `*.intent.test.ts` | 不走界面也要成立的需求（CLI、脚本、第三方接入） | 集成方 | ✅ |
| **契约** | `*.intent.test.ts` 契约段 / fixture `gen/` | 形状与协议（RPC schema、CLI 输出、模型事件流） | 接这套接口的人 | ✅ |
| **E2E** | `*.e2e.test.ts` | 显示对不对（拖动、遮挡、大小、位置、hover） | QA | ❌ 需构建 |
| **单元** | `*.test.ts` / `*.dom.test.ts` | 复杂算法、边界计算、纯函数、组件自身契约 | 实现者 | ✅ |
| **探针** | `*.probe.test.ts` | 真实故障先浮现（复现即结论） | dev/review | ✅（慢的按需） |

层级轴线是「**谁的需求、谁来读**」，不是「跑得多快」。契约与 ui/core 意图并列：同样在表达需求，只是偏技术。

---

## 意图测试 = 可执行的需求文档（写法硬约束）

这一层**首先写给人看**，其次才是给机器跑 —— 它替代需求文档，用户会拿它当说明书。

1. `describe` 写一组需求，`it` 写一条需求；用业务词（人物、任务、缺省、绑定），**不出现**表名、字段名、store 名、mock、传输方式。
2. **重构不变**：换存储 / 换传输 / 换进程模型，断言原样通过。要改断言逻辑 ⇒ 它其实被写成了单元测试。
3. **需求改了只改文案**；改不动说明这里在描述实现。
4. **必须跑得快**（单文件秒级）。跑不动 ⇒ 没人跑 ⇒ 说明书腐坏；**过期文档比没有更坏**。
5. **探针的结论要回填**成一条意图/单元用例，否则它退化成一次性脚本。

---

## 执行方式（手法决定速度，不改语义）

| 方式 | 每条断言成本 | 用在哪 |
|---|---|---|
| 进程内 rpc（`createMemTransportPair` + `bindAppHandlers`） | 微秒级 | 默认。同进程直连生产实现 |
| 长连 HTTP/2 rpc（`HttpClientBinding`） | ~1ms | 需要真 app 进程（`diy.ui.*` 要 renderer 在场） |
| `./diy.sh` 子进程 | **0.68s**（冷启 2.7s） | 仅当被测对象**就是** CLI 进程（启动、退出码、stdio） |
| CDP `Input.dispatchMouseEvent` | 分钟级/文件 | 只留给 e2e（像素与命中测试） |

同一批 34 条 persona 用例：CLI 子进程 137.7s → 进程内 rpc <1s。**慢的不是「意图测试」，是「每条断言起一个进程」。**
按此表，旧的 `apps/diy-app/tests/cli.intent.*` 应逐步退役（当前 `./sha.sh test` 已不跑它们）。

---

## 一条判据：UI 没有的用例，API 不该暴露

```
core 包公开的 API = 给 UI 调用的 RPC 接口
```

反例：`Bot.newSession()` —— 产品上 bot 只有一条永久会话，UI 从没有「新建会话」，但接口导出了还配了测试。
「为装配方便而暴露」的 API 应该用**包级容器**（如 `<Pkg>Module`）消化掉。

---

## 黄金 fixture（LLM 回放）

- 录制走 **provider 层**（`model.doStream()` 的原始 part），不是 `streamText().fullStream`（两套 chunk 类型，录错回放会抛 `Unhandled chunk type`）。
- fixture 是**源码**，生成物一律 `fixtures/llm/gen/*.gen.ts`；`gen/` 进版本库，但别手改。
- **录制只含模型输出，不含工具执行结果** —— 测「工具失败」时 fixture 给调用，测试自己让工具抛错。
- **错误场景必须来自真实数据**：先在全量日志里找出它真发生过（并写明次数），找不到就不录。编造场景比没有更坏。
- 录制/查看：`node --experimental-strip-types tools/record-llm.mts list|record <名>|--dry`。

---

## 探针（`*.probe.test.ts`）

golden = 这个功能**应该**这样工作；probe = 这个功能**曾经**这样坏过。

- 四段头注释缺一不予合入：① 现象+证据 ② 根因 ③ 修复 commit ④ 现在守什么。
- **先红后绿**：必须能证明「不修就坏」，否则测试可能在逻辑被删后仍然绿。
- 归档 ≠ 删除：一次性故障三个月后移出默认 run（`tests/probe/archive/`），代码留着，同类故障能复用。

---

## 目录与命名

```
pkgs.ts/<域>/<包>/tests/
├── <主题>.test.ts              单元
├── <主题>.dom.test.ts          单元 + happy-dom（首行 // @vitest-environment happy-dom）
├── <主题>.intent.test.ts       意图（core 层 / 契约）
├── <主题>.probe.test.ts        探针
└── fixtures/llm/gen/*.gen.ts   黄金录制品
apps/<app>/tests/
├── <主题>.test.ts              单元 / 装配守卫
├── core-intent/<主题>.intent.test.ts   意图 · core（不开窗口）
├── ui-intent/<主题>.intent.test.ts     意图 · 界面（真 Electron）
└── e2e/<主题>.e2e.test.ts              E2E（像素 / 命中）
```

**三个入口分开，别互相拖累**（app 内的测试）：

| 命令 | 跑什么 | 什么时候跑 |
|---|---|---|
| `./sha.sh test` | 单元 + OS 策略 + **core 意图**（不开窗口） | 改任何东西后，秒级 |
| `./sha.sh test-ui` | **界面意图**（起真 Electron，走 `diy.ui.*`） | 改到 renderer / `diy.ui.*`；发布前全跑 |
| `./sha.sh test-e2e` | **E2E**（真鼠标，像素/命中/浮层） | 发布前；改布局/浮层时 |

**默认不要 `all test`**：`./sha.sh test` 必须保持秒级到十几秒，否则没人跑。
**单文件调试优先**：`npx vitest run tests/ui-intent/<文件> -t "<用例名片段>"`，只跑当前在改的场景。

## 跑法

```bash
./sha.sh test                        # 单元 + 意图（不含 e2e、不含旧 cli.intent）
cd apps/diy-app && ./sha.sh test-e2e # E2E（需 DIY_VARIANT=test ./sha.sh build）
```

## 别做的事

- 别拿 E2E 当覆盖率锚（它只验像素与命中）。
- 别为细节狂写单元测试 —— 它钉死实现，反而妨碍演进；能上移到意图层的就上移。
- 别写重复的：同一件事只在**最能暴露问题的那一层**写一次，且**优先往上写**。
