---
desc: 上下文固定前缀的规模与构成（每轮都付的字节，##404 减负主线）
updated: 2026-10-25
---

## cache-economics

**一步的钱由 `cacheHit` 决定，不由前缀大小决定**：实测命中步 ≈ $0.0007/步，未命中步 ≈ $0.0118/步 ⇒ **≈18 倍**（2026-10-24，deepseek-v4.1-flash，lab tasks/5 单轮 8 步）。

推论一：**减负动作必须成批落在轮次边界，不能边走边改** —— 每改一次 system 段就熔断一次缓存，18 倍单价会把零敲碎打的小改全部吃回去；省下的 10 KB 要几十步才回本。

推论二：`runtime.self` 这类**每步都变**的自量必须走 `runtimeDiff`（追加在末尾，不动前缀），绝不能进 `runtime` 全量（轮首全量 = 每轮第一步让其后所有历史失效）。实测 `self` 块 192 B/步，代价可忽略。

推论三：`cacheHit` 掉到 <50% 要能分辨两种成因 —— ①自己改了 system 段（可控）②历史压缩触发（预算阶梯的固有代价，必然断一次）。结果同为 18 倍，处置完全不同。

## chain-share

AGENTS.md 链瘦身前 28.3 KB 占 system 81%（~/AGENTS.md 17.0 · 仓库 9.5 · ~/git 1.6）；仓库那份 43 条正文 2026-10-22 迁进知识库后降到 1.9 KB，system 34.9→26.7 KB。**剩余大头是 ~/AGENTS.md 17.0 KB（占 system 64%）**：它是全局规则，塞项目库是 scope 错位，得先有 user 级库

## evidence-anchor

`evidence.at` 锚的是**当前文件行号**，源一瘦身就全烂：AGENTS.md 从 75 行改成 29 行后，43 条 `at: AGENTS.md:NN` 越界 → `facts submit` 整批被挡（全过才写），一条新事实都写不进去。迁移类事实不该锚在被搬空的原文件上：要么去掉 at（git 历史可追），要么 schema 支持 `<rev>:<path>:<line>`（未实现）

## expose-ceiling

`expose` 预算 4000 B 是**每轮常驻知识**的硬上限（超了 submit 拒写 `facts/expose-budget`）。按键 ≤12 token 折算 ≈ 54 B/条 ⇒ **装不下一条真实事实**（实测均值 220~400 B/条）⇒ `full` 只能给「写错就每轮教坏动作」的少数主题（现 2.4 KB / 13 条 `where`），其余一律 `index`。判据不是「库有多大」，是「省下的解析轮次 × 单轮成本」。

## help-share

信封 help 7.4 KB 里 `system`(3.2) + `runtime`(2.2) 两节占 73%，全是 zod 派生的结构说明；`about` 固定话术已从 1689 B 压到 724 B（占 10%）。再砍只能动描述文本（`descMaxDepth`）

## measure

量上下文别用 reqlog：请求体默认截断（head 8 KB / tail 16 KB），量出来偏小且缺中段。走与真发同一个组装函数 `assembleSystem` + `buildHelpDoc` 才算准（脚本见 evidence.probe）

（见 apps/diy-app/src/main/services/prompt-registry.ts:503）

## prefix-cost

每轮都付的固定前缀实测 46 KB 量级：system 34.9 KB + 信封 help 7.4 KB + facts 投影 ≤4 KB（runtime 首步）。基线日期 2026-10-22（lab，tasks/5）

## query-cost

**搬走的账按收支算，不按字节线性相除**：搬走 1 KB 每轮省 1 KB；但要查它一次 ≈ 一次额外请求的前缀重发（`get` 全量 41 KB 量级：system 26.7 + help 8.1 + facts 4.0 + kb 索引 2.2；`brief` 单位 KB 成本低一个数量级）⇒ **回本 ≈ 20 轮 / KB**（原来按 41000/X 算出的「200 B = 205 轮」是把查询成本全押在 41 KB 全量重发上，brief 已把单次成本压掉一个量级）。**推论：<1 KB 的小条目搬走仍不划算**；只有大块低频参考才值得。减负优先序 = 删 > 压缩 > 搬

## resident-set

常驻集 = **会改变行为、且违背代价高**的（硬约束 / 反直觉坑 / 入口选择），少而硬；搬运集 = **大块（>2 KB）且查阅式**（参考实现路径 / 命令细节 / 历史决策）；删除集 = 从不用。按此体检 2026-10-22 迁走 AGENTS.md 43 条（均 220 B）：`rule` 8 + `entry` 5 属于前一类（本应常驻），`find` 12 / `tool` 22 / `model` 5 属于搬运集（搬走合理）。工具面缺「按 subject 标 expose，不靠人拍脑袋」

## score-l0

**上下文质量的 L0 机械记分卡**（零 LLM，全从 `llm.jsonl` 解析）五个指标：`recheck` 重查率（bash 里 `cat|sed|head|tail` 的路径在最近 20 步内读过，每步上限 1）· `ungrounded` 工具报错率（`output.type==error-text` 或退出码非 0）· `idle` 空转率（无工具调用）· `hallucinated_ref` 假引用率（`<path>:<line>` 经 `git ls-files` + 行数校验）· `human_nudge` 真人消息数（含催促）。
**##5 实测基线**（1103 步 / 1079 调用 / 74 轮）：recheck 45.3% · err 2.9% · idle 4.0% · hallu 0.45% · 真人消息 62 条。recheck 45% 换算成成本 ≈500 步重复劳动 ≈20 MB 前缀。
**用法铁律**：只做**事件对齐**（kb 改动前 30 步 vs 后 30 步），绝对值不跨任务比较。演示页：`build/lab/home/projects/1/tasks/5/gen/demo/2026-10-23-kgscore/index.html`（解析器同目录 `score.py`）。

## step-cost

**一步 = 一次工具调用 = 一次全前缀**：实测 ##5 的 1096 步里 1032 步只有 1 次工具调用（step 内不串多调），每步付一次 ~40 KB 前缀 ⇒ 全程 ≈44 MB。所以上下文成本的唯一杠杆是**省步数**，任何「上下文质量」指标最终都要能预测步数，否则只是噪声。
