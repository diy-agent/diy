# @diy-agent/talk — 对话容器内核（事件 / 锚点 / 反应 + role 铁律 + 装配器）

> 全仓契约见**仓库根 `AGENTS.md`**。本包是**零依赖纯内核**：不 import `node:fs` / `electron` / `@diy-agent/app`，
> **不取时间**（`at` 由调用方传入）⇒ 现在即可拆成单独项目。这条不是口号：意图测试 R7 静态扫 `src/**`。
> 需求真源是 `tests/intent.talk.test.ts`（R1–R7）与 `tests/intent.assemble.test.ts`（A1–A6）。

## 正文在知识库，本节只留目录

原先写在下面的 13 条正文已整体迁进**项目知识库**（真源 `knowledge/facts/`，逐条带
`evidence.at: c8e0eae4:pkgs.ts/diy-talk/AGENTS.md:<行>` —— rev 钉住版本，本文件瘦身后行号仍可核）。
本文件 2.9 KB → 1.6 KB。

| 主题 | 是什么 | 条数 |
|---|---|---|
| `talk.find` | 包内定位：SPEC 决策记录 / anchor / event / reaction / role / serialize / assemble / 消费者 | 8 |
| `talk.rule` | 硬约束：零依赖零取时间（R7 静态拦）/ 只做纯数据 / 非法输入必抛 / 判别联合的落地形态 | 5 |

**取法**：

- `diy facts brief talk.rule` — 该主题全部条目 + 每条首句
- `diy facts get 'talk.rule#zero-dep'` — 单条完整值
- `diy facts brief 'talk.*'` — 全包一次拿

⚠️ **改 `src/**` 前至少 brief 一次 `talk.rule`**。两条最容易破：`zero-dep`（随手 `import 'node:fs'` 会让
「可拆分」这个价值主张当场失效，R7 会红但很多人只看功能测试）· `loud`（任何"容错一下"的静默丢弃，
在装配侧的表现是历史里少一条反驳，事后无法追）。
