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
