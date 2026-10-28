// src/format/invariant.ts
// 🎯 「不变量被打破」的**唯一承载物**（从 diy-app 的 shared/error-triage.ts 原样搬来，##447）。
//
// 为什么单独成文件：`cut-marker.ts`（wire 截断标记的语法）也需要它，而截断标记被
// `@diy/context` / `@diy/compact` 共用 —— 整份 error-triage 搬不动（它牵 `TurnEndReason`
// 与 main 侧错误分流），故只把这条判据链整体搬出，error-triage 反过来从本包 re-export。
// 判据本身一字未改（见原文件头注的「三档」定义）。
// ═══════════════════════════════════════════════
//  defect：人为界定的判据（唯一承载物 = invariant）
// ═══════════════════════════════════════════════

/** code 形状：`<域>/<kebab-case>`（域清单见文件头注） */
const CODE_RE = /^(llm|fs|net|rpc|agent|db|ui)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** code 是否符合命名约定（`invariant` 的第一道防线：写错码是编程错误，当场抛） */
export function isErrorCode(code: string): boolean {
    return CODE_RE.test(code);
}

/**
 * 「不变量被打破」—— **唯一**的 defect 承载物（铁律 1：bug 只能由判据认领）。
 *
 * 与 `assert()` 的区别：它的存在本身就是「这是我方缺陷」的声明，`triageOf` 必判 `defect`，
 * 不可能被下游误判成 unknown（那正是「看着严重就标红」的反面：标注了就必须是红的）。
 */
export class InvariantError extends Error {
    /** 归一化 code（`agent/invariant-step-seq` 这类） */
    readonly code: string;
    /** 现场（值 / 步序 / 期望 → 实际），进日志与 issue 草稿 */
    readonly detail: string;
    /** 自带结论：判据随对象走，`triageOf` 不必再猜 */
    readonly triage = "defect" as const;

    constructor(code: string, detail = "") {
        super(detail ? `${code}: ${detail}` : code);
        this.name = "InvariantError";
        this.code = code;
        this.detail = detail;
    }
}

export function isInvariantError(e: unknown): e is InvariantError {
    return e instanceof InvariantError;
}

/**
 * `invariant(cond, code, detail?)` —— cond 不成立就抛 {@link InvariantError}。
 *
 * 只用来表达**人为界定的判据**（协议校验 / 单调性 / 状态机不允许的转移）。
 * **别拿它当参数校验**：用户输入不合法是 `external-*`（预期内的世界），不是我方缺陷。
 */
export function invariant(cond: unknown, code: string, detail?: string): asserts cond {
    if (cond) return;
    if (!isErrorCode(code)) {
        // 写错 code 本身是编程错误：此时再抛 InvariantError 会把「错了的码」也判成 defect，故抛裸错
        throw new Error(`[invariant] 非法 code "${code}"：须形如 <域>/<kebab-case>（域 = llm|fs|net|rpc|agent|db|ui）`);
    }
    throw new InvariantError(code, detail ?? "");
}

