# 工具链：检查 / 测试 / 同步 / 发布 / Electron

> 二次披露文档：`AGENTS.md::tool.*` 只留一行触发条件，步骤与坑住这里。
> 所有入口都在 `sha.sh`（`./sha.sh --help` 看子命令）与 `sha.common.sh`（公共函数）。

## check — 提交前唯一检查

`./sha.sh check` 串起：

1. `tsc -b tsconfig.all.json --noEmit`
2. oxlint
3. rpc 浏览器安全（`pkgs.ts/diy-rpc` 不得引入 Node 能力）
4. 产物护栏（源码旁不得残留 `.js` / `.d.ts`，见 `AGENTS.md::rule.check`）
5. 可执行位护栏：shell 脚本索引 mode 必须 100755（`scripts/check-exec-bit.sh`）
6. 各领域规范索引护栏（`scripts/check-specs.mts`）：`~/SPECS.md` 的 key 唯一（G1）/ 指针可解析（G2）/ 链上**新增**未收录（G3，ratchet：存量基线 `scripts/specs-unindexed.txt`，`--update-baseline` 刷新）；总表缺失 = 跳过不算失败（##388）

改一个文件只跑受影响的测试文件；全量套件收工前跑一次（`~/AGENTS.md::dev.verify-budget`）。

## fmt

- 格式真源 = **各包 `.oxfmtrc.json`**（根 `.oxfmtrc.json` 兜底）。
- oxfmt **不读** `package.json` 里的 `oxfmt` 块，真实键名是 `tabWidth` / `printWidth` / `singleQuote`。
- 根 `fix()` 扫 `pkgs.ts/` **全量（含 .md / .json）**。
- **fmt 未纳入 `check`**（存量 ~400 文件待规范化，见 ##323(oxfmt 配置腐坏)）。

## test

- `./sha.sh test` 全仓 · `./sha.sh test-unit` 快测（不起 Electron）。
- 意图测试：`pkgs.ts/diy-app/sha.sh test-intent [片段...]` —— 位置参数**过滤文件**（短名补 `tests/cli.intent.` 前缀，如 `test-intent ui-find`；带 `/` 或 `.test.ts` 原样传），无参才全量。
- 需求契约 = 意图测试：`pkgs.ts/diy-app/tests/cli.intent.*.test.ts` + `diy-template` / `diy-talk` / `diy-flow` 的 `tests/intent.*`。

## sync — 新开 worktree 第一件事

`./sha.sh sync` = `npm i --workspaces --include-workspace-root` + 子模块 + 各包 sync + electron 二进制收成共享软链。

- `--include-workspace-root` **不能省**：光 `npm i --workspaces` 只装 workspace、漏装根 `package.json` 依赖（`remark-gfm` 等），干净 worktree 上必现 build 解析失败。
- 末尾顺带 `sync-dev-home`：把 `~/.diy` 的真配置（`model.yaml` / `context.yaml` / `personas.yaml` / `providers.custom.yaml`）逐字投影进 `build/<variant>/home/`（变体随 `DIY_VARIANT`，缺省 lab；`DIY_SYNC_HOME=0` 关）。seed 只种示例数据，真配置归它。

## sync-gate — 入口自动过闸（`scripts/check-sync.mjs`）

build / check / test / lab 入口先跑只读快检：workspace 链接缺失或过期 + sync 印记 `node_modules/.diy-sync.stamp` 落后 + submodule 未 init。命中即自动跑 `sync-deps`（= `sync` 去掉 dev 数据根投影）。electron `dist` / `path.txt` 只提示不判定（由 `sync-deps` 的 `ensure-electron` 补；`npm i` 只补缺失、清不了改名残留，故 `sync-deps` 里另跑 `--fix` 精准清）。

`DIY_AUTO_SYNC=0` 关掉自动修（改为报错）；`./sha.sh sync-status` 只看状态。

## electron — 43 无 postinstall

