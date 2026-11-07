---
desc: diy-facts 包内定位：哪个文件管什么（事实库内核 @diy-agent/facts）
updated: 2026-10-23
---

## atomic-write

`src/node/atomic-write.ts` 落盘原语：**两阶段**（先把 N 份 tmp 全写出来 → 再逐个 rename）；任一步失败清掉本批所有 tmp、目标保持原样、原错误上抛。tmp 名 `<目标>.tmp-<pid>-<rand>`（rand 防并发互踩；后缀不是 `.yaml`，`isFactFile` 另显式排除 `.tmp-`）。目标已存在 ⇒ tmp 继承权限位。**与 `@diy-agent/app` 的 `core/atomic-write.ts` 同范式、但各自持有一份**（依赖方向 `@diy-agent/app` → `@diy-agent/facts`，反向 import 会成环）；改语义两边一起改

（见 bfb9eaa0:pkgs.ts/diy-facts/src/node/atomic-write.ts:1）

## entry

`src/index.ts` 导出面；消费者只看这一份，别直接摸子文件

（见 cf38b8ab:pkgs.ts/diy-facts/AGENTS.md:8）

## fixtures

`tests/fixtures/real.ts` 取自仓库现有事实的真样例（判据压真数据，不编例子）

（见 cf38b8ab:pkgs.ts/diy-facts/AGENTS.md:13）

## index-build

`src/index-build.ts` claim 表 / 反查 / 冲突 / 影响面（全由程序生成）

（见 cf38b8ab:pkgs.ts/diy-facts/AGENTS.md:11）

## node

`src/node/index.ts`（`loadRepo` / `checkFacts` / `checkRepo` / `submit` / `renderDoc`）：**判据的唯二消费者共用这里** —— `check` 脚本与 `diy facts submit` 落盘前的候选集校验；两条路走同一份判据，杜绝「CLI 绿、CI 红」

（见 cf38b8ab:pkgs.ts/diy-facts/AGENTS.md:14）

## projection

投影给已解析值 + resolvedBy（按什么解析出来）+ variants（还有几个变体），不给变体列表 —— 让 agent 读到 18888 却不知道自己在 lab 就会踩坑

（见 apps/diy-app/src/main/services/facts-context.ts:1）

## resolve

`src/resolve.ts` 读取唯一入口（悬空与冲突**显式失败**，不返回 null）

（见 cf38b8ab:pkgs.ts/diy-facts/AGENTS.md:10）

## scope

`src/scope.ts` 三轴匹配 / 归一键 / 特定度

（见 cf38b8ab:pkgs.ts/diy-facts/AGENTS.md:9）

## tasklib

任务级库：`--in task:<taskUri>` → `$DIY_HOME/<uri>/knowledge/`，与仓库库**同一套**判据与事务；差别只有两条（词表继承、首次写入即诞生），见 `LoadRepoOptions`

（见 cf38b8ab:pkgs.ts/diy-facts/AGENTS.md:16）

## validate

`src/validate.ts` 未知输入 → `Fact[]`，**一次报全部问题**（不中途返回）

（见 cf38b8ab:pkgs.ts/diy-facts/AGENTS.md:12）

## writer

写入事务：**`validateFacts` 报任何 issue ⇒ 不进内核、不碰磁盘**（整批退，`problems` 带码可重提）—— 早期把坏事实过滤成空集后照样 submit，于是坏事实落成空集、词表成了唯一落盘物（中间态「6 主题 / 0 条」）；落盘本身两阶段（tmp + rename），一条不过则目标原样、tmp 清空

（见 bfb9eaa0:pkgs.ts/diy-facts/src/node/index.ts:732）
