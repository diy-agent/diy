// @diy-agent/tools/src/shell/result.ts — shell 工具的**结果头与语义档**（纯函数，无 IO）
//
// 从 apps/diy-app/src/main/services/local-agent.ts 逐字搬来（##515 第 1 步）：
// 判据真源仍是同一处，搬包没有改一个字——
//   · 结果头字段 = `BASH_RESULT_HEAD_SCHEMA`（zod）：渲染（renderBashHead）与工具描述
//     （renderFieldDocs）都由它派生，加字段只改这里；
//   · ✓/✗ 语义 = `BashRun.failed`（判据见 run.ts::runBash 头注）。

import { z } from "zod";
import { fieldNames } from "@diy-agent/context/schema/schema-doc";

/** 结局档（与宿主 `RunOutcome` 四值一一对应：ok / fail / canceled / timeout） */
export type BashRunOutcome = "ok" | "fail" | "canceled" | "timeout";


/**
 * bash 输出缓冲上限（**内存护栏，不是截断策略**）。
 *
 * 旧值是 1MB 且触顶＝**静默**截断（`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`，模型与用户都拿不到信号）。
 * 现在两件事分开：① 上限提到 32MB —— 够装下正常的大输出，好让**投递层**落盘的是**完整**原文
 * （否则「原文可回取」取回的是个半截）；② 触顶**显式**识别（见下面 err.code 分支），
 * 与成功/报错**走同一条**投递截断路径（`capToolOutput`）。
 */
export const BASH_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * bash 结果的 **YAML 头**（##419）—— **唯一真源**：渲染（`renderBashHead`）与工具 description 的
 * 字段说明都由它派生（`shared/schema-doc.ts::fieldNames / renderFieldDocs`）。加字段只改这里。
 *
 * 为什么要有头：模型和人都得**一眼看清这一步是怎么结束的**（耗时 / 超没超时 / 被杀没有 / 退出码）——
 * 以前这些信息散在正文的自然语言里，而「永挂」那几条（##419）连自然语言都没有。
 */
export const BASH_RESULT_HEAD_SCHEMA = z.object({
    ok: z.boolean().describe("是否正常结束（退出码 0，且没超时 / 没被杀 / 没因输出溢出被终止）"),
    exit_code: z.number().optional().describe("退出码；超时 / 取消 / 命令没跑起来时整行缺席"),
    duration_ms: z.number().describe("墙钟耗时（毫秒）：从 spawn 前到收尾"),
    timeout_ms: z.number().describe("本次生效的超时（毫秒）；0 = 不设超时（缺省，##454）"),
    timed_out: z.boolean().describe("是否因超时被终止"),
    killed: z.boolean().describe("是否被我们主动杀掉（超时 / 取消 / 输出溢出）"),
    truncated: z.boolean().describe("投递层是否截断了正文（超 2000 行 / 50KB）；原文可 read 回取"),
    stdout_bytes: z.number().describe("stdout 原始字节数（截断前）"),
    stderr_bytes: z.number().describe("stderr 原始字节数（截断前）"),
    cwd: z.string().describe("命令的工作目录（相对路径的基准）"),
    signal: z.string().optional().describe("子进程收到的信号名（SIGKILL / SIGTERM…），没有则整行缺席"),
});

export type BashHead = z.infer<typeof BASH_RESULT_HEAD_SCHEMA>;

/** YAML 标量：能裸写就裸写（人读友好），否则 JSON 引号转义（cwd 里的空格 / 引号 / 冒号） */
function yamlScalar(v: string | number | boolean): string {
    if (typeof v !== "string") return String(v);
    return /^[A-Za-z0-9_./~+=@-]+$/.test(v) ? v : JSON.stringify(v);
}

/**
 * 结果的 **YAML 头 + 正文原文**（##419）：`---\n<key: value>…\n---\n` 后紧跟正文，正文逐字不动
 * （模型 / 日志引用同一段文字，`read` 也能原样回取）。值为 undefined 的键**整行省略**。
 */
export function renderBashHead(h: Partial<BashHead>): string {
    const lines = ["---"];
    for (const name of fieldNames(BASH_RESULT_HEAD_SCHEMA)) {
        const v = h[name as keyof BashHead];
        if (v === undefined) continue;
        lines.push(`${name}: ${yamlScalar(v)}`);
    }
    lines.push("---");
    return `${lines.join("\n")}\n`;
}

/**
 * 投递层把 `truncated: false` 改写成 `true`（##419）。
 *
 * 为什么不在 execute 里就写好：**截断只发生在投递层**（`capToolOutput`，##127）—— execute 交给
 * ops 的那一份是原文，它本来就是完整的。所以这个位只能投递时现算；只改**头部那一行**，正文不碰。
 */
export function markBashTruncated(text: string): string {
    const end = text.indexOf("\n---\n", 4);
    if (end < 0) return text; // 没有头（不该发生）→ 原样返回，绝不改正文
    return text.slice(0, end).replace(/^truncated: false$/m, "truncated: true") + text.slice(end);
}
/**
 * bash 执行结果的**语义档**（##353：工具行 ✓/✗ 的口径真源）。
 *
 * `failed` = 这一行该画 ✗（execute 据此抛错 → SDK 发 tool-error → ops `status:"error"`）。
 * 判据只看「命令跑起来了没有」这一条主线（##332）＋「有没有错误输出」（##353 复议 ##332 ①）。
 */
export interface BashRun {
    /** 回喂模型 / 落 ops 的**完整**文本（不在这里裁：投递层 `capToolOutput` 现算，##127） */
    text: string;
    /** 是否应标失败（✗）。判据见 runBash。 */
    failed: boolean;
    /**
     * **怎么结束的**（##408 刀 5）：只给 job 账本用，`failed` 仍是工具行 ✓/✗ 的唯一判据
     * （两件事不同向：超时 / 取消都不画 ✗，但用户在 job 面板要能区分它们）。
     */
    outcome: BashRunOutcome;
    exitCode?: number;
    signal?: string;
}

/** 人类可读字节数（与 compaction 的 fmtBytes 同口径：只用于文案） */
export function fmtBytes(n: number): string {
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
}
