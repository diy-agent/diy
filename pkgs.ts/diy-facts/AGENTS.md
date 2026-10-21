# diy-facts — 事实库内核

> 定位：**纯内核**（零依赖 / 不 IO / 不取时间）。存储、生成器、CLI、RPC 都在消费侧（##404）。

## find — 去哪找

- `find.facts.entry` — `src/index.ts` 导出面；消费者只看这一份，别直接摸子文件
- `find.facts.scope` — `src/scope.ts` 三轴匹配 / 归一键 / 特定度
- `find.facts.resolve` — `src/resolve.ts` 读取唯一入口（悬空与冲突**显式失败**，不返回 null）
- `find.facts.index` — `src/index-build.ts` claim 表 / 反查 / 冲突 / 影响面（全由程序生成）
- `find.facts.validate` — `src/validate.ts` 未知输入 → `Fact[]`，**一次报全部问题**
- `find.facts.fixtures` — `tests/fixtures/real.ts` 取自仓库现有事实的真样例（判据压真数据，不编例子）

## rule — 硬约束

- `rule.facts.env-axis` — `scope.env` 对齐 **`DIY_ENV`**（production / development / test），**不是** `DIY_VARIANT`（prod / test / lab）：`lab` 只是 development 的一种实例形态，混用两套轴会在 lab 与 development 之间打架
- `rule.facts.claim` — 边指向 claim（`subject#aspect`），`supersedes` 指向 fact id；claim 可派生、fact id 不可派生（审计锚点，`supersedes.to` 指着它）
- `rule.facts.intersect` — 匹配是**相交**不是包含：`env: ['development','test']` 在 `{env:'test'}` 下命中（数组语义是析取，不是合取）
- `rule.facts.live` — 冲突 / 冗余只在 `review=accepted && lifecycle=active` 之间判；`superseded` 留档不算问题
- `rule.facts.no-throw` — 读取侧一律返回 `Result`（`facts/scope-no-match` / `facts/scope-conflict` 是可预期结果）；只有构造非法输入才 throw 带 code 的错误
