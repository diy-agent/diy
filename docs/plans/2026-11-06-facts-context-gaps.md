# facts 接入上下文的五个缺陷（2026-11-06）

调查时（用户问「facts 如何集成」）逐条读出来的。不是猜的，每条附代码位置。

## 1 · 预算裁剪只回报数字，不回报清单

```ts
// apps/diy-app/src/main/services/facts-context.ts:39
omitted: out.omitted.length,                     // 只有数字
...(out.omitted.slice(0, OMITTED_SAMPLE))        // 前 5 个 claim 名
```

模型看到 `omitted: 30` 不知道**缺的是什么**，无法判断"我要的是不是被裁了"，只能盲查。
claim 名本身很短（`app.port#default` ≈ 20 字节）—— 没理由只给 5 个。

**修法**：`omittedClaims` 给全（或给到某个字节上限），并在 help 里说明"被裁的可用 `facts get` 取回"。

## 2 · `expose: index` 的语义依赖一个 bot 没有的能力

```ts
// 注释原话：「只有 full 进正文。index 在 kb 索引里（知道有、要值就查）」
```

"要值就查"靠 `diy facts get` —— diy-app 有 RPC 直连，**bot 只有 bash**。
对 bot 而言 `index` 档等于「知道有、拿不到」。

**修法**：给 bot 一个 `facts` 工具（`get`/`brief`/`find`），而不是让它拼 bash 命令行。

## 3 · 变体在读取侧被裁掉，但写入侧需要它

```ts
// facts-context.ts:332-333
if (item.resolvedBy !== "") cell.resolvedBy = item.resolvedBy;
if (item.variants > 1) cell.variants = item.variants;   // 只是个数字
```

读场景这样做是对的（避免干扰）。**但写场景会出事**：模型想加一条 `port=9999`，
它看不到 `production=18888` 已存在，于是造**新事实**而不是给已有 claim 加变体 ——
库里多一条冲突，模型以为自己做对了。

**修法**：写入路径需要**另一套读取**（全变体可见），不能复用读投影。

## 4 · 冲突不标记，模型看到的是"确定值"

```ts
problems: [{ gid, code }]     // facts/* 错误码
```

两个 fact 在同 scope 冲突时，`resolveClaim` 选一个，投影里只出现选中的 value ——
**不带任何标记**。模型不知道这个值有争议。

对比：`omitted` 至少给了数字，冲突连数字都没有。

**修法**：冲突的 claim 在投影里带标记（如 `conflict: 2`），并说明用 `facts get` 看全部候选。

## 5 · 新鲜度完全不在投影里

`fact.verifiedAt` 由调用方传入（内核不取时间，这是对的），但 `FactsContextValue` 里
**没有任何时间字段**。三个月没验证的结论和今天刚写入的，在模型眼里一模一样。

**修法**：投影带 `verifiedAt`（或"最旧一条的天数"），让模型知道哪条该复核。