- `require('electron')` 时二进制缺就在**当时进程里**下载、**无超时**：症状＝静默卡死数分钟、CPU 0%，日志看着像「在跑」。
- `dist` 是**悬空软链**（store 被缓存清理工具删）时更糟：自带 `install.js` 直接失败 `failed to create destination …: File exists`，并误导「删掉 node_modules/electron」，**不会自己重下**。
- 布局收口在 `scripts/ensure-electron.mjs`：全机一份 store + worktree 的 `dist` 只留软链 + 补 `path.txt`。
- 跑点：`sync-deps` 末尾自动跑且**不联网**；`pkgs.ts/diy-app/sha.sh` 的 `lab|test-intent|start` 起 Electron 前硬校验；**CLI 两条入口**（`diy.sh` / `bin/diy`）先过 `scripts/ensure-electron-if-needed.sh`（纯 bash 快检，就绪零 node 开销）—— CLI 顶层 `import electronPath from "electron"`，**每条命令**都经它。
- **缓存里明明有 zip 却重下**：`@electron/get` 缓存键 = 下载 URL 目录的 sha256；`~/.npmrc` 的 `electron_mirror` 只在 npm 上下文生效（运行时直接 node 没有 `npm_config_electron_mirror`）⇒ 走 GitHub 键必 miss。`ensure-electron` 显式读 npmrc 把镜像传下去，键才与 npm 安装时一致。
- **发行 CLI 不走惰性下载**（##478）：`diy-chat` 用 `apps/chat/bin/electron-bootstrap.mjs` 自己收口 —— 每个阶段先打印、镜像**并发探测**（各 3s 超时，逐个 ✓/✗ + 毫秒）、选**最快**的源、下载带百分比/速度/ETA、sha256 校验、解压心跳（静默 ≤ 2s）。`scripts/ensure-electron.mjs` 与它共用同一份探测/下载实现。
- 开关 / store 位置详见脚本头注。

## publish — npm（`@diy-agent` scope）

- 根 `./sha.sh publish [--dry-run]` → 清单 `_npm_publish_pkgs`（**顺序 = 依赖在前**）：`diy-rpc` / `diy-ui` / session / session-store-jsonl / workbench / workbench-ui / model-catalog / model-config-page / llm-provider / bot / chat-page / workbench-plugin / **apps/chat**。
- 能力包 publish = `tsc -p tsconfig.build.json` + `scripts/npm-publish.mjs`：在 `lib/` 生成发行版 `package.json`（`exports` 指 `*.js` + `.d.ts`）→ `npm publish lib`。
- app publish = `apps/chat/sha.sh publish` → `scripts/npm-publish-app.mjs` 把 `bin/` + `build/<variant>/` 组装到 `dist/`（`main` = `build/main/index.mjs`，`bin` = `diy-chat`）→ `npm publish dist`。
- 仓内 `package.json` 恒指 `src/*.ts` 且留 `private:true`（护栏，别为了让 publish 通过而改）；发行物由脚本剥离。
- **仓内依赖改写**：仓内写 `*` / `workspace:*`，发布时统一改成 `^${仓内版本}`（唯一实现在 `scripts/npm-publish-common.mjs`）。不改写就会装回旧版 —— ##478 里 chat-page 依赖 `ui: ^0.1.0` 而 ui 已是 0.2.0，用户装到的是旧 ui。
- **可重复跑**：发布前 `npm view <name>@<version>` 探一下，已存在就跳过（npm 不允许重发同版本），部分失败后直接重跑整条即可。
- app 的 `bin/` 必须**入库**：##478 事故 = app-chat@0.1.0 是手工攒 `dist/` 发的，`bin/diy-chat.mjs` 只存在于某台机器的磁盘上，仓库里没有 ⇒ 发布形态无从修。
- 认证 `NPM_PUBLISH_TOKEN`（环境变量或 `~/.bashrc`）；CI 无则跳过而非报错。registry 恒指 `registry.npmjs.org`（本机 `~/.npmrc` 的淘宝镜像会被临时 userconfig 覆盖）。

## 单包动作

`pkgs.ts/diy-app/sha.sh lab|build|test|cli` —— 只动这一个包。

## 其他

- 真实 UI 验证走 CDP：`playwright-cli attach --cdp=…`（取值见 `diy getAppInfo`）。
- 环境变量 → provider 导入候选（只列不写；UI 模型页提示条 / `diy llmConfig scanEnv|importEnv`）→ `pkgs.ts/diy-app/src/main/core/model-import.ts`。
- 破坏性操作的应用内二次确认走 `renderer_solid/components/ConfirmDialog.tsx`；**禁用原生 `window.confirm`**（窗口级模态：卡住整个渲染进程，且非 DOM 节点 —— 自动化点不到）。
