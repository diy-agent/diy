// src/shared/context/envelope.ts
// 🎯 模型 wire 的**信封**（##310 六轮拍板）：一条消息 = 一个 YAML 文档，顶层键固定。
//
// ── 为什么要有信封（用户原话）──
//   「我同意用**统一 YAML 格式**发送消息，并**消息本身**也应该是要 zod 注册并生成的描述的」
//   「help 是代码，不更新代码版本是没办法更新的。所以放 sys 可以的」
//
// 于是两个投递位置各是一个信封：
//
//   system 参数（进 `streamText({system})`；段首全量，压缩点前不重建）
//     help:    ← **唯一的结构说明源**：zod 递归派生（`describeSchema`），禁手写
//     system:  ← 系统变量树（稳定项，全量）
//     runtime: ← 易变变量树（全量；与 system 同一条消息，见 ##442 用户 2026-10-27 口径）
//
//   **所有** user 消息（历史 / 本轮 / 轮内增量都用同一形，UI 显示 chat / notify）
//     system:   ← 控制变量增量（隐藏）：只列变化原子单元的新值；`path: null` = 单元已消失
//     runtime:  ← 同上（易变树）
//     notify:   ← 机器事件（可见）：compact / job-done
//     chat:     ← 人 / agent 发言（可见）：{ from, text }
//
//   顺序固定（模型按 YAML 顺序读）：system → runtime → notify → chat。
//   一条消息可以只有其中一段：纯控制增量没有 notify/chat（UI 不显示）。
//
//   ⚠️ 头部（system 之后、历史第一条之前）**只放逐字节常量**：前缀缓存按逐字节命中，那里一有
//   每轮变的量，整段历史每轮按 cache miss 计费。`history:` 注记就是反例，已于 ##442 刀 2 删除。
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
import { AssembleGlobalsSchema } from "./schema/prompt-schema";
import { describeSchema, pruneSchemaDoc, type SchemaDoc } from "./schema/schema-doc";
import { emitYamlTraced, renderPaths, subsetOf, subsetOfDelta, toYaml } from "./wire-render";
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
    "YAML 信封：role:system 放 help / system / runtime（全量）；role:user 放 system / runtime（增量）/ notify / chat。",
    "· system / runtime = 控制变量（UI 不显示）：全量在 system 消息里；user 里只列变化 path 的新值，",
    "  后出现者覆盖，`path: null` = 该单元已消失。数组 / map 按整单元替换，不按下标 / key 打补丁。",
    "· notify = 机器事件（UI 显示）：每项必有 kind；text / source / summary 等按 kind 带（compact 只有 source + summary）。",
    "· chat = 人 / agent 发言（UI 显示）：每项 {from, text}，from = human:<名> / agent:<名>。",
    "· 键序固定：system → runtime → notify → chat。`[]` / `{}` = 存在但为空（与「没有这个变量」不是一回事）。",
].join("\n");

/** 易变变量树（`system` 消息里是全量；`user` 消息里是增量） */
export const RuntimeSchema = z
    .record(z.string(), z.unknown())
    .describe("易变上下文变量树（全量在 system 消息；user 里只列变化 path 的新值；键 = 原子单元路径）");

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
        name: z.string().optional().describe("当时的显示名（房间成员表里的名字）；**取不到就省**（不猜，不编）"),
    })
    .describe(
        "这条历史发言的**发言者**（`from` 段）：只出现在历史 user 消息上，与 `user.message` 并列（不嵌套）。" +
            "**老消息可能没有本段**（那时没记发言者）—— 没有 = 未知，不要当成「同一个人」。",
    );

/** 用户消息（旧信封的 `user` 键；保留只为读老数据，新写入不再产生） */
export const UserEnvelopeSchema = z
    .object({ message: z.string().describe("用户本轮真实发言（原样，未加工）") })
    .describe("旧格式：用户消息（新格式请用 chat）");

