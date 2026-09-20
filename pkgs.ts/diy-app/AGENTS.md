# diy-app 开发规范

## 架构原则

### 构建

- **无 electron-vite**，直接使用 Vite 8 三独立配置（main / preload / renderer）
- `scripts/electron-dev.mts` 自有开发编排，不依赖 electron-vite 封装
- **类型检查绝不 emit**（`tsconfig.json` 的 `noEmit: true`，唯一入口 `./sha.sh check`）：
  tsconfig 的 `include` 覆盖 src/scripts/tests，一旦 emit，`.js/.jsx/.d.ts` 会**落在源码旁边**；
  而 vite/vitest 的 `resolve.extensions` 里 `.js/.jsx` 排在 `.ts/.tsx` 之前 → dev/构建/单测
  全部静默加载旧产物（症状：改了源码没反应、单测测的是产物、`git add -A` 把产物收进仓库）。
  实测过的触发方式：裸 `npx tsc`、IDE 的 TS emit；护栏 = 各包 `noEmit: true` +
  根 `.gitignore` 的 `pkgs.ts/**/*.{js,jsx,mjs,cjs,d.ts}`（新增包自动覆盖，无需逐包配）。
  判断当前在跑什么：`curl -s localhost:5173/App.tsx | grep -o '"/components/[^"]*"'`
  （dev 下 App 是 `.tsx`、子组件如果出现 `.jsx` 就是产物在跑）。
- **改 `src/**` 会触发 dev watch 重启 Electron**（main/preload 都是 watch 构建）：
  正在跑的本机 agent 轮次会被打断（表现为 ops 里 tool 被标 `interrupted`）。
  想改文件同时不打断自己的轮次，就先把轮次跑完；别在轮次中拿源码当探针文件。
- **dev 会话运行中，不要再并发跑 `tsc -b` / `vite build` / 全量 vitest**：会与 watcher 抢同一
  `outDir` 并制造海量 FS 事件（尤其批量删产物），实测能让 watcher 卡死。
  判断 watcher 死活：改一个 `src/main/**` 文件，看 `out/main/index.mjs` 的 mtime 是否变；
  不变就只能重启 `./sha.sh dev`。注：删文件/删目录本身不会让 watcher 停（已实测：补回同名文件即恢复），
  删 `out/` 也不影响（输出目录不在监听范围）。

### 开发参数

```
./sha.sh dev                    # 默认 ./build/home + port 18888（与 ./diy.sh 同数据）
./sha.sh dev --port 18888       # 指定端口（测试端口冲突）
```

数据隔离由 `DIY_HOME` 驱动（`diy.sh` / `electron-dev.mts` 默认 `./build/home`，测试用 `mkdtemp`），不再有 `--temp` flag。

### 入口与运行配置（环境变量契约）

两个 CLI 入口只负责**注入环境变量**，业务侧统一由 `src/runtime.ts readRuntimeConfig()` 读取组装，不做路径/模式派生。

| 入口 | 场景 | 跑什么 | 注入 |
|------|------|--------|------|
| `./diy.sh`（仓库根） | worktree 开发/测试 | `tsx src/cli/index.ts` | `DIY_HOME=./build/home`、`DIY_APP_ROOT=pkgs.ts/diy-app`、`DIY_CLI=<仓库根>/diy.sh` |
| `bin/diy` | 发布后（npm 全局/PATH） | `node out/cli/index.js` | `DIY_HOME=~/.diy`、`DIY_APP_ROOT=<自定位包根>`、`DIY_CLI=$0` |
| `scripts/electron-dev.mts` | dev 拉起 GUI | `out/main/index.mjs` | `DIY_HOME`、`DIY_CLI=<仓库根>/diy.sh`、`DIY_DEV_SERVER_URL`、`DIY_MIRROR_DISPLAY` |

环境变量契约（`src/runtime.ts`）：

