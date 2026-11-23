# 编译一份 / 数据根显式给：build 与 run 的重新划分（2026-11-23）

## 一、目标（用户已裁）

1. **产物只有一份**：`apps/<app>/build/prod/`。`variant` / `launch` 不再是路径维度，只作运行时标签（端口、日志、实例身份）。
2. **数据根只认显式值**：`--home` / `DIY_HOME`（diy2 为 `DIY2_HOME`）。**非生产没给就报错退出**，不推导、不回落。生产入口缺省 `~/.diy`（diy2 `~/.diy/diy2`）。
3. **路径计算只在入口脚本里**：`lab` / `staging` / `preview` 自己算好 `run/<app>/<label>` 再显式传下去，核心代码不认识「launch → home」这层映射。
4. `clean` 从此安全：`build/` 纯产物，可整删；`run/` 是数据，任何 clean 不碰。

## 二、目标形状

```
<worktree>/
├── apps/diy-app/build/prod/{main,preload,renderer,cli,serve}
├── apps/diy2/build/prod/{web,server,cli}
├── run/                        # 数据根（.gitignore；每 worktree 各一份）
│   ├── diy-app/lab/            #   electron_user_data、rooms、log…
│   ├── diy-app/staging/1/
│   └── diy2/lab/
└── build/                      # 只剩跨包中间物（tsconfig.build-all.json 等）
```

**真配置：测试实例完整依赖自己的数据根。** 查找链 = `--model-config` > `<home>/model.yaml`；
`~/.diy/model.yaml` 只剩「home 的父目录就是生产根」这一档（结构性判据，不是 mode 标签）。
entity-runtime 的 `modelConfigPath()` 删掉无 home 时的回落（返回 `undefined`）—— 否则
「换数据根只隔离了 sqlite、配置仍读生产真账号」的假隔离还在。真配置由
`scripts/seed-run-home.sh` 在**准备**阶段填进 `run/<app>/<label>/`（`./sha.sh sync` 顺带跑）：
拷而不是直读，lab 里改模型 / 存凭据才不会写生产文件。

## 三、现状证据

| 症状 | 位置 |
|---|---|
| 产物按 variant 分根 | `apps/diy-app/vite.{main,preload,renderer,cli,serve}.config.ts` 都读 `DIY_VARIANT` 拼 `build/${V}` |
| CLI spawn 按 variant 找 main | `apps/diy-app/src/cli/index.ts::variant()/mainEntry()` |
| serve 静态目录 / 数据根按 variant | `apps/diy-app/src/serve/index.ts`（`STATIC_DIR`、`resolveDevHome` 调用） |
| lab 数据根按 variant 推导 | `apps/diy-app/src/main/core/dev-home.ts::resolveDevHome` 回落 `<repo>/build/<variant>/home` |
| diy2 数据根按 launch 推导 | `apps/diy2/server/config.ts::resolveHome` 回落 `<appRoot>/build/<launch>/home` |
| 真配置投影 + 第二档查找 | 根 `sha.sh::sync-dev-home` → `build/<variant>/home`；`config.ts::launchHomeConfig` |
| diy2 入口脚本拼 launch home | `apps/diy2/sha.sh::_launch_home` → `build/<launch>/home` |
| 数据根住产物树（事故点） | `apps/diy2/build/prod/home/diy2.db`，而 `clean()` = `rm -rf ./build` |
| 根数据根住产物树 | `<repo>/build/{lab,staging}/home`（60M + 13M），根 `sha.sh clean` = `rm -rf ./build` |

## 四、任务

### T1 产物统一到 `build/prod`（diy-app 跟 diy2）

- [ ] 5 个 vite 配置：`const V = process.env.DIY_VARIANT ?? "prod"` 删除，`outDir` 写死 `build/prod/<面>`（renderer 保持 `../../build/prod/renderer`）
- [ ] `apps/diy-app/sha.sh`：`_build_dir()` → `echo "build/prod"`；`build/<variant>` 字面量全清
- [ ] `src/cli/index.ts`：删 `variant()`，`mainEntry()` → `join(appRoot(), "build", "prod", "main", "index.mjs")`
- [ ] `src/serve/index.ts`：`STATIC_DIR` → `path.resolve(ROOT, "build", "prod", "renderer")`
- [ ] `scripts/electron-dev.mts`：`outRel` → `build/prod`（仍注 `DIY_VARIANT` 作能力标签，注释说明「标签，不是路径」）
- 保留：`DIY_VARIANT` 仍参与 `autoSeedEnabled` / `runtime.ts` / 实例标签 —— 那些是**运行时能力**，不是路径

### T2 数据根：非生产必须显式

- [ ] `apps/diy-app/src/main/core/dev-home.ts`：`resolveDevHome` 改判据 —— `inherited` 空 → `throw`（带一行现成命令提示）；非空且撞生产根且未 `allowProdHome` → `throw`（不再回落）；其余透传。文件头注同步重写
- [ ] `apps/diy2/server/config.ts::resolveHome`：非生产 `explicit` 空 → `throw`；`fallback` 只在 `mode === 'production'` 存在
- [ ] 两个 app 的报错文案统一：`非生产实例必须显式给数据根：--home <dir>（或 DIY_HOME=<dir>）；生产入口缺省 ~/.diy`
- [ ] 单测：diy-app `tests/core`（resolveDevHome 四个分支：空 / 生产根 / 临时目录 / allowProdHome）；diy2 找现有 config 单测补「非生产无 home 抛错」

### T3 入口脚本：路径只在这里出现

