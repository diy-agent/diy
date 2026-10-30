# @diy-agent/app-chat

多会话聊天应用（##465）：左侧会话列表 + 主区消息流 + 顶部模型选择器。

- 会话落盘：`$DIY_HOME/sessions/chat/<id>/`（`@diy-agent/session-store-jsonl` 的桶 + `meta.json`）
- 模型目录：`@diy-agent/model-catalog` 读 `$DIY_HOME/model.yaml` / `providers.custom.yaml`
- key 只在建 provider 时经 `readAccountValue()` 取，不打印、不落盘

```bash
./sha.sh sync      # 仓库根：把 ~/.diy 的真配置投影到 build/lab/home
cd apps/chat && ./sha.sh lab
./sha.sh smoke     # CDP 走一遍 ##465 判据（真模型回复 / 隔离 / 落盘 / 重启）
```