| 变量 | 含义 | 缺省 |
|------|------|------|
| `DIY_HOME` | 数据根（state/task/**app.port**） | `~/.diy` |
| `DIY_CLI` | 当前生效的 CLI 入口绝对路径（提示词模版 100-diy 消费） | 无 → 提示词里告警（**不静默冒充 `diy`**） |
| `DIY_PORT` | 首选端口；测试注入 `0`（随机） | 无 → app.port 文件 → 兜底 18888 |
| `DIY_DEV_SERVER_URL` | dev GUI 加载 Vite URL（`electron-dev.mts` 注入） | 无 → loadFile 产物 |

三个入口都必须注入 `DIY_CLI`：漏一个就会出现“GUI 拉起的会话告诉模型敲裸 `diy`”，
在 worktree 里会打到生产数据根（`~/.diy`）。

端口优先级：`DIY_PORT` > `app.port` 文件（上次实例） > 18888。

### Renderer 双框架（React → Solid 迁移中）

电控台 renderer 正在从 React 迁移到 Solid：
- **`renderer_solid/`（主线，构建默认）** — SolidJS 渲染层，改 UI 必改这里
- **`renderer/`（React 遗留，仅参考）** — 老 UI；构建已切 `vite.renderer.config.ts`（root=`renderer_solid` + vite-plugin-solid），React 版另存 `vite.renderer.react.config.ts`

### 组件分层（Solid 主线）

```
renderer_solid/
  ├── components/          ← 业务组件（daisyUI 高阶组件组合）
  ├── store/               ← Solid signal 单例（「值 getter」暴露，别暴露裸 getter 函数）
  ├── lib/                 ← rpc client / renderer-api-impl(diy.ui.* handler) / 共享入口
  ├── main.tsx             ← render() + bind diy.ui.* handler
  └── index.css/html
```

- ✅ 业务组件用 daisyUI 高阶组件组合（drawer/navbar/card/modal/chat/tabs），JSX 少裸 Tailwind（接近 Flutter 只管结构）
- ✅ store 「值 getter」单例：`get nodes(){return nodes()}` —— 否则组件 `for...of` 遍历 getter 函数 → 页面空白
- ✅ 任务树拖拽用 `@dnd-kit/solid`（dnd-kit 官方 Solid 包），`sensors={[PointerSensor]}` 禁键盘拖拽
- ❌ 不开发通用 UI 组件

renderer_solid/ 有独立 tsconfig（strict + jsxImportSource: solid-js），tsc 零报错。根 tsconfig.json 因 react-jsx 冲突仍 exclude，但类型检查由自身 tsconfig 覆盖。

### 数据落位：按「可重建性」分三类（改代码前先对照）

同一份界面数据放哪，判据只有一条 —— **丢了能不能重建、重建有没有损失**：

| 类别 | 例子 | 丢了会怎样 | 落位 |
|------|------|-----------|------|
| **视图 cache** | 任务树展开/滚动、面板宽度、聊天密度、主题 | 无损失，可重建 | 浏览器 `localStorage`（唯一入口 `renderer_solid/lib/ui-state.ts` 的 `Caches` 字段池，可被「重置界面状态」清空） |
| **半编辑数据**（草稿） | agent 输入框草稿、任务编辑框（标题/详情/正文） | **用户白打，不可重建** | 任务目录 `.diy/drafts.yaml`（`src/main/core/drafts.ts`，经 RPC 读写） |
| **会话日志** | `ops.jsonl` / `llm.jsonl` | 是权威但可重放重建、量大 | `$DIY_HOME/local/`（现状，勿搬） |

- ❌ **禁止把草稿写 localStorage**：serve 模式与 Electron 模式各持一份 localStorage，同一条草稿在另一个模式看不到；且它属「有损数据」，被「重置界面状态」清掉就是真丢。
- ✅ 草稿带 meta（`kind`/`version`/`base_updated`/`saved`）：丢不起的数据**不静默降级**，格式不符时留痕并返回 null；`base_updated` 用于检测「草稿期间任务被外部改过」。
- ✅ 草稿写完即「提交/取消」，必须在保存与取消时显式清除，否则草稿会盖住新数据。

### 任务目录所有权分层（`.diy/`）

```
$DIY_HOME/projects/<pid>/tasks/<tid>/
  AGENTS.md      ← 面向用户，允许直接编辑
  .diy/**        ← 系统独占，仅 main 进程经 RPC 写入，不承诺格式稳定
```

- 路径单一出口：`core/state.ts` 的 `taskSystemDir(uri)`，禁止各处拼字符串。
- 用点前缀而非 `data/`：`ls` / shell 通配 / Finder 默认跳过 dotfile（用户脚本不会误吞系统文件）；仓库已有先例 `.diy/ref.lock.yaml`；`$` 前缀（如 `$data`）在 shell 里会展开，是事故隐患。
- 生命周期随任务目录：`deleteTask` 已是 `rmSync(dir, {recursive:true})`，草稿自动随删（有测试锁定）。
- 扫描安全：`listTasks` 按 `^\d+$` 过滤、`taskTree.scanAllDirs` 见 `AGENTS.md` 即停 → 任务目录内多一个 `.diy/` 不会被误认成任务。
- ⚠️ renderer **永不直接写文件**，一律经 RPC（`diy.task.drafts.*`）。

### 避免 Solid 陷阱：`<Show>` 内组件读 props 的卸载清理

`TaskInfoView`（详情编辑）被 `keyed` 的 `<Show>` 包裹。**`onCleanup` 里读 `props.task` 会抛
`Stale read from <Show>` 并中断 props 更新**（表现为切任务后面板显示上一个任务的标题）。
需要「卸载前落盘」这类副作用，一律放在面板级组件（`TaskDetailPanel`）里做，它读的是
`taskStore.selectedUri` 这类普通信号，不经过 Show 的派生 props。

### 样式策略

- ✅ daisyUI 主题类管组件外观（card/modal/drawer/menu/chat）
- ✅ 布局/间距仍用 Tailwind（`flex-1`/`w-56`/`absolute` 等）
- ✅ 自定义色用 `diy-` 前缀，在 `@theme inline` 块末尾追加（例 `--color-diy-state-pending` → `bg-diy-state-pending`）
- ⚠️ **主题不得回落到 `prefers-color-scheme`** —— Playwright 的 `colorScheme` 默认值是 `"light"`，attach CDP 时会覆盖系统外观把界面刷白（实测 `renderer_solid/index.css` 的 `dark --prefersdark` 会让 CDP attach 后界面闪白）；应改成 `dark --default` 或用 `data-theme` 显式锁定
- 注意 daisyUI drawer 需渲染 `<input class="drawer-toggle">`，漏了侧栏 `visibility:hidden` 消失

### 提示词模版与试验场（`template.*`）

| 关注点 | 位置 / 约定 |
|--------|-------------|
| 内置模版唯一真相源 | `src/main/prompts/defaults.ts`（TS 常量，非 .md 资源；三处消费：CLI/RPC/打包） |
| 注册表 + 装配 | `src/main/services/prompt-registry.ts`（`assembleSystem` 是**真发与预览的唯一入口**） |
| 类型契约唯一源 | `src/shared/prompt-schema.ts`（zod；api-def 的 output schema 与 renderer 类型都从这里取） |
| URI 解析唯一源 | `src/shared/task-uri.ts`（main 与 renderer 共用，禁止各自写正则） |
| 工作目录唯一源 | `src/main/core/cwd.ts`（工具 cwd 与提示词里的「工作目录」同源；三级兜底 + note） |
| 项目级覆盖落位 | `$DIY_HOME/projects/<pid>/template/<relpath>` + `.meta.yaml{relpath:{baseVersion}}`（原子写） |
| AGENTS.md 链上界 | **$HOME 为止**（不进 `/`、不进 `/Users`）：`~/AGENTS.md`、`~/git/AGENTS.md` 这类用户全局规则逐层生效；不在 $HOME 下时只取工作目录自身一层 |
| 预算 | `clamp(模型上下文窗口 × 4B × 5%, 16KB, 64KB)`（随模型变，不再是一个 64KB 魔法数）；超限拒发（不截断）；**早退也必须闭合轮次**（stop + `noteTurnEnd` + turn-end 审计） |
| 试验场页面 | `PromptLabV4Page.tsx`（左栏 = 模板 / 可用变量（契约）/ 变量值（本次注入）/ 结构树（trace）；右栏 = 预览；`ui page navigate lab` 落 agent调参 tab）；草稿按 project 分桶存 `Caches.diy_lab_drafts` |
| 试验场两块编辑器 | **同一实现同一外观**（`MdEditor` = CodeMirror 6）：左边模版编辑器（markdown 高亮 + 可编辑性随锁定状态）与右边「系统上下文预览」（`plain` + `editable={false}`）都有**行号**、都**不自动折行**（长了横向滚：折行会让「第几行」对不上行号）。高亮也是同一套（CM decoration），预览侧区间来自 trace 的 `out` |
| 试验场刷新 | 顶栏「⟳ 刷新」= 全页面重拉（任务树 → 模版列表含覆盖/过期状态 → 强制重算预览）。**debug UI 用显式刷新代替事件流**：外部改了模版文件、CLI 建了任务，界面不会自己变（实测确认），按一下刷新即可；未保存草稿与高亮选区保留（选区只存身份，重算后自动跟随） |
| 试验场高亮联动 | 点结构树行 → 高亮**模版那段源码**（区间相对所属模版 body）+ **预览那段产出**；点「可用变量」的变量名 → 高亮它在当前模版的**所有出现处** + 预览里所有解析它的节点产出；再点一次取消。区间由引擎给（`TraceNode.src/out`、`analyze().paths[].end`），UI 只存"身份"（结构树 key 链 / 变量路径）并按最新 trace 重算 → 草稿重算后选区跟着走。include 节点自己的 `src` 属于**调用方**文件，只有它的子节点才换成被调模版 |
| 试验场表格列宽 | 三张表（vars/vals/trace）列宽是 **px 且可拖**（`Th` 右边缘把手，双击复位），存 `Caches.diy_lab_cols_*`。**列宽与容器宽度解耦**：拖左栏不改列宽；表比可视区宽时由左栏出横向滚动条（卡片必须 `min-w-full w-max` —— 用 `overflow-hidden` 会把超宽表格直接裁掉且不出滚动条） |
| 变量契约与值 | `src/shared/prompt-schema.ts` 的 `AssembleGlobalsSchema`（zod 单一真源）→ `src/shared/var-tree.ts` 两种派生：`buildVarTree`（树形展示）/ `flattenVars`（引擎静态校验）；实际值随预览下发 `values`（结构树「值」列与「变量值」view 同源） |
| 中断文案 | `_guard.md` **不得**复述 `INTERRUPTED_TOOL_NOTICE` —— 那段话的唯一来源是 `local-blocks.ts` 的常量 |
| 意图测试 | `tests/cli.intent.template.test.ts`（list/get/save/restore/拒绝/preview/超预算闭合） |

#### 系统上下文**全模版化**：每一段结构都能在模版里找到

| 装配结果里的位置 | 来自哪里 |
|------------------|----------|
| 裸文本身份段 | `identity.md`（不包标签） |
| `<diy>` 段 | `diy.md` |
| `<project_context>` 段 + 链上**每个** AGENTS.md 的包裹 | `project.md`（链的包装格式就在这一份里：`:for={{chain}}` 循环体自带收尾空行） |
| `<task>` 段 | `task.md` |
| `<rules>` 段 | `rules.md` |
| `<skills>` 段 | `skills.md`（skills 为空 → 整节不进请求） |
| `<guard>` 段 | `_guard.md`（锁定） |
| 变量值（`diy.*` / `project.*` / `task.*` / `cwd.*` / `chain` / `skills`） | 运行时事实（`assembleGlobals` 注入；契约 = `AssembleGlobalsSchema`） |
| 节序 / 空节跳过 / 预算判定 / 未注入告警 | 装配器行为（节序 = `_system.md` 的 include 顺序） |

- 模版 8 份，`_` 前缀 = 锁定（`_system.md` 装配入口、`_guard.md` 保命契约）；**没有"片段"角色**：链的包装
  原来是独立片段 `chain.md`，现在直接写在 `project.md` 里（少一份文件、少一层参数传递）。
- frontmatter 字段：`title` / `desc` / `version` / `locked?` / `lockTip?`；包裹标签由 UI 从正文首行 `<tag>` 推断，
  `role`（entry/section）由入口 include 列表推导 —— 三者都不需要手工维护，避免两处漂移。
- 排版规则（改模版前必读，写在 `src/main/prompts/defaults.ts` 头注）：控制标记可自由缩进（独占一行不产出字符）；
  **输出文本必须顶格**（行首缩进会进提示词）；空行是内容。

### UI 验证（两层，互补）

- **`diy.ui.*`（handler 层）**：CLI 经 RPC 直接调 renderer 的共享入口函数（与按钮 onClick 同一批）。测行为/契约/状态，稳定适合 test:intent 基线；**测不到真实 DOM 事件链的 bug**。
- **Playwright/CDP（真实事件层）**：Electron 开 `--remote-debugging-port`，Playwright `connect_over_cdp` 复用，用**真实鼠标事件**（mouse.move/down/up 分步）驱动真实 renderer。能抓 gesture bug（拖拽整屏被拖出、isDropTarget 高亮、点穿透、折叠状态），是目前唯一的验证手段——UI 交互改动后跑一遍。
- `diy.ui.inspect`：renderer 内 DOM 遍历生成无障碍树，agent 可 `./diy.sh ui inspect` 看 UI 全貌。
- **跑意图测试 / CDP 夹具前，shell 里不要 export `DIY_PORT` / `DIY_HOME`**：`ShellTest` 继承 `process.env`，
  被污染的 `DIY_PORT` 会让测试里的每一条 `./diy.sh` 都去打**别的端口**，各拉一个新 app，与测试自己启的实例
  互踢（单实例锁）→ 现象是"页面状态莫名漂移、CDP 会话反复掉线、模板列表忽空忽有"（实测踩了两小时）。
  正确姿势：`env -u DIY_PORT -u DIY_HOME npx vitest run ...`，或用一个干净 shell。
- 只想临时起一个实例看界面时，注意 CLI 启动的 app 是**子进程**（父 CLI 退出后可能被带走）；CDP 会话断线先看
  进程还在不在。要长时间挂着观察，用测试夹具（`startElectronTest`）而不是 CLI 起。
- 复用冒烟脚本：**`scripts/ui-smoke/dnd-smoke.py`** — 启动隔离 Electron + Playwright/CDP 真实拖拽（任务↔任务改层级、子任务→项目提升），断言层级 + 抓 console/pageerror，`python3 scripts/ui-smoke/dnd-smoke.py` 运行，exit 0 通过。UI 交互改动后跑它确认手势没破坏。

### 交互自动化操作 App（agent 自测/演示用，实测经验）

目标：让 agent 用 CLI 驱动真实界面做自测或演示。以下每条都是实测踩出来的。

**提速是第一原则**：每次 `playwright-cli <cmd>` 都是独立进程冷启动（≈1~3s，内部还有固定
500ms 稳定等待），逐条敲一个流程要几十秒。**把整个流程压进一次 `eval`**（async IIFE +
`setTimeout` 等待 + 返回 JSON）——同一套「打开面板 + 三态切换 + 命中自检」从 ≈40s 降到 4s。

```bash
playwright-cli attach --cdp=http://127.0.0.1:<port>      # 会话默认名 default，后续用 --s=default
playwright-cli --s=default eval "async () => { ... return JSON.stringify(R); }"
```

- ❌ **attach 模式下不要用 `goto`**：CDP 附加态不支持 `Target.createTarget`，一次 `goto` 就
  把会话打坏（后续报 `Protocol error (Target.createTarget): Not supported`），必须重新 attach。
  换页/重载用 `reload`。
- ✅ **断言靠 `eval` 读 DOM，别靠截图**：截图要人眼看，`eval` 直接拿布尔/计数。
- ✅ **点击前做命中自检**（抓「按钮溢出被相邻元素盖住」这类 bug 的唯一手段）：

```js
const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'MD 渲染');
const r = b.getBoundingClientRect();
document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b;  // false = 被盖住/溢出
```

  真实案例：`MD 渲染` 的 `rect.x=1287` 已溢出视口，点它的坐标实际命中旁边的
  `清空本对话历史消息` —— 用户「点渲染变成删历史」的物理成因。修法是工具栏 `flex-wrap`
  + 危险按钮 `shrink-0` 并与显示方式组用竖线分隔。
- ⚠️ `elementFromPoint` 只测坐标命中；要测**真实手势链**（拖拽、拖出、hover）仍用
  `mouse.move/down/up` 分步（见 `scripts/ui-smoke/dnd-smoke.py`）。
- ⚠️ 键盘要用 `playwright-cli press Escape`（真实事件）；`document.dispatchEvent(new
  KeyboardEvent(...))` 只是合成等价物，能验证监听链但不能替代真实按键验收。

**配套：造演示/回归数据（不连真实 LLM）**

- 会话历史直接写 op 流即可：`$DIY_HOME/local/<keyOf(uri)>.ops.jsonl`；UI 与续聊都从它重放。
- `keyOf(uri)` = `uri` 字符净化后前 64 字符 + `-` + `sha256(uri)` 前 12 位（`local-agent.ts`），
  例：`projects/1/tasks/1` → `projects_1_tasks_1-9975ff48c629`。
- 造完先 fold 自检，别让 UI 当调试器：`new BlockStore()` 逐行 `apply`，断言 `issues.length === 0`。
- 要覆盖 Markdown/长文本/工具过程的渲染，就给 `text` 块塞含标题/表格/代码块/粗体的正文。
- CLI 的 project/task 子命令**走 RPC，必须先有 app 实例在跑**（冷启动 10s+，超时给 60s）；
  没有实例时会直接超时退出，不是命令写错。

**隔离与清理**

- 起隔离实例必须用**全新 `DIY_HOME`**（`mktemp -d`）并 `export HOME=$H DIY_HOME=$H`：
  `SingletonLock` 写在 `electron_user_data/` 下（内容是 `hostname-pid`），**残留实例会抢锁**，
  新实例会打印 `SingleInstanceLock: failed (second instance, quitting)` 后直接退出。
  撞锁时最省事的做法是换一个新 home，别去动别人的进程。
- ⚠️ **agent 起的进程会继承宿主 main 的进程组**（`pgid` 与 diy 自身相同），于是收尾
  `kill <自己起的实例号>` 会命中 bash 自杀护栏被拒（判据见 `main/services/agent-guard.ts`
  的 `collectSelfInfo`：同 pgid、或命令行含 `out/main/index.mjs`，都算「自身进程树」）。
  **不要绕过护栏**：把「要收掉的实例号 + 用途」列给用户，由用户手动收。
- 演示数据一律落 `/tmp`，不要写进用户的 `~/.diy`。

**Solid 渲染的连带陷阱**（UI 自动化时最容易误判成"功能没生效"）

- 组件函数体里的 `if (props.x) return A; return B;` **对 props 变化不响应**（函数体只执行一次）。
  现象：点按钮后 DOM 纹丝不动，切任务/重载后才生效。必须用 `<Show when={...} fallback={...}>`。
  注意有些地方"看着是好的"只是因为 `<For each={segs()}>` 顺手重建了节点，切 md 这类不改
  分段列表的开关就会暴露。
- HTML `autofocus` 对**动态插入**的节点无效（只在文档加载时生效）。弹窗要 `ref` + `onMount`
  主动 `focus()`，否则焦点留在原按钮上，"回车确认"会误触原按钮。
- 多个弹层各自在 `window` 上监听 Esc 会**双杀**（弹窗和它下面的面板一起关）。弹层统一
  改 `document` **捕获阶段** + `stopPropagation`。

### 取 CDP 地址

Chromium 把实际端口写入 `DIY_HOME/electron_user_data/DevToolsActivePort`（两行：端口、browser path）。

| 启动方式 | 行为 |
|---------|------|
| `./sha.sh dev` | 轮询该文件，启动日志打印完整 `attach` 命令 |
| `./diy.sh <cmd>` | 冷启动 app 时在 stderr 提示 `attach` 命令 |
| `tests/electron-test.ts` | `startElectronTest()` 返回的 `cdpUrl` 已是可直接 attach 的完整 URL |

端口每次重启都变，**禁止硬编码**，按需读取：

```bash
cat "$DIY_HOME/electron_user_data/DevToolsActivePort"    # 或 curl http://127.0.0.1:<port>/json/version
```

⚠️ **端口文件的内容不一定是当前实例的端口**：输给 `SingleInstanceLock` 的第二个实例也会先写自己的
端口再退出（同一 userData）。实测踩过：文件写 50636、真实在 50633，`attach` 直接失败 → 三个自测
agent 都被误导。**读文件后必须校验**：

```bash
curl -s --max-time 3 http://127.0.0.1:$(head -1 "$DIY_HOME/electron_user_data/DevToolsActivePort")/json/version
# 不通就换：lsof -nP -iTCP -sTCP:LISTEN -a -p <electron pid>
```

`electron-dev.mts` 已内置该校验（读到死端口会继续轮询并提示“已跳过过期的端口”）。

### CDP 调试陷阱

- ❌ **不要用 `playwright-cli open http://localhost:5173/`** 测 dev 界面。Vite URL 直开时
  没有 Electron preload，`window.transport` 不存在，`ChannelClientBinding` 抛
  `Cannot read properties of undefined (reading 'on')` → 白屏。要看真界面只能 attach CDP，
  或走 `./sha.sh serve`（它在 `index.html` 注入 WS transport）。
- ⚠️ `run-code` 必须传 arrow 函数：`playwright-cli run-code "async (page) => { ... }"`；
  裸语句 `await page.x()` 会 `SyntaxError`。
- ⚠️ `.playwright/cli.config.json` 的 `contextOptions` **对 attach 无效**（只对 `open`
  新建的 context 生效）。
- ⚠️ `detach` 不复位已注入的媒体仿真，它会留在 target 上；需要显式
  `page.emulateMedia({ colorScheme: 'no-override' })`。
- 📄 机制详解与可重跑证据：`scripts/cdp-colorscheme-demo.mts`（演示 Playwright 默认
  `colorScheme:'light'` 如何覆盖系统外观）。

### 窗口定位副屏

`DIY_MIRROR_DISPLAY=1` 时窗口居中到非主屏（优先 Sidecar iPad），避免遮挡开发用的主屏。
`./sha.sh dev` / `./diy.sh` / 意图测试均已默认注入；单屏环境自动回退默认定位。

### 硬性约束：子进程 stdio 的 pipe 规则

**判据不是「能不能 pipe」，而是「读端是否一定被排空」。** 两种情况会出事：

1. **pipe 了却没人读** —— 管道缓冲（约 64KB）填满后，子进程卡在 `write` 上假死，无报错
   （ACP agent stderr 曾踩中）
2. **pipe 的读端先消失** —— `detached + unref` 的 spawn（`./diy.sh` 冷启动路径）父进程一退出
   读端即关闭，子进程后续写 stderr 抛 `EPIPE` → 升级成未捕获异常 → Electron 内置处理器调用
   **同步** `dialog.showErrorBox` → 主进程事件循环冻死（表现为 RPC 与 CDP 同时无响应 +
   屏幕弹框），且不生成 `.ips`、`log show` 亦无记录

因此：

- 常驻/分离式 spawn（CLI、`./sha.sh dev`）→ 一律 `inherit` 或 `ignore`
- 测试 spawn（父进程活着的 `electron-test.ts`）→ 允许 `pipe`，但**必须挂 `data` 监听持续排空**；
  只保留有界尾部（如末 4KB）供失败诊断
- ⚠️ **不得**为了解析 `DevTools listening on ...` 而 pipe stderr —— 取 CDP 地址一律读
  `DevToolsActivePort` 文件，与 stdio 接法完全解耦

### 常驻进程可观测性

`src/main/services/diagnostics.ts` 被**三个入口共用**，各落独立日志（避免互相滚掉）：

| 入口 | 调用 | 日志 |
|------|------|------|
| Electron 主进程 | `installDiagnostics(home)` | `<DIY_HOME>/log/main.log` |
| serve 模式 | `installDiagnostics(home, "serve")` | `<DIY_HOME>/log/serve.log` |
| CLI | `installDiagnostics(home, "cli")` | `<DIY_HOME>/log/cli.log` |
| ACP agent 子进程 stderr | `createLogSink(home, "acp")` | `<DIY_HOME>/log/acp.log` |

承担三件事：

| 能力 | 说明 |
|------|------|
| 日志落地 | console 全量镜像到文件（5MB 滚动为 `.1`），终端输出不受影响 |
| EPIPE 防护 | 给 `stdout`/`stderr` 挂 `error` 监听 —— 管道断线时不再升级成 `uncaughtException` |
| 异常兜底 | `uncaughtException` / `unhandledRejection` 落文件并继续运行，**覆盖 Electron 默认模态异常框** |

```bash
tail -f build/home/log/main.log        # dev（DIY_HOME=./build/home）
grep FATAL <DIY_HOME>/log/*.log        # 只看致命错误
```

覆盖面边界（别误以为无所不包）：

- ✅ 第②层覆盖**主进程任意来源**的未捕获异常，不限于 EPIPE；第①层只管 stdout/stderr 两条流
- ❌ 渲染进程 / preload 异常**不在范围内**（TODO 见 `diagnostics.ts` 内注释）
- ❌ 原生崩溃（SIGSEGV / OOM / V8 fatal）与主动 `process.exit()` 不会留痕
- ⚠️ 未捕获异常**不会**生成 `.ips` 崩溃报告，`log show` 也查不到 —— 只有这个文件有
- ✅ 异常后进程常驻，RPC / CDP 继续可用，因此远程（Tailscale + playwright-cli）排障成立
- 📊 弹框成因的可重跑证据：仓库根 `scripts/repro-epipe-dialog.mts`（EPIPE/throw × 有无防护
  四场景矩阵，用 HTTP 探针 + 文件心跳量化事件循环冻结）。其依据是 Electron 内置处理器：
  `process.on("uncaughtException", e => process.listenerCount("uncaughtException") > 1 || dialog.showErrorBox(...))`
  —— 守卫意味着 **app 只要自注册处理器就不会弹框**，与「代码里有没有 try/catch」无关。

### ACP 协议实测注意事项

落地日志后暴露出的真实行为，写代码时按此为准（均已在 opencode 上实测）：

- **`listModels` 的 `id` 与 `name` 不是一回事**：`id` 形如 `lkeap/tc-code-latest`（传给
  `set_model` 的唯一合法值），`name` 才是 `lkeap/Auto` 这种展示名。传 name 会被拒
  `Invalid params: model not found`。
- **agent 的失败可能只出现在它自己的 stderr**，不回填 JSON-RPC error → 客户端会误判成功。
  所以 `log/acp.log` 是排查 agent 侧问题的第一入口，不是可选噪音。
- **opencode 不推 `config_option_update`**，且 `session/set_model` 响应体是 `{}`。
  因此 `currentModelId` 走「实时推送 > 本端切换记账 > 建会话快照」三级优先；
  只读快照会让 `status` 永远报旧模型。
- **子进程 stderr 必须被消费**：`stdio` 里给了 `pipe` 却无人读，64KB 缓冲填满后
  子进程在 write 上阻塞 → agent 假死且无任何报错（`AcpAgentV2` 已接 `stderrSink`）。
- **不要静默吞异常**：切模型只允许放过 `-32601`（agent 未实现该方法），其余一律冒泡并
  记日志。以前一律 `catch {}` 导致「用户以为切了，实际还在旧模型上跑」。

## Serve 模式（Web / 远程开发）

云服务器无 Electron 时，通过 `src/serve/index.ts` 启动纯 Web 服务。

### 启动

```
./sha.sh serve                    # 默认 18888
./sha.sh serve --port <port>      # 指定端口
./sha.sh serve-build              # 生产构建
```

### 架构

```
浏览器 ──WebSocket──→ http.createServer + ws.WebSocketServer
                         ↓
                      WsTransport → Server → createHandler(api)
                         ↓
                      setNotifyRenderer → wss.clients 广播
```

- HTTP 提供静态 SPA（构建产物 `out/renderer/`）
- WebSocket 承载 RPC 通信（`@diy/rpc` 协议）
- renderer 零改动：serve 在 `index.html` 注入 `<script>` 设置 `window.transport` + `window.diy.onUiCommand`
- 绑定 `127.0.0.1`，通过 Tailscale Serve 对外暴露
- ⚠️ `index.html` 在**启动时一次性读入内存**（因为要注入 WS bootstrap，见 `serve/index.ts:63`）。
  所以改完 renderer 重新 `vite build` 后，**必须重启 serve** 才生效；否则浏览器会去请求已被
  删除的旧 hash 资源，拿回 index.html 兜底页 → `Failed to load module script ... MIME type
  "text/html"` → SPA 根本不挂载（`#root` 空、body 无文本）。此时任何「页面没报错」的断言都是
  假通过，断言必须正向检查渲染出来的值。

### Tailscale 暴露

```bash
tailscale serve --bg --https 18888 http://127.0.0.1:18888
```

访问 `https://<tailscale-hostname>:<port>`（HTTPS，Tailscale 自动 TLS）。

查看当前 Tailscale 主机名：`tailscale status | grep $(hostname) | awk '{print $2}'`

访问地址：`https://<hostname>:<port>`

### 端口规划

| 用途 | 默认端口 | 说明 |
|------|---------|------|
| RPC + Web Serve | 18888 | HTTP/2（Electron）或 HTTP+WS（Serve），仅 `127.0.0.1` |
| LLM 代理 | 8000 | 内部 Fastify |
| CDP（playwright 驱动） | 随机（`--remote-debugging-port=0`） | 实际端口见 `DevToolsActivePort`，仅 `127.0.0.1` |

### 注意事项

- ❌ 永不绑 `0.0.0.0` — 会占用 Tailscale 接口 IP 导致冲突
- ✅ Tailscale Serve 自动处理外部访问 + TLS 证书
- ✅ TLS 证书如需额外配置，放 `~/.diy/`，不入项目

### 依赖管理

- `npm update --save` 保持所有依赖 latest
- 新增业务依赖（zod、js-yaml、chokidar 等）写入 `dependencies`
- 构建工具依赖（vite、typescript 等）写入 `devDependencies`（当前已 latest）

### 硬件与 Electron 兼容性约束

#### macOS 版本

- Electron 43.1.1 内含 Chrome 150，要求 **macOS 11+**（Big Sur）
- **Chromium 151+ 将要求 macOS 13+（Ventura）—— 升级 Electron 前必须确认 macOS 版本**
- 当前测试环境：macOS 12.7.6 (Monterey) ✅ 兼容 Electron 43

#### 渲染进程崩溃（已知问题：rust_png）

Electron 43 (Chrome 150) 的 Rust PNG 解码器 (`rust_png`) 存在已知 bug，
在解码 PNG 图像时触发 V8 类型断言失败 (`v8::Value::IsUint8ClampedArray()`)，
导致渲染进程 SIGTRAP (exitCode=5) 崩溃 + 白屏。

崩溃特征（lldb 确认）：
```
ud2  (V8 assertion trap)
  ← v8::Value::IsUint8ClampedArray()
  ← cxxbridge1$box$rust_png$ResultOfReader$drop  ← Rust PNG decoder
  ← Chromium render pipeline
```

**规避方式**：升级 Electron 至 44+（Chromium 151+，修复了 rust_png 问题）。
⚠️ 但 Chromium 151+ 要求 macOS 13+，当前 macOS 12 无法使用。

**诊断方法**：
```bash
# macOS 自带 lldb 可直接分析 minidump
lldb -b   -o "target create --core ~/.diy/log/crashes/pending/<uuid>.dmp"   -o "thread select 1"   -o "bt 15"
```

崩溃日志位置：
- 主进程日志：`~/.diy/log/main.log`
- Minidump：`~/.diy/log/crashes/pending/*.dmp`
- 渲染进程 console.error：`webContents.on("console-message")` → `main.log`
  前缀 `[renderer:ERROR]` 或 `[renderer:WARN]`
- agent 执行审计（write-ahead）：`~/.diy/log/agent-bash.jsonl`
- 进程退出原因：`~/.diy/log/app-exit.jsonl`

#### 被 SIGKILL 的"假崩溃"：agent 自杀（2026-09-12 实测）

现象：一对话 app 就"挂掉"（白屏），但**没有 minidump**、主进程还活着。

根因不在 Electron：本地 agent 的 `bash` 工具会执行
`ps aux | grep Electron | ... | xargs kill -9`、`pkill -9 -f electron` 这类命令，
把宿主自己的 GPU / NetworkService / Renderer 子进程杀掉（`exitCode=9` = SIGKILL），
Electron 不会自动重建 renderer → 窗口永久白屏。
触发场景：任务历史里 agent 早期为了"清理多余 Electron 实例"留下了这类命令，续聊时复现。

**关键认识：SIGKILL 捕获不到，事后补救不可能 —— 只能执行前拦截 + 执行前落盘。**

对应机制（三层，都在本节文件里）：

| 层 | 位置 | 作用 |
|----|------|------|
| 拦截 | `services/agent-guard.ts` | `judgeSelfKill()` 纯函数判定，执行前拒绝会杀死自身进程树的命令，并把替代做法回给模型 |
| 留痕 | `services/agent-audit.ts` | write-ahead：每次 bash 执行**前**落盘（task/model/cwd/command），`kill -9` 主进程也能查到最后一幕 |
| 自愈 | `src/main/index.ts` | `render-process-gone` → 节流 reload（60s ≤3 次，防崩溃循环） |

崩溃日志里的现场线索由 `crashContext(home)` 提供（最近轮次 + 最近一条命令）。

排查步骤：
```bash
# 1. 看是否有子进程被 SIGKILL
grep -E "exitCode=9|现场:" ~/.diy/log/main.log | tail
# 2. 看最后一幕命令（含被拦截的）
tail -n 20 ~/.diy/log/agent-bash.jsonl
# 3. 确认 agent 是否尝试自杀（拦截记录）
grep bash-blocked ~/.diy/log/agent-bash.jsonl
```

#### 中断的 tool 调用：必须收敛成显式终态，不能在投影时现造

发生在同一事故里的**第二条因果链**，比“杀进程”更隐蔽：

1. SIGKILL 打断的那一次 tool 调用永远收不到 `stop` → 块停在 `running`；
2. 重建 LLM 历史时（`blocksToMessages`）必须给每个 `tool-call` 配一个 `tool-result`
   （否则 ai-sdk 抛 `MissingToolResultsError`，请求根本发不出去），于是**现场合成**一条占位结果；
3. 占位文案旧版是“该调用在上一轮中断前未完成，**如有需要请重新发起**” ——
   对模型而言这就是一句“待办”。重载会话（重启 app / renderer reload）历史一字不差地重生
   → agent 重发那条命令 → 再次自杀（用户说“就算说千万不要 kill 也会挂”）
   而在 90 万 token 的历史里，用户那句禁令盖不过它。

**约定（改代码前请先读这段）：**

| 规则 | 位置 |
|------|------|
| 中断块在**新一轮开始时**收敛为终态（`patch{status:"interrupted",output}` + `stop`），**写进 ops** | `local-blocks.ts` 的 `interruptedToolPatches()`，由 `local-agent.ts` 的 `chat()` 调用并落盘 |
| 投影（`blocksToMessages`）只做**纯翻译**：用块自己的 output，不再自己造文案 | 同上 |
| 文案必须是“已结束的历史事实”，**禁止**出现“未完成 / 请重新发起 / 可重试”这类待办语 | `INTERRUPTED_TOOL_NOTICE`（唯一来源，UI 与请求共用） |
| UI 一律读显式 `status:"interrupted"`（仅兼容旧日志时才用 “未收 stop + 无轮次在跑” 去推断） | `LocalChatPage.tsx` 的 `isInterruptedToolBlock()` |
| 收敛幂等：已收敛的块不再产出 op（重载不会反复写入） | 单测 `tests/core/local-blocks.test.ts` |

为什么不能“投影时现造”（三条）：① 重载后重新生成，agent 会重复重试；
② 造出来的数据在真相源（ops）里没有对应物，UI 看不到 → 存储/界面/请求三处不一致；
③ 将来补字段或换存储时还要搬这堆逻辑。