- [ ] `apps/diy-app/sha.sh`：新增 `_run_home() { echo "$REPO_ROOT/run/diy-app/${1:-lab}"; }`
  - `lab()`：`env DIY_VARIANT=lab DIY_HOME="$(_run_home lab)" npx tsx scripts/electron-dev.mts`
  - `preview()`：home = `run/diy-app/preview`（`--from` 的源改成 `run/diy-app/<from>`）
  - `staging()`：home = `run/diy-app/staging/<slot>`
  - `test` / `test-ui` / `test-e2e`：`DIY_VARIANT=test DIY_HOME="$(_run_home test)"`（此前靠 dev-home 推导，现在必须显式）
- [ ] `apps/diy2/sha.sh`：`_launch_home` → `_run_home` 同款（`<repo>/run/diy2/<label>`）；`lab` / `staging` / `start` 全部显式 `--home`
- [ ] 根 `sha.sh`：`lab` / `agent` / 其它起实例处改用 `run/<app>/<label>` 并显式传

### T4 真配置改成「填充」

- [x] 根 `sha.sh::sync-dev-home` 删除（投影到 `build/<variant>/home` 的路径已不存在）
- [x] `apps/diy2/server/config.ts`：删 `launchHomeConfig`；`~/.diy/model.yaml` 只按「home 的父目录 = 生产根」给
- [x] `pkgs.ts/agent/entity-runtime/src/providers.ts::modelConfigPath`：删无 home 时的回落（→ `undefined`）
- [x] `scripts/seed-run-home.sh`：把 4 份真配置填充进 `run/<app>/<label>`（幂等，含 key 只落 gitignore 内）
- [x] 根 `sha.sh::sync` 调它（幂等短路之前，毫秒级）

### T5 clean / gitignore

- [ ] `apps/diy2/sha.sh::clean`：`rm -rf ./build` 保留（home 已不在里面），注释改成「只删产物」
- [ ] `apps/diy-app/sha.sh::clean`：`rm -rf ./build ./dist` 保留
- [ ] 根 `sha.sh::clean`：`rm -rf ./build` 保留（只剩中间物）
- [ ] `.gitignore` 加 `/run/`（每 worktree 一份，永不入库）

### T6 迁移旧数据（一次性，需用户确认后跑）

- [ ] 新增 `scripts/migrate-run-home.sh`：默认 dry-run 打印 `src → dst`；`--apply` 才动
  - `<repo>/build/lab/home` → `<repo>/run/diy-app/lab`
  - `<repo>/build/staging/<slot>/home` → `<repo>/run/diy-app/staging/<slot>`
  - `<repo>/apps/diy2/build/prod/home` → `<repo>/run/diy2/prod`
  - 目标非空 → 跳过并提示（不覆盖、不合并）
- [ ] 迁移完旧目录留原地，用户手动 `rm -rf`（脚本不删源）

### T7 文档与事实库

- [ ] 本 plan 落库（已在写）
- [ ] 知识库：`entry/entry.md`（数据根 / 实例三态）、`dev/*`（lab 数据根）、`tool/tool.md`（clean / build）、`find/find`（产物与数据根位置）、`sha/sha.md`（`_build_dir`/`_run_home`）
- [ ] `docs/plans/2026-11-18-diy2-dev-build-architecture.md` 顶部加「已被 2026-11-23 取代」指针

### T8 验证

```bash
cd <worktree>
./sha.sh check                                          # 两包类型 + lint
./sha.sh test-unit                                      # 单测（含新分支）
# 报错路径
apps/diy2/sha.sh web --launch lab                       # 预期：退出非 0 + 一行提示
apps/diy-app/sha.sh serve                               # 预期：同上
# 一份产物 + 显式 home
apps/diy2/sha.sh build && apps/diy2/sha.sh lab --home run/diy2/lab   # 起得来、/api/info 自报 home
apps/diy-app/sha.sh build && apps/diy-app/sha.sh lab
# clean 安全
touch run/diy2/lab/keep && apps/diy2/sha.sh clean && test -f run/diy2/lab/keep
# 产物唯一
fd -t d . apps/*/build -d 2 | sort
```

## 五、风险与约束

1. **产物一份 ⇒ 同一 worktree 内 `lab`（watch 写 build/prod）不能与 `test`/`staging --build` 同时跑** —— 会互相覆盖产物。跨 worktree 无此问题。文档写明，不引入机制。
2. **lab 的 watch 会改写 `build/prod`** —— 正在运行的 staging 实例不受影响（已加载），但重启时拿到的是 lab 的最新产物。可接受（本来就是「编译一份」）。
3. **报错退出是破坏性变更**：所有入口脚本必须在**同一提交**里补齐 `--home`，否则用户日常命令直接挂。T2 与 T3 一起验证。
4. **旧数据不再被自动看到**（路径变了）—— 必须跑 T6 迁移，否则 lab/staging 实例像新装的。这是本次唯一需要用户点头的动作。
5. 不做：`pkgs/`（已归档）、发布形态（`bin/diy2` 找产物已按 `build/prod`）、端口分配逻辑。

## 六、验收标准

- `fd -t d -d 2` 下每个 app 只有一个产物根 `build/prod`
- 任何非生产入口不给 home → 明确报错，无静默回落
- `rm -rf apps/*/build build` 之后，`run/` 数据完好
- 全部路径拼装点可数：`rg -n 'build/(lab|staging|prod|\\$\\{)' apps --type ts` 只剩 vite `outDir` 与 `buildRootOf`
