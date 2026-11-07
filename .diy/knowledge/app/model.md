---
desc: 模型 provider / 价目 / 用量口径
updated: 2026-10-22
---

## cost-override

价目**覆盖不是补丁**：`model.yaml` 的 `cost` 一旦存在就**整体**取代 spec 价（models.dev 的价也是 spec）⇒ 只填一个字段会把其余字段静默清掉（缓存读价没了 = 低估成钱）。故 CLI/服务端首次写覆盖时以 spec 价为**基线**（回执 `seededFromSpec`），`llmConfig costs` 的 `cost`/`costSource` 是改价前的必读项。档引用的 `window`/`calendar` 不存在 → **不阻断保存**，只让该档永不命中（退 base 价）+ 回执 `warnings`（`llmConfig costs` 同时下发可用的 `windows`/`calendars` 清单供选）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:152）

## model-apiface

API 面**由 npm 解析**（与 models.dev 对齐，不硬编码名单）：`provider.npm` 默认 + 模型级 `provider.npm` 覆写（opencode-go 的 gpt-5.6/6-luna 在 models.dev 里就是 `@ai-sdk/openai`）。白名单 `@ai-sdk/openai-compatible`→chat / `@ai-sdk/openai`→responses，其余 npm 的模型不出现。`providerOptions` 命名空间随面对齐（chat → `openaiCompatible` / responses → `openai`）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:149）

## model-env

`model.yaml` 的账号 `data.value` 支持 `$VAR`/`${VAR}` 展开（未定义 = **fail-fast**，不静默发空 key）；无 env 回退，账号必填。密钥**明文可**（最简单），多账号是一等公民（同一 provider 多订阅）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:150）

## model-ref

`persona.model` = **完全限定名** `account@provider/model`（按**第一个** `/` 切 provider|model —— 模型 id 自带 `/`；provider 段按**最后一个** `@` 切 account|provider）。custom provider 恒带 `custom:` 前缀（永不与 models.dev id 撞）。存量裸名不自动迁移（手工批处理）。账号名缺省 = 序号 `0`

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:148）

## model-tier

**阶梯价两条轴，别混**（`shared/usage.ts` `ratesOf`）：`tier` = 上下文档（`context`，按总输入取**最大**阈值）；`window` = 时段档（`utc-range`，按请求时刻 + 内置日历判工作日，取**按序首个命中** —— 时段是分类不是阈值）。时段价优先于上下文阶梯；`calendar` 引用不存在的日历 → 该窗**不命中**（退 base 价，绝不静默用错价）。`start`/`end` 写 ISO 8601 带偏移（`01:00:00+08:00`；**缺偏移即拒**，不默认本地时区；`end < start` = 跨零点）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:153）

## models-refresh

应用内刷新三条别改错：① 结构校验 `buildModelsSnapshot`（`src/main/core/models-snapshot.ts`）**不许比真实数据严** —— models.dev 里 `openai` 就**没有 `api` 字段**，把 `api` 写成必填等于「永远刷不进去」；真必填只有 `id` + `models`，`api`/`name`/`env` 可缺省、给了必须是对的类型（`name` 字符串 / `env` 数组）。② 失败必须**先于写盘**返回（抓取 / HTTP 非 2xx / 非 JSON / 校验失败 ⇒ `ok:false` + 原因，旧文件 **mtime 与内容逐字不变**；半成品落盘 = 静默丢价）。③ **无 diff 一律不写**（`diffSnapshot` 连价目等元数据变化也算 diff）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:147）

## persona-id

persona 引用**存 id 不存名字**：名字只是标签（可随时改），拿名字当引用键则改名 = 打断所有引用（引用者静默回落缺省人物）。理由见 `src/shared/persona.ts` 头注

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:151）

## usage-buckets

用量口径三条硬约束（`shared/usage.ts` 是唯一实现，别在别处另算）：① **思考输出是总输出的子集**，展示可拆、计价**不另加**（照抄 opencode 公式即重复计费）；② **不可测桶写 `null` 不写 0**（`api:"chat"` 面拿不到 cacheWrite，记 0 = 静默低估成钱）；③ **窗口占用取最后一步**（总输入+总输出），累加值只解释「这轮为什么贵」。单价快照随每行落盘（单价会变，历史账不能漂）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:154）
