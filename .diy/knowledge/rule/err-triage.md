---
desc: 异常三档分类的判据（defect / 已识别外部 / 未识别外部）
updated: 2026-10-25
---

## code

每个 throw 点带 `code`（`<域>/<kebab-case>`，域 = `llm|fs|net|rpc|agent|db|ui`），UI / 日志 / issue **三处同一个 code** 才能按频次统计「哪类 unknown 最该被识别」；**新增 throw 无 code 由 `scripts/check-error-code.sh` 拦**（挂 `./sha.sh check`），存量按 `LEGACY_THROW_BASELINE` 逐文件钉数**只减不增** —— 不做全仓机械补码（会造出 `app/internal-1` 这类假码污染统计）。

## defect

defect **只能由判据认领**：用 `invariant(cond, code, detail?)` 表达不变量（协议校验 / 单调性 / 非法状态转移），它一抛 `triageOf` 必判 defect；**不准为「看着严重」手工标红**，defect 也不许吞、不许降级成 unknown。

## evolve

识别度**可演化且留痕**：`ENOSPC 裸抛 → unknown` → 人裁定「环境问题」→ 开任务识别并写话术 → 上线后 `recognized`；新埋点上线**不追溯**老 unknown（历史数据不重算）。**文案与判据分离**：判据归 `error-triage.ts`，文案归 `shared/turn-end.ts` / notice 出口，渲染层不许拼句子。

## recognized

**已识别的外部问题不许当 bug**（当 bug 会让缺陷率失真、把用户训练成忽略红色）：额度 429 / 认证 401·403 / 磁盘满 ENOSPC·EDQUOT / 网络层错误码 ⇒ 固定话术 + 处置建议，不报 issue、不弹裁定，允许再现。入场门槛 = 说得出判据；**HTTP 5xx 与请求超时不算**（上游回了 HTTP 说明网络通着，那是服务端故障 ##369(模型不可用)）。

## triage

**全局异常三档，唯一分类轴 = 是不是我们已识别的缺陷**：`defect` 我方缺陷（人为界定的判据触发）/ `external-recognized` 已识别外部（说得出「啥到上限了」）/ `external-unknown` 未识别外部（既不是缺陷、也归不进任何已识别类）。**任何「错误能到达用户 / 日志 / 提示」的出口一律过 `triageOf(err)`**，判据唯一真源 `apps/diy-app/src/shared/error-triage.ts`（见包内 `find.err-triage`）。

## unknown

未识别的外部只生成**本地草稿**：拿不到码就如实写「无法判定」，**不猜、不预设是 bug**；未知异常**永不自动上报**（正文可能含路径 / 日志片段，人确认后才出网），同类第二次经人裁定后升级为 defect / recognized（留痕在 `local/` 侧，刀 2）。
