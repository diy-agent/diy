# @diy-agent/session-store-jsonl — 分桶 jsonl 会话存储

> 全仓契约见仓库根 `AGENTS.md`。本包是 `@diy-agent/session` 的**可选适配器**：core 零 IO，落盘归这里。
> 需求真源是 `tests/intent.store.test.ts`（T1–T7）。

## 三条最容易破的约束

1. **按大小切桶，不按日期**（某天密集照样爆；缺省 8 MB，可配 `maxBucketBytes`）；
2. **seq 跨桶连续**：切桶不重置 seq；`readFrom(seq)` 查 index 只读需要的桶，不扫全量；
3. **缺桶 / 缺号必须报错**（`store/missing-bucket` / `store/gap`），不许静默跳过。

## 取法

- `diy facts brief rule` — 全局硬约束
- 设计背景：##456 body「存储分桶」段
