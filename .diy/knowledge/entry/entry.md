---
desc: 实例三态（**先问：操作谁的数据 / 谁看 UI**）
updated: 2026-10-23
---

## choose

**先问「操作谁的数据」**：真实任务/项目/agent → 全局 `diy`；worktree 改码·跑测试 → `./diy.sh`；人看 UI 效果 / agent 实验 → `./sha.sh lab`。**别拿 `./diy.sh` 查生产任务**（数据根不同 → 报「任务 N 不存在」）

## client

`diy` / `./diy.sh` **都是客户端**（不启 GUI）：探 `$DIY_HOME/app.port` + 验身份，连不上才 spawn；**起 GUI 的是启动器 `./sha.sh lab`，只 spawn、从不连已跑实例**

## client-data-root

`diy` / `./diy.sh` 作为客户端按 **`$DIY_HOME` 定位数据根**（读 `$DIY_HOME/app.port` 探活）：shell 里继承来的 `DIY_HOME` 会把它拉去连**那个数据根**的实例，症状是查生产任务报「任务不存在」而不是报错。判据 `diy getAppInfo` 看 `diyHome`；跨数据根操作显式 `env -u DIY_HOME -u DIY_VARIANT diy …`

（见 apps/diy-app/src/cli/index.ts:113）

## gui

起 GUI 两条路：`./sha.sh lab`（HMR，免构建）或 `sha.sh build` 后由 CLI 拉起

（见 docs/instance-modes.md:35）

## home-guard

「继承来的生产 `DIY_HOME` 一律拒绝」：判据 `core/instance-identity.ts::isProdDataHome`、回落 `core/dev-home.ts::resolveDevHome`（`./diy.sh` 与 `./sha.sh lab` 共用；不拦则 lab 开着生产数据根跑、还会把种子写进去；放行需 `DIY_ALLOW_PROD_HOME=1`）。细节见 `apps/diy-app/AGENTS.md::env.home`

（见 docs/instance-modes.md:40）

## launch-vs-client

**起 GUI 的入口是启动器，不是客户端**：`./sha.sh lab` 只 **spawn 新实例**，从不连已跑的那个（不读 `app.port`）—— 重复运行 = 开第二个实例 → 撞本数据根的 `SingletonLock` 并退出（`core/single-instance.ts::lockAdvice` 会打印「直接用它：`./diy.sh <命令>`」）。**要访问实例一律用客户端**，别指望再敲一次启动器

（见 docs/instance-modes.md:35）

## port

端口**不承载身份**：探活后必须问 `getAppInfo.diyHome` 验身份，不是本数据根就另起（##328）。优先级 / 缺省 / 非生产不沿用记录里的 `18888` 见 `apps/diy-app/AGENTS.md::env.port`

（见 docs/instance-modes.md:34）

## prod

全局 `diy` 一般由 main 上 `npm link` 而来 → 跑的是 **main 的 `build/prod` 编译产物**；worktree 里改的码它看不到

（见 docs/instance-modes.md:36）

## risk

worktree 改码跑测一律 `./diy.sh`（隔离数据根）；**查/改真实数据才用全局 `diy`**。继承来的生产 `DIY_HOME` 一律拒（放行 `DIY_ALLOW_PROD_HOME=1`）

## seed

空数据根的初始种入：**生产根永不种入**；`lab` 缺省自动只跑一次（`.seed-done` 标记，删掉的 provider 不会被种回来）。开关三态 / 补缺命令 / 落点见 `apps/diy-app/AGENTS.md::env.seed`

（见 docs/instance-modes.md:44）

## variant

`DIY_VARIANT`（`prod|test|lab|preview`）是产物 / 数据分根的唯一轴，缺省 `prod`（`./diy.sh` 缺省 `lab`）；`preview` = **编译后运行（无 watch）的稳定实例**，用来跑「不能被重启打断」的长会话（恢复于 2026-10-23，##404）。详见 facts `app.entry#variant`。

（见 apps/diy-app/sha.sh:113）

## variant-match

**客户端与服务端变体必须配对**，不配对 = 对着另一个数据根敲命令（症状：任务不存在 / 改完没反应）

## verify

lab 起来后用 `diy getAppInfo` 看 `diyHome` / `env` / `branch`，确认数据目录与启动参数（验证没起错数据根/变体）

（见 docs/instance-modes.md:38）
