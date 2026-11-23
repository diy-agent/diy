# 实例三态：谁来跑、跑哪份数据、看谁的 UI

> 二次披露文档：`AGENTS.md::entry.*` 只留一行结论，机制细节住这里。
> 代码真源：`apps/diy-app/src/runtime.ts`（`DIY_*` 契约）· `src/main/core/instance-identity.ts` · `src/main/core/dev-home.ts` · `src/main/core/single-instance.ts`。

## 一、产物一份，数据根显式给

**一份产物**：`apps/<app>/build/prod/**`（vite `outDir` 写死，`DIY_VARIANT` 不参与）。

**数据根只认显式值**：`DIY_HOME`（或 `--home`）。非生产没给 → **报错退出**（不推导、不回落）；生产入口缺省 `~/.diy`（diy2 `~/.diy/diy2`）。路径由入口脚本算 `run/<app>/<label>` 再传下去：

- `run/diy-app/lab`、`run/diy-app/staging/<slot>`、`run/diy-app/preview`
- `run/diy2/lab`、`run/diy2/staging`

产物与数据分开 ⇒ `clean`（删 `build/`）不再能删掉数据。代价：**同一 worktree 里 `lab`（watch 写 `build/prod`）与 `test`/`staging --build` 不能同时跑**（产物一份，会互相覆盖）；跨 worktree 无此问题。

`DIY_VARIANT` 只剩**标签**（dev 能力 / 自动种入缺省 / 实例显示名）。`preview` 也是标签：产物 `build/prod`，数据根 `run/diy-app/preview`。

## 二、三个入口

| | `diy`（全局命令） | `./diy.sh` | `./sha.sh lab` |
|---|---|---|---|
| 本质 | 发布版 CLI **客户端** | worktree 通用 CLI **客户端** | **GUI 启动器**（HMR，免构建） |
| 用途 | 操作**生产**数据（真实任务·项目·agent·日志） | 连/起本 worktree 实例（按 `DIY_VARIANT`） | 人看 UI 效果 + agent 快速验证 / 实验 |
| 标签 | `prod` | `lab`（缺省） | `lab` |
| 跑什么 | `node build/prod/cli/index.js` | `auto`：`build/prod/cli/index.js` 优先（打包源更新则回退 `tsx`，`DIY_CLI_MODE=auto\|compiled\|tsx`） | Vite dev server + watch main/preload + Electron（HMR） |
| 要构建吗 | **要**（`sha.sh build` 出 `build/prod`） | **要**（否则 `build/prod/main` 不存在 → CLI 报错退出） | **不用**（HMR 走 `loadURL`） |
| 数据根 | `~/.diy`（**生产**） | `run/diy-app/<variant>`（缺省 lab） | `run/diy-app/lab` |
| `DIY_ENV` | `production` | `development` | `development` |

测试 = **第三态**，不是 CLI：`apps/diy-app/sha.sh test-intent` 起隔离 Electron（`DIY_VARIANT=test` + `DIY_HOME=mkdtemp` + `DIY_ENV=test`），产物是同一份 `build/prod/**`（先 `build`，故别与 `lab` 同时跑）。

## 三、客户端 vs 启动器（最常踩）

- **客户端**（`diy` / `./diy.sh`）都不启动 GUI：读 `$DIY_HOME/app.port` 探活 → 验身份 → 连不上才 spawn Electron（CLI 与 GUI 是两进程）。连哪个实例由 `DIY_HOME`（数据根）决定。
- **端口不承载身份**：探活后必须问 `getAppInfo.diyHome` 比对，不是本数据根就拒绝复用、另起自己的（##328(实例身份只靠端口)）。优先级 / 缺省 / 非生产不沿用记录里的 `18888` 见 `apps/diy-app/AGENTS.md::env.port`。
- **起 GUI 的入口是启动器，不是客户端**：`./sha.sh lab` 只 spawn 新实例，从不连已跑的那个（不读 `app.port`）。重复运行 = 开第二个实例 → 撞本数据根的 `SingletonLock` 并退出（`core/single-instance.ts::lockAdvice` 会打印「直接用它：`./diy.sh <命令>`」）。**要访问实例一律用客户端。**
- **全局 `diy` 的来源**：一般由 main 上 `npm link` 而来 → 跑的是 **main 的 `build/prod` 编译产物**；worktree 里改的码它看不到。
- **客户端与服务端必须配对**：`./sha.sh lab` 起的配 `DIY_HOME=run/diy-app/lab DIY_VARIANT=lab ./diy.sh`（`./diy.sh` 缺省同标签、同 home 约定，故平常不必显式给）。不配对 = 对着另一个数据根敲命令（症状：任务不存在 / 改完没反应）。`./diy.sh` 能连上 HMR 实例，是因为 `electron-dev.mts` 的 watch 已把 `build/prod/main` 产出来了。
- **验证起对了没**：`diy getAppInfo` 看 `diyHome` / `env` / `branch`。

## 四、home guard：继承来的生产 `DIY_HOME` 一律拒绝

判据 `core/instance-identity.ts::isProdDataHome` + `core/dev-home.ts::resolveDataHome`（`./diy.sh` 与 `./sha.sh lab` 共用）。**没给 `DIY_HOME` → 报错退出**（不按变体推导；入口脚本负责算 `run/<app>/<label>`）；继承来的生产根 → 报错（不静默回落）。不拦的后果：lab 开着生产数据根跑、还会把种子写进去。放行需 `DIY_ALLOW_PROD_HOME=1`。细节见 `apps/diy-app/AGENTS.md::env.home`。

## 五、seed：空数据根的初始种入

- **生产根永不种入**。
- `lab` 缺省自动只跑一次（`.seed-done` 标记，删掉的 provider 不会被种回来）。
- 只种**示例/测试数据**；真配置（`model.yaml` / `context.yaml` / `personas.yaml` / `providers.custom.yaml`）由 `./sha.sh sync` 投影，见 `docs/toolchain.md::sync`。
- 开关三态 / 补缺命令 / 落点见 `apps/diy-app/AGENTS.md::env.seed`。

## 六、起停权限

`test` / `lab` 由 agent 自由起停（数据皆临时非生产，坏了就清）；**唯全局 `diy`（prod / `~/.diy`）是日常实跑的生产 app** —— 不动其数据根、不杀其进程，重启留给用户手动。硬约束见 `AGENTS.md::rule.instance-lifecycle`、`AGENTS.md::rule.lab-owner`。
