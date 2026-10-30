# diy-facts — 事实库内核

> 定位：**纯内核**（`src/**`：零依赖 / 不 IO / 不取时间）+ **存储层子入口**（`@diy-agent/facts/node`：读真源 / 校验 / 事务写入）。
> CLI/RPC 在消费侧（diy-app 的 `services/facts-store.ts`）；`scripts/facts-index.mts` 只是它的薄壳。
>
> 依赖方向 **`diy-app → diy-facts`**，反向不成立（落盘原语因此各自持有一份，见 `facts.find#atomic-write`）。
>
> 需求真源是测试：`tests/*.test.ts`（判据压 `tests/fixtures/real.ts` 的真样例，不编例子）。

## 正文在知识库，本节只留目录

原先写在下面的 19 条正文已整体迁进**项目知识库**（真源 `knowledge/facts/facts.yaml`，逐条带 `evidence.at: cf38b8ab:pkgs.ts/diy-facts/AGENTS.md:<行>` —— rev 钉住版本，本文件瘦身后行号仍可核）。
本文件 3.9 KB → 1.8 KB。

| 主题 | 是什么 | 条数 |
|---|---|---|
| `facts.find` | 包内定位：哪个文件管什么 / 判据归谁 / 落盘原语 | 10 |
| `facts.rule` | 硬约束：env 轴 / claim 与 id 分工 / 相交匹配 / 单一实现 / 生成物式真源 / 任务级库边界 | 10 |

**取法**（`diy facts` 任意目录可跑）：

- `diy facts brief facts.rule` — 该主题全部条目 + 每条首句，据此决定展开哪条
- `diy facts get 'facts.rule#tasklib-inherit'` — 单条完整值（要精确 claim：`<subject>#<aspect>`）
- `diy facts brief facts.*` — 全包一次拿

⚠️ **改 `src/node/**` 前至少 brief 一次 `facts.rule`** —— 尤其是 `single-impl`（判据只写一份，CLI 与 check 脚本共用 `@diy-agent/facts/node`）、`tasklib-inherit`（继承只持续到本地词表诞生）、`generated`（真源是生成物，手改格式会被下一次 submit 冲掉）。这三条破了不出红，只出难查的诡异。
