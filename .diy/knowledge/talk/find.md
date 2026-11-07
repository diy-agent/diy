---
desc: diy-talk 包内定位：锚点 / 事件 / 反应 / role / 序列化 / 装配器（@diy-agent/talk 对话容器内核）
updated: 2026-10-23
---

## anchor

`src/anchor.ts`：`Anchor = message | doc-range | task-field | node`；`pinsRevision` 三态（`true|false|null`，null = 不在修订轴）；构造器一律自检

（见 c8e0eae4:pkgs.ts/diy-talk/AGENTS.md:8）

## assemble

`src/assemble.ts`：`assemble({ sources, strategy, window, selfId }) → Message[]`；源 `reactions|trace|material`，三内置策略 `full|text-only|changes-only`（##166 结论 4）；**他人过程（tool/thinking）永不进入（`full` 也不，由 `role.ts` 最终把关）**；`window` 是宿主注入的**可信**裁剪钩子 —— 其输出不再复核铁律（内核不自作主张）

（见 c8e0eae4:pkgs.ts/diy-talk/AGENTS.md:13）

## consumers

`@diy-agent/flow`（##313 泳道容器）已依赖；装配器 `assemble` 供 ##319（宿主接入与提示词装配）消费

（见 c8e0eae4:pkgs.ts/diy-talk/AGENTS.md:14）

## event

`src/event.ts`：`Event { id, author, anchor, content, causes, at }`（##166 §10.2 的容器无关泛化）

（见 c8e0eae4:pkgs.ts/diy-talk/AGENTS.md:9）

## reaction

`src/reaction.ts`：`Reaction { …, turnId, target, replyTo, … }` + `assertThreadRefs`（悬空 / 自指 / 重号 / 异锚点）

（见 c8e0eae4:pkgs.ts/diy-talk/AGENTS.md:10）

## role

`src/role.ts`：`assemblyRole` + `assertRoleAssignments`（铁律：他人发言绝不能装配成 `assistant`）；非法 `kind` 报错

（见 c8e0eae4:pkgs.ts/diy-talk/AGENTS.md:11）

## serialize

`src/serialize.ts`：JSON 出入口（写读两侧都校验；`{compact}` 单行供 jsonl，`{allowUnknown}` 读侧前向兼容）

（见 c8e0eae4:pkgs.ts/diy-talk/AGENTS.md:12）

## spec

`SPEC.md` **决策记录**（为什么锚点统一成 `{type,data}`、为什么 doc-range 必钉 revision、为什么 replyTo 是 id 而非文字、为什么 role 不留例外开关）；需求真源是意图测试（`tests/intent.talk.test.ts` R1–R7 / `tests/intent.assemble.test.ts` A1–A6）

（见 c8e0eae4:pkgs.ts/diy-talk/AGENTS.md:7）
