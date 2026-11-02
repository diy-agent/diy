# dev 启动器（`@diy-agent/app-dev`）

本机所有可测试入口的一页看板：树列表 + 启停 + 构建命令 + 多方式打开。
界面形态见任务 ##502 正文（定稿 demo 是 `/tmp/dev-demo/index.html`，临时件，不入库）。

## 跑

```bash
./sha.sh lab        # 构建后起实例（lab 变体开 CDP 9223）
./sha.sh check      # 类型 + lint
npx vitest run      # 纯逻辑单测（不拉 Electron）
```

数据根 = `<仓库根>/build/lab/home`（与其它包同一约定），日志在 `<数据根>/log/dev/<target>.log`。

## 它认识的「目标」

`targets.ts` 里**写死**一张表（##502：先不做动态扫描）：diy-app / apps/chat / apps/web（:8123 ·
:8124）/ apps/remote-shell / apps/minimal 各自的 `lab`。每条 = 目录 + `./sha.sh` 子命令 +
变体 + 数据根 + 实例注册表里的 `app` 短名。

## 数据来源

只有一份：`~/.diy-instances/<pid>.json`（##495 的注册表，`app` 字段见 main `55e7766f`）。

- 外壳（`@diy-agent/workbench`）在宿主给出 `app` 时**自报**这条记录（chat / minimal / dev 都走它）；
  remote-shell 自己写（它不是 workbench 装配）。
- 读侧按 pid 存活过滤，死条目顺手删掉 —— 「关掉一个实例下次就不再出现」不依赖退出钩子。
- 老记录（`app: null`）不报错；能从 argv / cwd 认出 app 时补一条兜底（`instances.ts` 的 `inferApp`）。

## 启动为什么「不抢焦点」

启动器给子进程注入 `DIY_NO_FOCUS=1` + `DIY_ENV=development`，外壳据此：

- 窗口用 `showInactive()`（见 `workbench/src/index.ts` 的 `showInactive`）；
- dev / test 环境的窗口落在**非主屏**（`workbench/src/window.ts` 的 `sidecarWindowOptions`，
  判据与 diy-app 的 `mirrorWindowPos` 同一份）。

所以点「启动」时，当前焦点仍在启动器自己的窗口上（判据：`document.hasFocus()` 不变）。

## 构建命令

`build` / `check` / `test` / `sync` / `build-pkgs` / `clean`，在目标目录下 `./sha.sh <cmd>` 执行。
白名单在 `shared.ts`（`BUILD_COMMANDS`），主进程侧再校验一次 —— 不接受任意命令。
