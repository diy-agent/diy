// src/shared/cut-marker.ts
// 🎯 **截断标记的唯一语法**（##425）—— 一处构造、一处解析，取代各处各写各的中文省略号。
//
// ── 病根（真实误判，不是假想）──
//   原来至少 6 处截断各有一种写法，且都不说明「谁截的 / 为什么截 / 原文还在不在」。
//   调查「会话为什么贵」时，流量页那句 `<中间省略 401174 字节（正文共 425750 字节）>`
//   被读成「任务 body 被塞了 425 KB」，实际只是**存档**只留了 head/tail，原文完整
//   （任务 body 真实 125 字节）。同一天内同类误判三次 —— 读者看到省略只能猜，猜错就是误判。
//
// ── 一条语法 + 一个必填的 `scope` ──
//   <cut by="traffic-log" scope="archive" why="capture-off" unit="bytes" total="425750" kept="24576"/>
//   <cut by="tool-output" scope="wire" why="budget" unit="lines" total="12400" kept="4000" resume="/abs/path"/>
//   <cut by="renderer-text-cap" scope="view" why="render" unit="chars" total="292890" kept="131072" resume="ui:载入全文"/>
//
//   | scope     | 含义                                        | 判据 |
//   | `wire`    | **发给模型/调用方的那份就是残缺的**            | 真截断 |
//   | `view`    | 原文完整，只是**这个视图**省略（能展开/能取回） | 显示层 |
//   | `archive` | 原文完整，只是**存档没存**（日志 head/tail）    | 记录层 |
//
//   今天的误判全部是把 `archive` / `view` 读成了 `wire`。只要 `scope` 显式写出来，
//   这类误判从根上消失 —— 所以 `scope` 是必填，且非法值**必抛**（不做静默兜底）。
//
// ── 硬约束 ──
//   · 单源：全仓 `<cut ` 的**构造点**只有本文件（`cutMarker()`）；各处只给参数，不拼字符串。
//   · 不变量：`total >= kept >= 0`（越界必抛）；`unit` 与 `kept` 同量纲（调用方负责，测试钉住）。
//   · `wire` 档 marker 要短（每条工具结果都出现，token 是真金白银）：属性名取最短可用写法，
//     `unit` 缺省 = `lines`（最常用），`bound` 只在 `total` 是**下界**时才出现。
//   · `wire` + `resume`：原提案写「`scope=wire` 时 `resume` 必须为空」，但 tool-output 的原文
//     **确实**落盘可 `read` 回取（##127 的核心能力，写成空就是主动丢掉这个出口）。两处冲突
//     以**信息真实**优先：`wire` 表示「线上这一份被裁」，`resume` 表示「原文还能从哪取回」——
//     两者正交，允许并存；`wire` 且无 `resume` 才是「真丢了」。
//   · 解析函数**同时认旧格式**（只读兼容）：旧日志里的中文标记不改写，读侧解析成同构记录
//     （`legacy: true`），据此统计/校验/展示，不必回头改历史。
//
// ── 为什么不用别的形态 ──
//   · 纯中文句子（原来这样）：无法机器解析、无法统计、无法统一校验；
//   · JSON 块：占行数，混在 markdown / 工具输出里难读；
//   · HTML 注释：会被 markdown 渲染器吞掉，模型和人都看不见。
//   （`<cut …/>` 在**走 markdown 渲染**的视图里同样有被当成 HTML 吞掉的风险 ⇒ `fence: true`
//     会包一层行内代码，让它照常可见。）

import { invariant } from "./invariant";

/** 三种截断语义（见头注的判据表）。非法值必抛 —— 这是本模块存在的理由。 */
export const CUT_SCOPES = ["wire", "view", "archive"] as const;
export type CutScope = (typeof CUT_SCOPES)[number];

/** 计量单位（与 `total` / `kept` 同一量纲；缺省 = lines） */
export const CUT_UNITS = ["lines", "chars", "bytes"] as const;
export type CutUnit = (typeof CUT_UNITS)[number];

export interface CutMarkerSpec {
    /** 谁截的：模块 id（`tool-output` / `traffic-log` / `renderer-text-cap` / `history-compact` …） */
    by: string;
    /** 语义（三值，必填） */
    scope: CutScope;
    /** 为什么截：`budget` / `capture-off` / `render` / `window` …（机器码，短） */
    why: string;
    /** 原文总量 */
    total: number;
    /** 实际保留量 */
    kept: number;
    /** 量纲（缺省 `lines`） */
    unit?: CutUnit;
    /** 原文/全文从哪取回（路径、`ui:载入全文`、`llm.jsonl`…）；真丢了就不给 */
    resume?: string;
    /** `total` 只是**下界**（流式大块数不出精确行数时用，见 chat-text 的 `exact=false`） */
    lowerBound?: boolean;
    /** 呈现层用：包一层行内代码，避免 `<cut …/>` 被 markdown 的 HTML 分支吞掉 */
    fence?: boolean;
}

