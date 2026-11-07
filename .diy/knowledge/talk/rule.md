---
desc: diy-talk 硬约束：零依赖零取时间 / 只做纯数据 / 非法输入必抛 / 判别联合落地
updated: 2026-10-23
---

## data-only

只做数据与纯函数：**不做存储**（不碰 fs）；装配是纯函数 `assemble`（不碰具体 LLM SDK、不拼 prompt 的具体形状）

（见 c8e0eae4:pkgs.ts/diy-talk/AGENTS.md:20）

## discriminated-union-landed

全局规则 `rule.discriminated-union`（`~/AGENTS.md`）的**首批落地**：`Anchor` / `Event` 都是 `{ type, 公共字段, data }`，分支私有数据只进 `data`、与判别键同级不放私有字段。改这两个类型前先读全局那条，别在此处另立判据

（见 c8e0eae4:pkgs.ts/diy-talk/AGENTS.md:22）

## loud

非法 anchor / 悬空 `replyTo` / 异锚点混串 / role 违规 / **未知字段** 一律抛 `TalkError`（带 `code` + 点路径），**绝不静默丢弃** —— 静默的后果是「装配出来的历史少一条反驳」

（见 c8e0eae4:pkgs.ts/diy-talk/AGENTS.md:21）

## no-time

包内**不许取时间**：`at` 由调用方传入（可重放、可测试）；判据同 R7 的正则（`Date.now` / `new Date(`）

（见 c8e0eae4:pkgs.ts/diy-talk/AGENTS.md:19）

## zero-dep

**零依赖纯内核**：不 import `node:fs` / `electron` / `@diy-agent/app`，不取时间 ⇒ 现在即可拆成单独项目。新增 import 前先问「这还能单独拆出去吗」—— 意图测试 R7 静态拦：`src/**` 匹配到 `import … from "node:|electron|@diy-agent/app"` 或 `Date.now` / `new Date(` 即红，且断言 `package.json` 零 dependencies

（见 c8e0eae4:pkgs.ts/diy-talk/tests/intent.talk.test.ts:483）
