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
//     summary:     ← 被压掉那段的摘要（仅摘要功能启用时；背景，不是变量树）
//     runtime:     ← 易变变量树（**每轮首步全量**）
//     runtimeDiff: ← 本步**变化的原子单元** → 变更后的当前值（只列变化的）
//     user:
//       message:   ← 用户本轮真实发言（原样）
//
//   ⚠️ 头部（system 之后、历史第一条之前）**只放逐字节常量**：前缀缓存按逐字节命中，那里一有
//   每轮变的量，整段历史每轮按 cache miss 计费。`history:` 注记就是反例，已于 ##442 刀 2 删除。
//
//   **历史** user 消息（块树里的 user 块 → 投影，##422）
//     from:        ← 发言者（成员 id + 显示名）—— 多人群聊 / agent 间消息才分得清谁说的
//     user:
//       message:   ← 当时那句原话
//       ⚠️ 老消息没有 `from:` 段（块里没 speaker）⇒ 仍是**裸文本**，不造 `from: unknown`。
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
import { emitYamlTraced, renderPaths, subsetOf, toYaml } from "./render";
import type { ContextPath, ContextTreeState } from "./types";

/**
 * 信封的**总逻辑**（zod 描述不了的那部分）—— 固定话术，逐条讲清「help 描述不了的事」。
 *
 * 它是**代码**（改这段 = 改发给模型的话术）。⚠️ 但它**不参与** `WIRE_VERSION` 派生
 * （那只由 `wire.ts::WIRE_ENCODING` 的结构语义决定）。
 *
 * 【已决 · 用户 2026-10-15】信封**顶层键集不进 `WIRE_ENCODING`**：加键（`summary` / `from`）
 * 只改「给人/模型看的编排」，**不影响业务**（原子单元 hash 与投递到各容器的值都没变）——
 * 故 `WIRE_VERSION` 保持不变，免得存量 step 记录集体判「不可比」（UI 全标 incomparable）。
 * 真正该动版本的只有 `WIRE_ENCODING` 里那些**语义**（system/runtime 投递形态、hash 口径、渲染格式）。
 */
export const ENVELOPE_ABOUT = [
    "YAML 信封：顶层键只有 help / system / runtime / runtimeDiff / summary / from / user。",
    "· help = 结构说明（zod 派生）；值段只放数据，解释在 help。",
    "· system 每次全量重建；runtime 每轮首步全量，中途变了追加 runtimeDiff（以**后出现**者为准）。",
    "· **历史压缩不动变量树**（system / runtime 每次全量）：别为取值去 cat 文件或跑命令。",
    "· `from:` 只在**历史** user 消息上，说明是谁说的（不是变量树）。",
    "· `summary:` / `compact:` = 历史被压缩后**顶替旧段**的一条消息（只在压缩事件之后出现）：`summary.text` 是结论，`compact` + 偏后的 `task:` 是检索指令 —— 别当成用户新说的话。",
    "· `summary:` 是被压掉那段的结论，只做背景。`[]` / `{}` = 存在但为空（与「没有这个变量」不是一回事）。",
].join("\n");

/** 易变变量树（作为信封的 `runtime` 键；每轮首步全量） */
export const RuntimeSchema = z
    .record(z.string(), z.unknown())
    .describe("易变上下文变量树（每轮首步给**全量**；键 = 原子单元路径）");

/** 本步的变化（作为信封的 `runtimeDiff` 键；只列**变化**的原子单元） */
export const RuntimeDiffSchema = z
    .record(z.string(), z.unknown())
    .describe("本步发生变化的原子单元 → 该单元**变更后的当前值**（全量；没变的单元不列）");

/**
 * 历史摘要（作为信封的 `summary` 键；被压缩掉那段的结论）。
 *
 * 为什么是**独立顶层键**（##310 九轮，用户拍板「user.message 里不能加其他任何消息」）：
 * 摘要此前作为**一条普通 user 消息**前置 → `normalizeUserRuns` 把它并进保留首条 user 的正文，
 * 于是自动生成的内容伪装成用户原话（与压缩注记同一个坑）。凡**自动生成**的段一律有自己的顶层键。
 */
export const SummarySchema = z
    .string()
    .describe(
        "被压缩掉的那段对话的**摘要**（上一段会话的结论，由摘要模型生成；仅在摘要功能启用时出现）。" +
            "它只做**背景**：变量树的**当前值**一律看 system / runtime 段（每次全量），**不要**为取某个变量的值去翻历史。",
    );