/** 解析结果：`index` = 在文本里的起始偏移；`legacy` = 旧格式（中文标记） */
export interface CutMarker extends CutMarkerSpec {
    unit: CutUnit;
    index: number;
    /** 原文里那一段（`text.slice(index, index + length)`）——旧格式没有 `length` 语义，故一并给 */
    raw: string;
    /** 旧格式（只读兼容）：字段是从中文句子里**推**出来的，不是构造出来的 */
    legacy?: boolean;
}

/** 属性值转义：`&` 先转，避免把转义出来的 `&quot;` 再转一遍 */
function esc(v: string): string {
    return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unesc(v: string): string {
    return v.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// 构造期的硬校验一律走 `invariant`（`rule.err-triage`：新增 throw 必须带 code；
// 写错 spec 是**我方缺陷**，不是用户输入，所以归 `agent/invariant-*`）：
//   · scope 非法 / total < kept 静默放过 ⇒ 一个「看起来正常但语义反了」的标记就进了历史，事后没法查。
function assertCount(name: string, n: number): void {
    invariant(Number.isFinite(n) && Number.isInteger(n) && n >= 0, "agent/invariant-cut-count", `${name}=${String(n)}`);
}

/**
 * 构造一条截断标记（**全仓唯一构造点**）。
 *
 * 抛错的三件事（都是「静默写错就再也查不出来」的类型）：
 *   · `scope` 不在三值里 / `by` / `why` 为空；
 *   · `total < kept`（不变量：被保留的不能比原文还多）；
 *   · `total` / `kept` 不是非负整数。
 */
export function cutMarker(spec: CutMarkerSpec): string {
    const { by, scope, why, total, kept, unit, resume, lowerBound, fence } = spec;
    invariant(!!by, "agent/invariant-cut-by", "by 必填（谁截的）");
    invariant(!!why, "agent/invariant-cut-why", "why 必填（为什么截）");
    invariant(
        CUT_SCOPES.includes(scope),
        "agent/invariant-cut-scope",
        `scope=${String(scope)}（须 ${CUT_SCOPES.join(" | ")}）`,
    );
    invariant(unit === undefined || CUT_UNITS.includes(unit), "agent/invariant-cut-unit", `unit=${String(unit)}（须 ${CUT_UNITS.join(" | ")}）`);
    assertCount("total", total);
    assertCount("kept", kept);
    invariant(total >= kept, "agent/invariant-cut-total", `total(${total}) < kept(${kept})`);

    const parts = [`by="${esc(by)}"`, `scope="${scope}"`, `why="${esc(why)}"`];
    if (unit && unit !== "lines") parts.push(`unit="${unit}"`); // lines 是缺省，不写
    if (lowerBound) parts.push(`bound="lower"`);
    parts.push(`total="${total}"`, `kept="${kept}"`);
    if (resume) parts.push(`resume="${esc(resume)}"`);
    const tag = `<cut ${parts.join(" ")}/>`;
    return fence ? `\`${tag}\`` : tag;
}

/** 属性解析：`k="v"`，值里的 `>` 已转义，故可以安全地先切 `>` */
const ATTR_RE = /([a-zA-Z][\w-]*)="([^"]*)"/g;

/** 新格式：`<cut … />`（容忍空格 / XML 自闭合写法） */
const TAG_RE = /<cut\b([^>]*?)\/?>/g;

/**
 * 解析文本里的**全部**截断标记（新格式 + 旧中文格式，后者 `legacy: true`）。
 *
 * 只读兼容：旧格式不改写、不重新生成，只**认出来**并给出同构字段（`scope` 是按语义推的，
 * 见 `LEGACY` 表）。解析永不抛错（脏数据不该把展示/统计打挂），认不出的段直接跳过。
 */
export function parseCutMarkers(text: string): CutMarker[] {
    const out: CutMarker[] = [];
    collectTags(text, out);
    collectLegacy(text, out);
    out.sort((a, b) => a.index - b.index);
    return out;
}

function collectTags(text: string, out: CutMarker[]): void {
    TAG_RE.lastIndex = 0;
    for (;;) {
        const m = TAG_RE.exec(text);
        if (!m) break;
        const attrs: Record<string, string> = {};
        ATTR_RE.lastIndex = 0;
        for (;;) {
            const a = ATTR_RE.exec(m[1] ?? "");
            if (!a) break;
            attrs[a[1]!] = unesc(a[2] ?? "");
        }
        const scope = attrs["scope"] as CutScope | undefined;
        const total = Number(attrs["total"]);
        const kept = Number(attrs["kept"]);
        // 形状不对的标签不是「我认得的 marker」：跳过，不猜（猜出来的值比没有更危险）
        if (!scope || !CUT_SCOPES.includes(scope)) continue;
        if (!Number.isFinite(total) || !Number.isFinite(kept)) continue;
        const unit = (attrs["unit"] ?? "lines") as CutUnit;
        const rec: CutMarker = {
            by: attrs["by"] ?? "unknown",
            scope,
            why: attrs["why"] ?? "unknown",
            total,
            kept,
            unit: CUT_UNITS.includes(unit) ? unit : "lines",
            index: m.index,
            raw: m[0],
        };
        if (attrs["resume"]) rec.resume = attrs["resume"];
        if (attrs["bound"] === "lower") rec.lowerBound = true;
        out.push(rec);
    }
}

