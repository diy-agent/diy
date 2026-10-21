# diy-facts — 事实库内核

> 定位：**纯内核**（`src/**`：零依赖 / 不 IO / 不取时间）+ **存储层子入口**（`@diy/facts/node`：读真源 / 校验 / 事务写入）。
> CLI/RPC 在消费侧（diy-app 的 `services/facts-store.ts`）；`scripts/facts-index.mts` 只是它的薄壳。

## find — 去哪找

- `find.facts.entry` — `src/index.ts` 导出面；消费者只看这一份，别直接摸子文件
- `find.facts.scope` — `src/scope.ts` 三轴匹配 / 归一键 / 特定度
- `find.facts.resolve` — `src/resolve.ts` 读取唯一入口（悬空与冲突**显式失败**，不返回 null）
- `find.facts.index` — `src/index-build.ts` claim 表 / 反查 / 冲突 / 影响面（全由程序生成）
- `find.facts.validate` — `src/validate.ts` 未知输入 → `Fact[]`，**一次报全部问题**
- `find.facts.fixtures` — `tests/fixtures/real.ts` 取自仓库现有事实的真样例（判据压真数据，不编例子）
- `find.facts.node` — `src/node/index.ts`（`loadRepo` / `checkFacts` / `checkRepo` / `submit` / `renderDoc`）：**判据的唯二消费者共用这里** —— `check` 脚本与 `diy facts submit` 落盘前的候选集校验；两条路走同一份判据，杜绝「CLI 绿、CI 红」
- `find.facts.writer` — 写入事务：整批校验全过才落盘（tmp + rename），一条不过**整批拒**且磁盘不动
- `find.facts.tasklib` — 任务级库：`--in task:<taskUri>` → `$DIY_HOME/<uri>/knowledge/`，与仓库库**同一套**判据与事务；差别只有两条（词表继承、首次写入即诞生），见 `LoadRepoOptions`

## rule — 硬约束

- `rule.facts.env-axis` — `scope.env` 对齐 **`DIY_ENV`**（production / development / test），**不是** `DIY_VARIANT`（prod / test / lab）：`lab` 只是 development 的一种实例形态，混用两套轴会在 lab 与 development 之间打架
- `rule.facts.claim` — 边指向 claim（`subject#aspect`），`supersedes` 指向 fact id；claim 可派生、fact id 不可派生（审计锚点，`supersedes.to` 指着它）
- `rule.facts.intersect` — 匹配是**相交**不是包含：`env: ['development','test']` 在 `{env:'test'}` 下命中（数组语义是析取，不是合取）
- `rule.facts.live` — 冲突 / 冗余只在 `review=accepted && lifecycle=active` 之间判；`superseded` 留档不算问题
- `rule.facts.single-impl` — **判据只写一份**：CLI 与 check 脚本都调 `@diy/facts/node`，任一侧自己再实现一遍校验 = 分叉，正是本任务要治的病
- `rule.facts.generated` — 真源是**生成物式**：条目排序 / 字段顺序 / 头注（`note` 或文件开头注释块）全由 `renderDoc` 决定 ⇒ 手工改格式会被下一次 submit 冲掉；改内容只能走 `diy facts submit`
- `rule.facts.workspace-dep` — diy-app 新增 workspace 依赖**必须**同步 `pkgs.ts/diy-app/vite.pkg-deps.ts::WORKSPACE_TS_DEPS`，否则 main 产物留裸 `import "@diy/x"`、运行时加载 `.ts` 源码直接炸（本任务实测踩中一次）
- `rule.facts.tasklib-root` — 任务级库的 `root`（证据 / `scope.paths` 的解析根）**是仓库根**，不是任务目录：任务写的事实讲的是代码仓的事（`pkgs.ts/diy-app/src/x.ts:10`），按任务目录解析会让每条证据都悬空
- `rule.facts.tasklib-inherit` — 任务级库**继承**仓库词表，且**写回只写本地的**：`loadRepo` 把「全量词表」与「本地声明的词表」分成两份（`subjects` / `localSubjects`），写回用后者 —— 混用会让第一次 `submit` 就把继承的整份词表复制成本地快照，此后仓库加 subject 任务库永远看不到（本轮实测踩中）
- `rule.facts.no-throw` — 读取侧一律返回 `Result`（`facts/scope-no-match` / `facts/scope-conflict` 是可预期结果）；只有构造非法输入才 throw 带 code 的错误