/** 发言者（`from:` 段；只出现在**历史** user 消息上，见 ##422） */
export const FromSchema = z
    .object({
        id: z.string().describe("发言者成员 id（`agent:<名>` / `human:<名>`）—— 谁说的这句话"),
        name: z
            .string()
            .optional()
            .describe("当时的显示名（房间成员表里的名字）；**取不到就省**（不猜，不编）"),
    })
    .describe(
        "这条历史发言的**发言者**（`from` 段）：只出现在历史 user 消息上，与 `user.message` 并列（不嵌套）。" +
            "**老消息可能没有本段**（那时没记发言者）—— 没有 = 未知，不要当成「同一个人」。",
    );

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
        summary: SummarySchema,
        from: FromSchema,
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
    /**
     * `help.runtime` 要描述哪些单元 —— **必须是常量名单**（候选全集），不能是「本轮真出现的那些」。
     *
     * 为何（##442 刀 2 连带修）：help 在 system 段里，而 system 是前缀缓存的第一块。若 help 跟着
     * 「本轮存在哪些 runtime 单元」变，则 a) 可选单元首次出现/消失（`self` 首步还没有、`room.recent`
     * 没人说话就缺席）就扭一次 system；b) 实测 ##266 第一轮 system 比第二轮少一整块 `self:` 描述。
     * 描述的读者是模型（`缺席 ≠ 0`），写全反而更有用；代价只是一次性多几百字节常量。
     */
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
        summary: describeSchema(SummarySchema),
        from: describeSchema(FromSchema),
        user: { desc: key("user"), ...describeSchema(UserEnvelopeSchema) },
    };
}

/** 信封的**顶层键名**（`ENVELOPE_ABOUT` 第一行那份名单；`isEnvelopeText` 的判据也用它） */
export const ENVELOPE_TOP_KEYS = new Set([
    "help",
    "system",
    "runtime",
    "runtimeDiff",
    "summary",
    "compact",
    "from",
    "user",
]);

/**
 * 这段文本是不是**一份信封**（自占顶层键的自动生成段）？
 *
 * 判据：**首个非空行**就是信封顶层键 `<key>:`（顶格无缩进，键在白名单里）。
 * 干什么用（##421）：`normalizeUserRuns` 据此**不合并**信封消息 —— `summary:` 等自动生成段若被
 * 并进相邻 user，就又是一坨「自动生成的元数据伪装成用户原话」（##310 八轮坑）。
 *
 * 为什么不真解析 YAML：信封恒由 `toYaml` 产出、顶层键必在首行；为一次合并判断引入解析器（且失败要吞）
 * 代价不成比例。误判方向也是安全的：要么把不该分的两条 user 分开（= 现状），要么把该分的合并回去
 * （= 老行为，不新造危害）。
 */
export function isEnvelopeText(text: string): boolean {
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        if (line !== line.trimStart()) return false; // 首行缩进 ⇒ 是普通正文，不是信封
        const m = /^([A-Za-z][A-Za-z0-9_]*):(\s|$)/.exec(line);
        return m !== null && ENVELOPE_TOP_KEYS.has(m[1]!);
    }
    return false;
}

/**
 * 把若干**顶层键片段**（各自是 `k:` + 缩进正文的一段 YAML）与可选的 `user:` 段拼成**一份**合法 YAML。
 *
 * 硬规则（##310）：消息里一切**自动生成**的段（`summary:` 摘要、`runtime:` 变量树）
 * 都必须有**自己的顶层键名**，与用户真话（`user.message`）泾渭分明 —— 混进 `user.message`
 * 会被模型当成"用户的任务内容"去处理（tasks/5 实测：模型为此多烧 3 次 bash、5.6 万 prompt token）。
 *
 * 为什么不各自发一条消息：`normalizeUserRuns` 必然把相邻 user 合并（多家 provider 拒连续
 * 同角色），合并出来是「YAML + 裸文本」—— 不是 YAML 也不是对话。自己合成一份才可控。
 */
export function tailEnvelope(parts: readonly string[], userText?: string): string {
    const blocks = parts.filter((p) => p.trim());
    if (userText !== undefined) blocks.push(toYaml({ user: { message: userText } }));
    return blocks.join("\n");
}

/**
 * 把摘要渲染成信封里的一个**顶层键片段**（`summary:` 一段；空文本 → 空串 = 不投递）。
 * 见 `SummarySchema` 头注：摘要是**自动生成的段**，必须有自己的顶层键，不进 `user.message`。
 */
export function renderSummaryPart(text: string): string {
    if (!text.trim()) return "";
    return toYaml({ summary: text });
}

/** 一条发言的**发言者**（`from:` 段的值；见 `FromSchema`） */
export interface Speaker {
    id: string;
    /** 显示名（取不到就省 —— 不猜、不编，见 `FromSchema`） */
    name?: string;
}