/** 一条**可见发言**（`chat` 数组的元素；人 / agent 都走它）。 */
export const ChatItemSchema = z
    .object({
        from: z.string().describe("发言者：human:<名> / agent:<名>（沿用成员 id 词表）"),
        text: z.string().describe("原话（原样，未加工；多行也照原样）"),
    })
    .describe("一条可见发言");

/**
 * 一条**机器事件**（`notify` 数组的元素；UI 可见）。
 *
 * 为什么不能只是一个字符串：compact / job-done 各自带**检索与排障要用**的字段
 * （行号区间、文件路径、退出码、输出尾部）—— 拍成散文就只剩正则能读。
 *
 * 形状故意用**扁平单对象**（kind + 全部可选字段）而不是 discriminator union：
 * `help` 由 `describeSchema`（`z.toJSONSchema` + simplify）派生，union 会被压成
 * `{type:"object"}`、字段说明全丢（见 schema-doc.ts）。扁平对象能把每个字段都写进 help。
 */
export const NotifyItemSchema = z
    .object({
        kind: z.string().describe("事件类型：compact（会话压缩）/ job-done（后台进程结束）"),
        text: z.string().optional().describe("一行摘要（可省：compact 用 summary / source，job-done 用排障字段）"),
        // ── kind=compact（##442 最大精简：只有 source + summary） ──
        source: z.string().optional().describe("compact：llm.jsonl 绝对路径（逐行 = 一条消息）"),
        summary: z.string().optional().describe("compact：压缩时已生成的结论；空 = 按 source 自己查"),
        // ── kind=job-done ──
        run: z.string().optional().describe("job-done：run id（全文用 job output <id>）"),
        state: z.string().optional().describe("job-done：终态 exited / failed / killed"),
        exitCode: z.number().nullable().optional().describe("job-done：退出码；null = 无"),
        signal: z.string().nullable().optional().describe("job-done：终止信号；null = 无"),
        durationMs: z.number().optional().describe("job-done：运行时长（毫秒）"),
        command: z.string().optional().describe("job-done：启动命令首行"),
        tail: z.string().optional().describe("job-done：输出尾部（最多 20 行）"),
        truncatedBytes: z.number().optional().describe("job-done：tail 之前被截掉的字节数"),
    })
    .describe("一条机器事件（UI 可见）");

/** 信封顶层键的 zod（唯一真源；`help` 由它 + 各值段 schema 派生，见 `buildHelpDoc`） */
export const EnvelopeSchema = z
    .object({
        system: z.record(z.string(), z.unknown()).describe("控制变量增量（稳定树）：path → 新值；`path: null` = 删除"),
        runtime: RuntimeSchema,
        notify: z.array(NotifyItemSchema).describe("机器事件列表（UI 可见）"),
        chat: z.array(ChatItemSchema).describe("人 / agent 发言列表（UI 可见，按时间顺序）"),
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
        // 这里是 **role:system 消息** 里的两棵树（全量）；role:user 里的同名键才是增量，
        // 那层语义写在 `about` 里（`EnvelopeSchema.system` 的 desc 是给增量用的）。
        system: {
            desc: "系统上下文变量树（稳定项，**全量**；在 role:system 消息里）",
            ...pruneSchemaDoc(globalsDoc, opts.systemPlaces),
        },
        runtime: {
            desc: "易变上下文变量树（**全量**；在 role:system 消息里）。role:user 里的同名键只带增量",
            ...pruneSchemaDoc(globalsDoc, opts.runtimePlaces),
        },
        notify: describeSchema(
            z
                .array(NotifyItemSchema)
                .describe("机器事件列表（UI 可见）。kind=compact 压缩；kind=job-done 后台进程结束。"),
        ),
        chat: describeSchema(z.array(ChatItemSchema).describe("人 / agent 发言列表（UI 可见，按时间顺序）。")),
    };
}