/** 千分位数字（旧格式里 `1,024` 这种写法全部按十进制解析） */
const num = (s: string | undefined): number => Number((s ?? "").replace(/,/g, "")) || 0;

/**
 * 旧格式 → 同构记录（只读兼容）。每条都按**当时的真实语义**给 `scope`：
 *   · 工具结果 `中间省略 … 完整输出见 <path>` → `wire`（线上那份被裁）+ `resume=path`；
 *   · 流量存档 `<中间省略 … 字节（正文共 … 字节）>` → `archive`（存档没存）；
 *   · 渲染端 `……已省略 N 字符（全文 M 字符；界面只保留头尾两段）……` → `view`；
 *   · 行内预览 `… 省略 N 行 …` / `⋯ 已折叠 N 行 …` → `view`。
 * 顺序 = 匹配到的先后，由调用方统一按 `index` 排序。
 */
const LEGACY: { re: RegExp; make: (m: RegExpExecArray) => Omit<CutMarker, "index" | "raw" | "legacy"> }[] = [
    {
        // [... 中间省略 8400 行 / 210.0 KB，完整输出见 /abs/path ...]
        re: /\[\.\.\. 中间省略 (\d+) 行 \/ [^，\]]*，完整输出见 ([^\]]+?) \.\.\.\]/g,
        make: (m) => ({
            by: "tool-output",
            scope: "wire",
            why: "budget",
            unit: "lines",
            total: num(m[1]),
            kept: 0, // 旧格式只记省略量，没记保留量 —— 0 是「未知」的显式写法，别编
            resume: m[2],
        }),
    },
    {
        // [... 中间省略 8400 行 / 210.0 KB，完整输出已省略 ...]
        re: /\[\.\.\. 中间省略 (\d+) 行 \/ [^，\]]*，完整输出已省略 \.\.\.\]/g,
        make: (m) => ({ by: "tool-output", scope: "wire", why: "budget", unit: "lines", total: num(m[1]), kept: 0 }),
    },
    {
        // [输出已省略（只留调用）：8400 行 / 210.0 KB，完整输出见 /abs/path]
        re: /\[输出已省略（只留调用）：(\d+) 行 \/ [^，\]]*，完整输出见 ([^\]]+?)\]/g,
        make: (m) => ({
            by: "tool-result-callpath",
            scope: "wire",
            why: "budget",
            unit: "lines",
            total: num(m[1]),
            kept: 0,
            resume: m[2],
        }),
    },
    {
        // [… 推理省略 12000 字符 …]
        re: /\[… 推理省略 (\d+) 字符 …\]/g,
        make: (m) => ({ by: "reasoning-clip", scope: "wire", why: "budget", unit: "chars", total: num(m[1]), kept: 0 }),
    },
    {
        // <中间省略 401174 字节（正文共 425750 字节）>  —— 流量存档（最危险的那一类）
        re: /<中间省略 (\d+) 字节（正文共 (\d+) 字节）>/g,
        make: (m) => ({
            by: "traffic-log",
            scope: "archive",
            why: "capture-off",
            unit: "bytes",
            total: num(m[2]),
            kept: Math.max(0, num(m[2]) - num(m[1])),
        }),
    },
    {
        // ……已省略 292890 字符（全文 425750 字符；界面只保留头尾两段）……
        re: /……已省略 ([\d,]+) 字符（全文 ([\d,]+) 字符；界面只保留头尾两段）……/g,
        make: (m) => ({
            by: "renderer-text-cap",
            scope: "view",
            why: "render",
            unit: "chars",
            total: num(m[2]),
            kept: Math.max(0, num(m[2]) - num(m[1])),
            resume: "ui:载入全文",
        }),
    },
    {
        // … 省略 120 行 … / … 至少省略 120 行 …
        re: /… (至少)?省略 (\d+) 行 …/g,
        make: (m) => ({
            by: "chat-preview",
            scope: "view",
            why: "window",
            unit: "lines",
            total: num(m[2]),
            kept: 0,
            ...(m[1] ? { lowerBound: true } : {}),
        }),
    },
    {
        // ⋯ 已折叠 120 行 · 点击展开全部正文（`≥` = 下界）
        re: /⋯ 已折叠 (≥)?([\d,]+) 行 · 点击展开全部正文/g,
        make: (m) => ({
            by: "chat-fold",
            scope: "view",
            why: "render",
            unit: "lines",
            total: num(m[2]),
            kept: 0,
            ...(m[1] ? { lowerBound: true } : {}),
        }),
    },
];

function collectLegacy(text: string, out: CutMarker[]): void {
    for (const { re, make } of LEGACY) {
        re.lastIndex = 0;
        for (;;) {
            const m = re.exec(text);
            if (!m) break;
            const rec = make(m);
            out.push({ ...rec, index: m.index, raw: m[0], legacy: true });
            if (m[0] === "") re.lastIndex++; // 零长匹配防死循环（防御性：现有模式都不会零长）
        }
    }
}
