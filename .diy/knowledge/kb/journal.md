---
desc: 任务日志 journal.jsonl 的写作约束（author / anchor / 只追加）
updated: 2026-10-21
---

## anchor

anchor 复用 @diy-agent/talk 的 Anchor（message / doc-range 带 revisionId+offset+quote+fuzzy 校正 / task-field / node）+ causes 因果链，不另造第五套事件记录

（见 pkgs.ts/agent/talk/src/anchor.ts:1）

## author

author 三态决定能否当证据：system（flow 转移顺手写，客观可校验）/ agent:<名>（LLM 叙述，可能错，只当线索）/ human:<名>（用户原话，必须带 anchor 或 quote，否则拒写）

（见 pkgs.ts/agent/talk/src/anchor.ts:1）