/**
 * 信封的**顶层键名**（`ENVELOPE_ABOUT` 第一行那份名单；`isEnvelopeText` 的判据也用它）。
 *
 * 旧键（runtimeDiff / summary / from / user）保留：历史块里可能还存着老格式，
 * 判据必须认出它们，否则会被 `normalizeUserRuns` 合并成「YAML + 裸文本」。
 */
export const ENVELOPE_TOP_KEYS = new Set([
    "help",
    "system",
    "runtime",
    "runtimeDiff",
    "summary",
    "from",
    "user",
    "notify",
    "chat",
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

/**
 * 重放历史时要剥掉的**控制段**（新形态：`system` / `runtime` 都是控制变量；
 * legacy `runtimeDiff` 一并剥）。`notify` / `chat` / `summary` 是线索，逐字保留。
 */
export const CONTROL_TOP_KEYS: ReadonlySet<string> = new Set(["system", "runtime", "runtimeDiff"]);

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
    // 不是「我们的消息形态」（新形态看 chat / notify；legacy 看 user）⇒ 一字不动：
    // 宁少剥，不剥用户自己粘贴的 YAML（它可能刚好以 `runtime:` 开头）。
    if (!keys.includes("chat") && !keys.includes("notify") && !keys.includes("user")) return text;
    if (!keys.some((k) => CONTROL_TOP_KEYS.has(k))) return text; // 没有控制段 ⇒ 一字不动（快路）
    const out: string[] = [];
    let skipping = false;
    for (const line of lines) {
        const key = TOP_KEY_RE.exec(line)?.[1];
        if (key !== undefined) skipping = CONTROL_TOP_KEYS.has(key); // 新的顶层键 ⇒ 换段
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

/**
 * **system 信封**：`help:`（zod 递归派生的结构说明）+ `system:`（稳定树全量）+ `runtime:`（易变树全量）。
 *
 * 为什么 runtime 也在这里（用户 2026-10-27 口径，dsh 方式 B）：变量树只留一份全量，
 * 放在 system；之后 `system` / `runtime` 任何变化都只追加 user 增量（`controlDeltaEnvelope`）。
 * 于是 system 是**段首快照**，压缩点之前不重建 —— 前缀缓存命中靠它。
 */
export function systemEnvelope(
    tree: ContextTreeState,
    systemPlaces: readonly ContextPath[],
    runtimePlaces: readonly ContextPath[],
    /** help 用名单（候选全集，常量）—— 缺省 = `runtimePlaces`（单侧调用兼容） */
    helpRuntimePlaces: readonly ContextPath[] = runtimePlaces,
): EnvelopeRendering {
    const help = buildHelpDoc({ systemPlaces, runtimePlaces: helpRuntimePlaces });
    const r = emitYamlTraced({
        help,
        system: subsetOf(tree, systemPlaces),
        runtime: subsetOf(tree, runtimePlaces),
    });
    return { text: r.text, lines: { ...strip(r.lines as never, "system"), ...strip(r.lines as never, "runtime") } };
}

/** **runtime 信封**：只有 `runtime:` 一段。一个 place 都没有 → 空串（调用方据此跳过那条消息） */
export function runtimeEnvelope(tree: ContextTreeState, runtimePlaces: readonly ContextPath[]): EnvelopeRendering {
    if (runtimePlaces.length === 0) return { text: "", lines: {} };
    const r = emitYamlTraced({ runtime: subsetOf(tree, runtimePlaces) });
    return { text: r.text, lines: strip(r.lines as never, "runtime") };
}

/** 旧形（`runtimeDiff:`）—— 只为读老数据 / 兼容旧调用点，新写入用 `controlDeltaEnvelope`。 */
export function runtimeDiffEnvelope(tree: ContextTreeState, paths: readonly ContextPath[]): EnvelopeRendering {
    const sorted = [...paths].sort();
    if (sorted.length === 0) return { text: "", lines: {} };
    const r = emitYamlTraced({ runtimeDiff: subsetOf(tree, sorted) });
    return { text: r.text, lines: strip(r.lines as never, "runtimeDiff") };
}

/** `chat` 数组的元素（人 / agent 发言） */
export type ChatItem = z.infer<typeof ChatItemSchema>;
/** `notify` 数组的元素（机器事件） */
export type NotifyItem = z.infer<typeof NotifyItemSchema>;

/**
 * **控制变量增量**（user 消息里的 `system:` / `runtime:` 两段）。
 *
 * 只列**变化的原子单元**，值是变更后的新值；单元整体消失 ⇒ `path: null`（见 `subsetOfDelta`）。
 * 数组 / map 按整单元替换 —— 与 `changelog.ts` 的「原子单元、数组不下钻」同一口径。
 *
 * 顺序固定：system 在前、runtime 在后。两段都空 → 空串（调用方不注入）。
 */
export function controlDeltaEnvelope(
    tree: ContextTreeState,
    systemPaths: readonly ContextPath[],
    runtimePaths: readonly ContextPath[],
): EnvelopeRendering {
    const blocks: string[] = [];
    const lines: EnvelopeRendering["lines"] = {};
    if (systemPaths.length > 0) {
        const r = emitYamlTraced({ system: subsetOfDelta(tree, systemPaths) });
        blocks.push(r.text);
        Object.assign(lines, strip(r.lines as never, "system"));
    }
    if (runtimePaths.length > 0) {
        const r = emitYamlTraced({ runtime: subsetOfDelta(tree, runtimePaths) });
        blocks.push(r.text);
        Object.assign(lines, strip(r.lines as never, "runtime"));
    }
    return { text: blocks.join("\n"), lines };
}

/**
 * 一份 **user 信封**：控制增量 + notify + chat，按固定键序拼成一份合法 YAML。
 *
 * 为什么自己拼而不交给 `normalizeUserRuns` 合并：它有顺序语义（system → runtime → notify → chat），
 * 而 `normalizeUserRuns` 只会把相邻 user 文本粘起来（粘出来既不是合法 YAML、顺序也丢）。
 */
export function userEnvelope(parts: {
    system?: Record<string, unknown>;
    runtime?: Record<string, unknown>;
    notify?: readonly NotifyItem[];
    chat?: readonly ChatItem[];
}): string {
    const blocks: string[] = [];
    if (parts.system && Object.keys(parts.system).length > 0) blocks.push(toYaml({ system: parts.system }));
    if (parts.runtime && Object.keys(parts.runtime).length > 0) blocks.push(toYaml({ runtime: parts.runtime }));
    if (parts.notify && parts.notify.length > 0) blocks.push(toYaml({ notify: parts.notify }));
    if (parts.chat && parts.chat.length > 0) blocks.push(toYaml({ chat: parts.chat }));
    return blocks.join("\n");
}

/** 只含 `chat:` 的常见形（历史投影 / 本轮输入） */
export function chatEnvelope(items: readonly ChatItem[]): string {
    return userEnvelope({ chat: items });
}

/**
 * 把一条 `notify` 并进已有 user 信封的末尾（不新增消息）。
 *
 * 用途：预检 `tightCap` 又丢了历史时，模型必须知道；但单独 push 一条 user 会多一条消息、
 * 改前缀。并进末条 user 的 `notify` 段，键序仍是 runtime → notify → chat。
 */
export function withNotify(text: string, item: NotifyItem): string {
    if (!text.trim()) return userEnvelope({ notify: [item] });
    const block = userEnvelope({ notify: [item] });
    if (text.startsWith("chat:")) return `${block}\n${text}`;
    const at = text.indexOf("\nchat:");
    if (at >= 0) return `${text.slice(0, at + 1)}${block}\n${text.slice(at + 1)}`;
    return `${text.trimEnd()}\n${block}`;
}

/** system 的**纯数据**部分（不带 help 段）—— golden 比对 / 调试用 */
export function systemDataText(tree: ContextTreeState, systemPlaces: readonly ContextPath[]): string {
    return renderPaths(tree, systemPlaces);
}
