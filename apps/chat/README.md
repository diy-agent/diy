# @diy-agent/app-chat

以 **bot 为中心**的聊天应用（##498，早先是 ##465 的多会话形态）：

- 左侧是 **bot 条**（64px，hover 展开 200px），**一个 bot 一条长期会话**（`bot.primary()` 幂等）
- **没有「新建会话」**：要新对话 = 新建 bot；底栏一行合并「bot 名 ⚙ | 输入 / 窗口 / 缓存 / 本轮 / 上下文」
- bot 身份：`$DIY_HOME/bots/<id>/bot.json`（含 `primarySessionId`）；上次选中的 bot 记在 `$DIY_HOME/chat-ui.json`
- 会话落盘：`$DIY_HOME/sessions/chat/<id>/`（`@diy-agent/session-store-jsonl` 的桶 + `meta.json` + 归属 `bot.json`）
- 模型目录：`@diy-agent/model-catalog` 读 `$DIY_HOME/model.yaml` / `providers.custom.yaml`
- key 只在建 provider 时经 `readAccountValue()` 取，不打印、不落盘

```bash
./sha.sh sync      # 仓库根：把 ~/.diy 的真配置投影到 build/lab/home
cd apps/chat && ./sha.sh lab
./sha.sh smoke     # CDP 走一遍 ##498 判据（真模型回复 / bot 隔离 / 落盘 / 重启 / 无「新建会话」）
```

## 发行（npm）

```bash
npm i -g @diy-agent/app-chat     # 或 npx @diy-agent/app-chat
diy-chat                         # 启动
diy-chat electron [--check]      # 只准备 / 只检查 Electron 二进制（并发探测镜像 + 进度）
diy-chat --version | --help
```

- **只有一个 bin**（`diy-chat`）：npx 对唯一 bin 会自动选中，功能用子命令分裂，不再加第二个入口（用户 2026-10-30 拍板）。
- `--mirror=<url>` / `--zip=<file>` 等价于 `ELECTRON_MIRROR` / `DIY_ELECTRON_ZIP`；二进制落全机共享 store（`<cache>/diy/electron`），重装不重下。
- 发布：`./sha.sh publish`（组装 `dist/` + 发布；源码在 `bin/` 与 `build/<variant>/`，见 `scripts/npm-publish-app.mjs`）。
