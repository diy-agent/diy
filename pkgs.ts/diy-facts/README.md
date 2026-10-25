# @diy/facts

diy 事实库的**内核**：事实身份、作用域解析、claim 图、结构校验。零依赖、不 IO、不取时间。

## 三条粒度（别混）

| 粒度 | 形态 | 谁可派生 | 用途 |
|---|---|---|---|
| subject | `app.port` | 否（受控词表） | 描述的对象 |
| claim | `app.port#default` | **是**（查询键，重算无副作用） | 边的目标 |
| fact.id | `port.production` | **否**（审计锚点） | `supersedes.to` 指向它、证据挂在它上 |

## 用法

```ts
import { validateFacts, buildIndex, resolveClaim, affected } from '@diy/facts';

const { facts, issues } = validateFacts(parsed);        // 一次报全部问题
const index = buildIndex(facts);                        // claim 表 / 反查 / 冲突 / 结构问题
resolveClaim(facts, 'app.port#default', { env: 'test' });   // => 0（development/test）
resolveClaim(facts, 'app.port#default', { env: 'production' }); // => 18888
affected(index, ['pkgs.ts/diy-app/tests/x.test.ts']);   // => ['rule.test-bail']（复核清单）
```

## 「变体」是语义不是存储形状

真源一行一 fact，环境差异靠 `scope` 表达，读取时按上下文挑唯一值：

```yaml
- id: port.production
  subject: app.port
  aspect: default
  value: "18888"
  scope: { env: production }
- id: port.dev-test
  subject: app.port
  aspect: default
  value: "0"
  scope: { env: [development, test] }
```

不用 base + variants 嵌套：那会引入 upsert（写一条先得知道 base 在不在），
而读侧的「分组视图」由工具合并即可（`diy facts get app.port`）。

## 判定语义

- 匹配：fact 声明的轴必须在上下文里有同类声明且**相交**；上下文未声明某轴 ⇒ 该轴 scoped 事实查不到
- 优先：特定度（声明轴数）最高者胜；并列同值取其一，并列异值 = `facts/scope-conflict`
- 悬空：一条都不命中 = `facts/scope-no-match`（**不返回 null**）
- 冲突/冗余只在 `accepted && active` 之间判

## 关系（首期两种）

- `depends-on` → **claim**，可带 `when` 谓词（`serve` 例外只在 production 成立）
- `supersedes` → **fact id**，可带 `within` 范围；成环报 `facts/supersede-cycle`
