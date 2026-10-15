// src/shared/context/envelope.ts
// 🎯 模型 wire 的**信封**（##310 六轮拍板）：一条消息 = 一个 YAML 文档，顶层键固定。
//
// ── 为什么要有信封（用户原话）──
//   「我同意用**统一 YAML 格式**发送消息，并**消息本身**也应该是要 zod 注册并生成的描述的」
//   「help 是代码，不更新代码版本是没办法更新的。所以放 sys 可以的」
//
// 于是两个投递位置各是一个信封：
//
//   system 参数（进 `streamText({system})`；每次请求**全量重建**，不进历史 → 天然无补丁）
//     help:    ← **唯一的结构说明源**：zod 递归派生（`describeSchema`），禁手写
//     system:  ← 系统变量树（稳定项）
//
//   尾部 user 消息（不进块树/llm 历史；每轮现拼 → 不会累积）
//     runtime:     ← 易变变量树（**每轮首步全量**）
//     runtimeDiff: ← 本步**变化的原子单元** → 变更后的当前值（只列变化的）
//     user:
//       message:   ← 用户本轮真实发言（原样）
//
// ── 硬规则（用户 2026-10-15 拍板）──
//   1. `help` **只能由 zod 派生**（`desc` = `.describe()`），只允许一小段固定话术
//      （`help.about`）兜住"help 描述不了的总逻辑"。
//   2. **值节点里禁出现解释性字段**（`about` / `source` / `retrieve` / `legend` /
//      `note` / `locate` / `body` 一律取消）→ 解释上移 `help`，值只留**数据**。
//      历史遗留的反例：`historyIndex` 节点整个是解释 → 已删，内容进 `help.history`。
//   3. `system` / `runtime` 只是信封里的两个键，**不是两种格式**；顶层键增删 → help
//      自动跟着变（同一份 zod）。
//
// 约定：本文件只放纯函数/常量，禁止 import node:*（renderer 会打进包）。

import { z } from "zod";
import { AssembleGlobalsSchema } from "../prompt-schema";
import { describeSchema, pruneSchemaDoc, type SchemaDoc } from "../schema-doc";
import { HistoryNoteSchema } from "./budget-note";
import { emitYamlTraced, renderPaths, subsetOf, toYaml } from "./render";
import type { ContextPath, ContextTreeState } from "./types";

/**
 * 信封的**总逻辑**（zod 描述不了的那部分）。它是代码：改这段 = 改 wire 语义
 * （`WIRE_ENCODING` 跟着变，见 wire.ts）。
 */
export const ENVELOPE_ABOUT = [
    "本消息是一份 YAML 信封：顶层键固定为 system / runtime / runtimeDiff / user（见 help 各节）。",
    "· help 段是**结构说明**（由代码里的 zod 定义派生，随代码版本变化）——读它就知道每个键是什么、下面有哪些字段。",
    "· 值段（system / runtime / runtimeDiff / user）只放**数据**，不放解释；解释一律在 help。",
    "· system 段每次请求**全量重建**（稳定项），变更时直接以新值替换、不带历史。",
    "· runtime 段是**易变项**：每轮首步给全量；轮中途某一步变了，就**追加**一条只含 runtimeDiff 的消息（键 = 变化的单元，值 = 该单元变更后的当前值）。新旧以**后出现**的为准。",
    "· `[]` / `{}` 表示「该变量存在但为空」，与「没有这个变量」不是一回事。",
].join("\n");

/** 易变变量树（作为信封的 `runtime` 键；每轮首步全量） */
export const RuntimeSchema = z
    .record(z.string(), z.unknown())
    .describe("易变上下文变量树（每轮首步给**全量**；键 = 原子单元路径）");

/** 本步的变化（作为信封的 `runtimeDiff` 键；只列**变化**的原子单元） */
export const RuntimeDiffSchema = z
    .record(z.string(), z.unknown())
    .describe("本步发生变化的原子单元 → 该单元**变更后的当前值**（全量；没变的单元不列）");

/** 用户消息（信封的 `user` 键） */
export const UserEnvelopeSchema = z
    .object({ message: z.string().describe("用户本轮真实发言（原样，未加工）") })
    .describe("用户消息：与运行时变量变更**同处一个信封**（相邻 user 消息会被合并，故先合成一份）");

/** 信封顶层键的 zod（唯一真源；`help` 由它 + 各值段 schema 派生，见 `buildHelpDoc`） */
export const EnvelopeSchema = z
    .object({
        system: z.record(z.string(), z.unknown()).describe("系统上下文变量树（稳定项，进 system 参数，全量重建）"),
        runtime: RuntimeSchema,
        runtimeDiff: RuntimeDiffSchema,
        user: UserEnvelopeSchema,
    })
    .describe(ENVELOPE_ABOUT);

/** `help` 块的形状（递归结构文档；值全部由 zod 派生，见 schema-doc.ts） */
export interface HelpDoc {
    about: string;
    [key: string]: unknown;
}