/**
 * 历史 user 消息的 `from:` 段（顶层键，与 `user.message` **并列** —— 见 ##422）。
 *
 * 为何不用 `user.message` 前缀而另立顶层键（与 `summary:` 同一条硬规则）：
 * 自动生成 / 机器携带的段一旦写进 `user.message`，模型会把它当**用户的任务内容**去处理。
 */
export function renderFromPart(speaker: Speaker): string {
    const v = speaker.name ? { id: speaker.id, name: speaker.name } : { id: speaker.id };
    return toYaml({ from: v });
}

/**
 * 重放历史时要**剥掉**的顶层段：易变变量树（`runtime:` / `runtimeDiff:`）。
 *
 * 为什么只剥这两段（##422 用户口径）：「信封是只清理 runtime 消息，不是把所有线索性消息
 * 都丢弃，因为不是所有信封字段都是 runtime 变量」—— `from:`（谁说的）/ `summary:`
 * 哪些行）都是**线索**，重放必须留着；`runtime:` 是**每步全量的当前值**，重放只会浪费字节
 * 并把旧值伪装成现状（与 `ENVELOPE_ABOUT` 那条「历史压缩不影响变量树」同一条道理）。
 */
export const RUNTIME_TOP_KEYS: ReadonlySet<string> = new Set(["runtime", "runtimeDiff"]);

/** 顶格 `key:` 行（信封顶层键的形态；与 `isEnvelopeText` 同一把尺） */
const TOP_KEY_RE = /^([A-Za-z][A-Za-z0-9_]*):(\s|$)/;

/**
 * 这段文本里**有没有**这个顶层键段（顶格 `<key>: ...`；块标量里的同名行不算）。
 *
 * 干什么用（##422）：块里存的那段本身就是信封时（重放）要看它自己带不带 `from:` —— 带了就
 * 不重复加（同一份 YAML 里两个 `from:` 是非法重复键），没带就补到顶层。
 */
export function hasTopLevelKey(text: string, key: string): boolean {
    return text.split("\n").some((l) => TOP_KEY_RE.exec(l)?.[1] === key);
}

/**
 * 从一条**历史消息**里剥掉易变段（`runtime:` / `runtimeDiff:`），其余**逐字保留**。
 *
 * 判据（单测钉住）：
 *   · 是信封（首个非空行是顶格的信封顶层键）**且**带顶格 `user:` 段 ⇒ 才是「我们的消息形态」，
 *     动手剥；剥完 `from:` / `summary:` / `user:` 一个不少、`runtime` 一个不留。
 *   · 否则（裸文本、首行缩进、用户自己粘贴的一段 YAML 没有 `user:`）⇒ **原样返回**，
 *     逐字不变 —— 剥错用户正文比少剥一段 runtime 严重得多。
 *   · **幂等**：剥过的再剥仍是同一份字节（各层调用点重复跑也安全）。
 *
 * 为什么按行扫而不真解析 YAML：信封恒由 `toYaml` 产出（块标量必缩进，缩进行不可能被当成
 * 顶层键），为一次重放做解析器（且失败要吞）代价不成比例 —— 与 `isEnvelopeText` 同一取舍。
 */
export function stripRuntimeSections(text: string): string {
    // 不是信封（首行就是普通正文 / 首行缩进）⇒ 一字不动
    if (!isEnvelopeText(text)) return text;
    const lines = text.split("\n");
    const keys = lines.map((l) => TOP_KEY_RE.exec(l)?.[1]).filter((k): k is string => k !== undefined);
    // 不是「我们的消息形态」（没有顶格 `user:` 段）⇒ 一字不动：宁少剥，不剥用户正文
    if (!keys.includes("user")) return text;
    if (!keys.some((k) => RUNTIME_TOP_KEYS.has(k))) return text; // 没有易变段 ⇒ 一字不动（快路）
    const out: string[] = [];
    let skipping = false;
    for (const line of lines) {
        const key = TOP_KEY_RE.exec(line)?.[1];
        if (key !== undefined) skipping = RUNTIME_TOP_KEYS.has(key); // 新的顶层键 ⇒ 换段
        if (!skipping) out.push(line);
    }
    return out.join("\n");
}

/** 只拼 `runtime:` + `user:` 的常见形（见 `tailEnvelope`） */
export function appendUserKey(runtimeText: string, userText: string): string {
    return tailEnvelope([runtimeText], userText);
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
    /** help 用名单（候选全集，常量）—— 缺省 = `runtimePlaces`（单侧调用兼容） */
    helpRuntimePlaces: readonly ContextPath[] = runtimePlaces,
): EnvelopeRendering {
    const help = buildHelpDoc({ systemPlaces, runtimePlaces: helpRuntimePlaces });
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
