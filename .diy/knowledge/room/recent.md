---
desc: 为什么 diy2 不投 room.recent（会话已经 ingest 房间公共日志）
updated: 2026-11-20
---

## decision

diy1 的 `room.recent` = 「自上次以来别人的发言」变量单元，让模型在开口前知道其他人刚说了什么。diy2 的每个 `BotSession` 已经把房间公共日志 `ingest` 进自己的 transcript —— 别人的发言本来就在历史里，再投一份 `room.recent` 是重复。**diy2 只投 `room.members`（谁在房里 / @ 键 / 是否主人格），不投 recent。** 若将来改变 ingest 语义（例如只保留结论），再重新评估。

（2026-11-20 用户确认）
