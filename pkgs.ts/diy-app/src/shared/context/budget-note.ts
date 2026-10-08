// src/shared/context/budget-note.ts
// 🎯 预算压缩的**历史索引注记**（用户 2026-10-07 目标式压缩）—— 纯函数，禁止 import node:*
//
// ── 与旧 `dropped.ts` 的区别（为什么另立一份）──
// 旧注记挂在「轮边界 + 内容轴」上：逐段列 `range/turns/tools/why`（O(被丢段)）。
// 新注记挂在「字节预算」上：只列**保留区间**（O(保留段)）—— 默认预算 3KB 时保留极少，
// 故这份注记天然比旧的小一个量级。
//
// ── 为什么只标保留位置、不逐 gap 标注（用户 2026-10-07）──
// 保留区间之间的**空隙即 gap**，行号跳号本身就说清了「这里被省了」。模型不必靠逐段标注，
// 看 `kept: [[5,8],[120,135]]` 就知道 9~119 被省；全文路径已在 system 的 `historyIndex` 节点里
// 讲过一遍（常量，不砸前缀缓存），需要时按行/按轮回取即可。
//
// ── 载体：普通 YAML 文本（同 system / runtime 变量树同一机制）──
// 用户 2026-10-07：「我们就是把格式化 yaml 作为文本内容塞到消息 content 里」。
// 于是不另造注记契约 / 内联前缀 / 自定义字段 —— 就是一段 YAML 文本。
//
// ── 字段说明走 YAML 的**元数据节点**（用户 2026-10-07）──
// 旧形态是 `# head指…` 这样的注释行；现在改成 YAML 里的结构化 `legend:`（字段名 + 一句话 +
// 是否必填），与结构化元素同投。仍**由 zod 派生**（禁手写第二真源，见 schema-doc.ts）。

import { z } from "zod";
import { fieldDocs } from "../schema-doc";

/**
 * 预算压缩注记。
 *
 * 刻意**不存** `messages`（保留条数）：它 = 各区间长度之和，存了就是冗余（D6 单一真源需避）。
 */
export const BudgetNoteSchema = z.object({
    about: z.string().describe("这条消息是什么：会话历史被压缩后的**保留位置索引**"),
    budgetBytes: z.number().describe("历史消息可占字节上限（用户给的预算）"),
    keptBytes: z.number().describe("实际保留的字节数"),
    kept: z
        .array(z.tuple([z.number(), z.number()]))
        .describe("保留的消息行号区间 [from, to]（含两端，1-based = llm.jsonl 物理行号）；区间之间的空隙即被省略"),
});

export type BudgetNote = z.infer<typeof BudgetNoteSchema>;

export function parseBudgetNote(
    x: unknown,
): { ok: true; value: BudgetNote } | { ok: false; issues: string[] } {
    const r = BudgetNoteSchema.safeParse(x);
    if (r.success) return { ok: true, value: r.data };
    return { ok: false, issues: r.error.issues.map((i) => `${i.path.join(".") || "(根)"}: ${i.message}`) };
}

export interface BudgetNoteCtx {
    /** 全文日志的相对路径（相对 $DIY_HOME） */
    file: string;
    /** 绝对路径（bash 直接可用） */
    absPath?: string;
    /** 格式说明（legend）是否已在 system 的 historyIndex 里投过 —— 投过则本注记只留数据 */
    legendInSystem?: boolean;
}

/** YAML 双引号标量（JSON 转义是 YAML 双引号转义的子集） */
function q(s: string): string {
    return JSON.stringify(s);
}

/**
 * 把注记渲染成一段可直接插进 user 消息的 **YAML 文本**。
 * 形态：`legend:`（zod 派生的字段说明，作为 YAML **数据**）+ `history:`（保留位置索引）。
 */
export function renderBudgetNote(note: BudgetNote, ctx: BudgetNoteCtx): string {
    const L: string[] = [];
    L.push("history:");
    L.push(`  about: ${q(note.about)}`);
    L.push(`  file: ${q(ctx.file)}`);
    if (ctx.absPath) L.push(`  absPath: ${q(ctx.absPath)}`);
    L.push("  retrieve:");
    L.push(`    byLine: "bash: sed -n 'A,Bp' \\"$DIY_HOME/${ctx.file}\\""`);
    L.push(`    byTurn: "bash: grep -n '\\"turn\\":\\"T\\"' \\"$DIY_HOME/${ctx.file}\\""`);
    L.push(`  budgetBytes: ${note.budgetBytes}`);
    L.push(`  keptBytes: ${note.keptBytes}`);
    L.push(`  kept: [${note.kept.map(([a, b]) => `[${a}, ${b}]`).join(", ")}]`);
    if (!ctx.legendInSystem) {
        // 字段说明（由 zod 派生）作为 YAML **数据**节点，与环境树同一种「元数据」形态
        L.push("  legend:");
        for (const d of fieldDocs(BudgetNoteSchema)) {
            L.push(`    - { name: ${d.name}, required: ${d.required}, desc: ${q(d.desc)} }`);
        }
    }
    return L.join("\n");
}
