# @diy-agent/app-chat

以 **bot 为中心**的聊天应用（##498，早先是 ##465 的多会话形态）：

- **架构（##505）**：本 app 只剩**装配 + UI**；bot 领域 / 会话编排 / 模型解析在
  `@diy-agent/bot` 的 `createBotChat`（actor 队列，见 `docs/plans/2026-11-02-concurrency-actor.md`），
  算价在 `@diy-agent/model-catalog` 的 `costOf`。UI 只负责显示与发请求
- 左侧是 **bot 条**（64px，hover 展开 200px），**一个 bot 一条长期会话**（`bot.primary()` 幂等）
- 最左侧是工作台**窄 bar**（52px 图标）+ 抽屉菜单（分组 / 收起）；bot 配置走**右侧 panel**
  （viewset：悬浮 / 固定两态，hover 列表可预览）
- **没有「新建会话」**：要新对话 = 新建 bot；底栏一行合并「bot 名 ⚙ | 输入 / 窗口 / 缓存 / 本轮 / 上下文」
- bot 身份：`$DIY_HOME/bots/<id>/bot.json`（含 `primarySessionId`）；「上次选中」只活在本次进程里（不写 `chat-ui.json`，##505-B）
- 会话落盘：`$DIY_HOME/sessions/chat/<id>/`（`@diy-agent/session-store-jsonl` 的桶 + `meta.json` + 归属 `bot.json`）
- 模型目录：`@diy-agent/model-catalog` 读 `$DIY_HOME/model.yaml` / `providers.custom.yaml`
- key 只在建 provider 时经 `readAccountValue()` 取，不打印、不落盘

```bash
./sha.sh sync      # 仓库根：把 ~/.diy 的真配置投影到 build/lab/home
cd apps/chat && ./sha.sh lab          # 落盘模式
cd apps/chat && ./sha.sh lab:memory   # 内存模式（bot / 会话不落盘，重启即丢）
./sha.sh smoke     # CDP 走一遍 ##498 判据（真模型回复 / bot 隔离 / 落盘 / 重启 / 无「新建会话」）
```

## 发行（npm）

```bash
npm i -g @diy-agent/app-chat     # 或 npx @diy-agent/app-chat
diy2                         # 启动
diy2 electron [--check]      # 只准备 / 只检查 Electron 二进制（并发探测镜像 + 进度）
diy2 --version | --help
```

- **只有一个 bin**（`diy2`）：npx 对唯一 bin 会自动选中，功能用子命令分裂，不再加第二个入口（用户 2026-10-30 拍板）。
- `--mirror=<url>` / `--zip=<file>` 等价于 `ELECTRON_MIRROR` / `DIY_ELECTRON_ZIP`；二进制落全机共享 store（`<cache>/diy/electron`），重装不重下。
- 发布：`./sha.sh publish`（组装 `dist/` + 发布；源码在 `bin/` 与 `build/<variant>/`，见 `scripts/npm-publish-app.mjs`）。
