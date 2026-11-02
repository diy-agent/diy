# dev 启动器（`@diy-agent/app-dev`）

本机所有可测试入口的一页看板。界面形态见任务 ##502 正文（定稿 demo 是 `/tmp/dev-demo/index.html`，临时件）。

## 跑

```bash
./sha.sh lab        # 构建后起实例（lab 变体开 CDP 9223）
./sha.sh check      # 类型 + lint
npx vitest run      # 纯逻辑单测（不拉 Electron）
```

数据根 = `<仓库根>/build/lab/home`（与其它包同一约定），日志在 `<数据根>/log/dev/<launch>.log`。

## 四层模型（##502 第二轮）

```
worktree → app → launch → entries
```

- **静态清单**（有什么能启动）= `git worktree list --porcelain` × `glob <wt>/apps/<name>/app.yaml`。
  **不读注册表** —— 否则必须先启动一次才知道，本末倒置。
- **动态状态**（谁活着）= `~/.diy-instances/<pid>.json`，按 `(worktree, app, launch)` 三元组对回静态清单。
- **没有 variant 概念**：launch 就是「一条启动命令 + 它产生的入口」；一个 launch 可以有多个 entry。
- 端口：`app.yaml` 的 `url` 写配置端口，实际端口从注册表读；不一致时两个都显示。

新增一个 app = 在 `apps/<name>/` 放一个 `app.yaml`，**不用改本 app 的代码**：

```yaml
name: chat
title: diy 聊天
launches:
  - id: lab
    title: 开发（lab）
    command: ./sha.sh lab
    entries:
      - kind: app
        title: Electron 窗口
```

`launches[].env` 可以给命令加环境变量（web 的两个端口就是 `PORT: 8123` / `8124`）。

## 运行时怎么自报

- workbench 装配的 app（chat / minimal / dev）：`createWorkbench({ app, launch })` 启动时自报；
  `app` = 短名（`diy-chat`），`launch` 优先取 `DIY_LAUNCH`。
- apps/web：自己写注册表（它不是 workbench 装配），`launch` 取 `DIY_LAUNCH`，手工跑回推 `web-<实际端口>`。
- apps/remote-shell：自己写，`launch` 取 `DIY_LAUNCH`。
- `worktree` 由外壳/宿主从 cwd 往上找 `.git` 得到（不调 git）。

## 启动为什么「不抢焦点」

启动器给子进程注入 `DIY_NO_FOCUS=1` + `DIY_ENV=development` + `DIY_LAUNCH=<launch id>`，外壳据此：

- 窗口用 `showInactive()`（`workbench/src/index.ts` 的 `showInactive`）；
- dev / test 环境的窗口落在**非主屏**（`workbench/src/window.ts` 的 `sidecarWindowOptions`）。

判据：点「启动」前后启动器自己的 `document.hasFocus()` 不变。

## 构建命令

`build` / `check` / `test` / `sync` / `build-pkgs` / `clean`，在 app 目录下 `./sha.sh <cmd>` 执行。
白名单在 `shared.ts`（`BUILD_COMMANDS`），主进程侧再校验一次 —— 不接受任意命令。
worktree 没有 `build/` 目录时条目置灰并提示先构建（不自动 build）。