/**
 * 造 `help` 块：**唯一的结构说明源**。
 *
 * 两个容器各给一份结构，且**按该容器实际会出现的 path 裁剪** —— 整份 globals 的结构
 * 对另一侧就是噪音，而且会说谎（"system 里有 skills"）。
 */
export function buildHelpDoc(opts: {
    /** 该容器实际投递的 path（裁剪结构用；来自投递构造，不是用户偏好） */
    systemPlaces: readonly ContextPath[];
    runtimePlaces: readonly ContextPath[];
}): HelpDoc {
    const globalsDoc = describeSchema(AssembleGlobalsSchema);
    const key = (k: keyof typeof EnvelopeSchema.shape): string =>
        (EnvelopeSchema.shape[k].description as string | undefined) ?? "";
    return {
        about: ENVELOPE_ABOUT,
        system: { desc: key("system"), ...pruneSchemaDoc(globalsDoc, opts.systemPlaces) },
        runtime: { desc: key("runtime"), ...pruneSchemaDoc(globalsDoc, opts.runtimePlaces) },
        runtimeDiff: { desc: EnvelopeSchema.shape.runtimeDiff.description },
        history: { desc: HistoryNoteSchema.description, ...describeSchema(HistoryNoteSchema) },
        user: { desc: key("user"), ...describeSchema(UserEnvelopeSchema) },
    };
}

/**
 * 把 **`user:` 段**（本轮输入）续在 runtime 信封之后，成**一份**合法 YAML。
 *
 * 为什么不各自一条消息：`normalizeUserRuns` 必然把相邻 user 合并（多家 provider 拒连续
 * 同角色），合并出来是「YAML + 裸文本」—— 不是 YAML 也不是对话。自己合成一份才可控。
 */
export function appendUserKey(runtimeText: string, userText: string): string {
    return `${runtimeText}\n${toYaml({ user: { message: userText } })}`;
}

export type { SchemaDoc };

// ══════════════════════════════════════════════════════════════════════════
// 信封的**产出**（文本 + 行号映射；真发、预览、domain 投影共用这一处）
//
// 为什么必须共用：system 一段文本有两处消费者（投递构造 `delivery.ts` 与 domain 投影
// `projection.ts`），各造一份必然漂移 —— 而它正是被断言"预览看到的字节就是发出去的字节"的东西。
// ══════════════════════════════════════════════════════════════════════════

/** 信封产出：文本 + path → 行号区间（**键与变量树 path 口径一致**，已剥掉顶层键前缀） */
export interface EnvelopeRendering {
    text: string;
    lines: Record<ContextPath, { from: number; to: number }>;
}

/** 剥掉顶层键前缀（`system.diy` → `diy`），与变量树 path 口径对齐 */
function strip(lines: Record<ContextPath, { from: number; to: number }>, top: string): EnvelopeRendering["lines"] {
    const out: EnvelopeRendering["lines"] = {};
    for (const [p, sp] of Object.entries(lines)) {
        if (p.startsWith(`${top}.`)) out[p.slice(top.length + 1)] = sp;
    }
    return out;
}

/** **system 信封**：`help:`（zod 递归派生的结构说明）+ `system:`（变量树） */
export function systemEnvelope(
    tree: ContextTreeState,
    systemPlaces: readonly ContextPath[],
    runtimePlaces: readonly ContextPath[],
): EnvelopeRendering {
    const help = buildHelpDoc({ systemPlaces, runtimePlaces });
    const r = emitYamlTraced({ help, system: subsetOf(tree, systemPlaces) });
    return { text: r.text, lines: strip(r.lines as never, "system") };
}

/** **runtime 信封**：只有 `runtime:` 一段。一个 place 都没有 → 空串（调用方据此跳过那条消息） */
export function runtimeEnvelope(tree: ContextTreeState, runtimePlaces: readonly ContextPath[]): EnvelopeRendering {
    if (runtimePlaces.length === 0) return { text: "", lines: {} };
    const r = emitYamlTraced({ runtime: subsetOf(tree, runtimePlaces) });
    return { text: r.text, lines: strip(r.lines as never, "runtime") };
}

/**
 * **本轮中途的变化信封**：`runtimeDiff:` 一段，只列变化的原子单元（值 = 变更后的当前值）。
 * 空 places → 空串（调用方据此**不注入**，不砸前缀缓存）。
 */
export function runtimeDiffEnvelope(tree: ContextTreeState, paths: readonly ContextPath[]): EnvelopeRendering {
    const sorted = [...paths].sort();
    if (sorted.length === 0) return { text: "", lines: {} };
    const r = emitYamlTraced({ runtimeDiff: subsetOf(tree, sorted) });
    return { text: r.text, lines: strip(r.lines as never, "runtimeDiff") };
}

/** system 的**纯数据**部分（不带 help 段）—— golden 比对 / 调试用 */
export function systemDataText(tree: ContextTreeState, systemPlaces: readonly ContextPath[]): string {
    return renderPaths(tree, systemPlaces);
}
