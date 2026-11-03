// pkgs.ts/agent/tools/src/build.ts — `buildTools`：工具层**装配**（宿主无关的那一半）
//
// 这里只装 read / write / edit 三个工具：它们只依赖 cwd + 预算 + 可选审计回调，
// 换任何宿主（diy-app / bot / CLI）都是同一份（##514）。
//
// 不在这里的（宿主自己装配，依赖进程 / 任务身份）：
//   · `bash` / `pwsh` —— 前台/后台、进程组归属、超时杀进程、job 台账
//   · `job`           —— 后台作业系统的唯一问询口
// 壳的**拼装**（buildInvocation）与 OS 探测仍归宿主：那是平台事实，不是工具语义。

import path from "node:path";
import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { readFileWindow, formatReadOutput, READ_MAX_BYTES, READ_MAX_LINES } from "./file-read.js";
import { countsLabel, formatWriteResult, writeFileWhole, WRITE_MAX_BYTES } from "./file-write.js";
import { describeEditResult, displayPath, editFile, resolveEditablePath, withFileEditQueue } from "./file-edit.js";
import { writeFileAtomic } from "./atomic-write.js";
import type { ToolAuditEvent, ToolLimits } from "./types.js";

/** 装配上下文：**没有 taskUri / anchor** —— 任务身份由宿主的 onAudit / 上层日志补 */
export interface ToolsContext {
    /** 工作目录（相对路径的解析基准，也是 bash 的 cwd） */
    readonly cwd: string;
    /** 预算（缺省用内核常量） */
    readonly limits?: ToolLimits;
    /**
     * 执行审计回调（可选）。diy-app 传 `appendAudit(home, {...})`（自己补 taskUri）；
     * bot 不传 —— 审计是宿主的账，不是工具的。
     */
    readonly onAudit?: (event: ToolAuditEvent) => void;
    /**
     * 额外工具（宿主自己的 `bash` / `job` 等）。
     * **不得与内置工具重名**（read / write / edit）—— 重名会让内置的实现被静默顶掉。
     */
    readonly extraTools?: ToolSet;
}

/** 审计里的结果摘要上限（与宿主 appendAudit 的口径一致） */
function clip(s: string, n = 500): string {
    return s.length <= n ? s : `${s.slice(0, n)}\n…（已截断 ${s.length - n} 字符）`;
}

export function buildTools(ctx: ToolsContext): ToolSet {
    const { cwd } = ctx;
    const readMaxBytes = ctx.limits?.readMaxBytes ?? READ_MAX_BYTES;
    const audit = ctx.onAudit ?? (() => {});

    const built: ToolSet = {
        read: tool({
            description:
                "读取文件的文本内容（带行号；相对路径按项目目录解析）。" +
                `单次最多 ${READ_MAX_LINES} 行 / ${Math.round(READ_MAX_BYTES / 1024)}KB，` +
                "超限时输出尾部会给出下一段 offset —— 用 offset 继续读，不要重复读同一段。",
            inputSchema: z.object({
                path: z.string().describe("文件路径"),
                offset: z.number().optional().describe("起始行，1-based（缺省 1；续读时传上次提示的 offset）"),
                limit: z.number().optional().describe("最大行数（缺省 2000）"),
            }),
            execute: async ({ path: filePath, offset, limit }) => {
                const abs = path.resolve(cwd, filePath);
                try {
                    // 与 `diy tool read` 共用同一实现：窗口语义只有一份（见 core/file-read.ts）
                    const window = await readFileWindow(abs, abs, { offset, limit, maxBytes: readMaxBytes });
                    // style: "tool" —— 续读提示写成工具参数 offset=N（不是 shell 的 --offset）
                    return formatReadOutput(window, { maxBytes: readMaxBytes, style: "tool" });
                } catch (e) {
                    // **抛，不返回字符串**（##329）：catch-and-return 的返回值是**正常工具结果**，
                    // SDK 走 tool-result 分支 → patch status:"done" → UI 画 ✓、且失败块不自动展开
                    // —— 失败只躺在折叠正文里（模型看得见，用户看不见）。
                    // 抛出 → SDK 发 tool-error → status:"error"（UI 画 ✗ 并自动展开）。
                    // ⚠️ 别改回 return：read **读不到就是失败**（catch 里返字符串 = 把失败包成
                    //   "正常结果" → status:"done" → ✓ 且不展开，就是 ##329 的形态）。
                    //   与 bash 的判据**不同向**，别互相抄（bash 侧 ##353 复议过）：bash 只在
                    //   **非零退出且有错误输出**时才抛（无输出的非零退出 = 查询未命中，是数据；
                    //   超时/取消仍当数据，模型靠退出码改命令；**spawn/IO 失败也抛**（##332 ③ 已落地，
                    //   判据：`err.code` 非数字 = 命令没跑起来）。
                    //   read 则「读不到就是失败」：目标文件不存在没有"信息"可给，只有"这一步没做成"。
                    //   ⚠️「bash.execute 现在会抛」≠「它见错就抛」—— 判据细节全在 runBash 头注。
                    throw new Error(`[读取失败] ${e instanceof Error ? e.message : e}`);
                }
            },
        }),
        /**
         * `write` —— 整文件写（##414）。
         *
         * 为什么要有：没有它时所有写文件都靠 bash（heredoc / python / sed），转义易错、
         * 无 diff 反馈、无路径护栏、审计粒度只有一条命令行。
         * 实现全在 core/file-write.ts（路径护栏 / 上限 / BOM / diff 摘要只有一份）——
         * ##415 的 edit 会复用同一套，别在本文件里另写。
         */
        write: tool({
            description:
                "整文件写入（新建或覆盖；相对路径按项目目录解析）。" +
                `**父目录不存在会自动创建**（mkdir -p），这不是错误。` +
                `content 上限 ${Math.round(WRITE_MAX_BYTES / 1024)}KB（报 fs/content-too-large）；` +
                "目标是目录报 fs/is-directory。UTF-8 原样写：行尾不转换，原文件有 BOM 会保留。" +
                "返回 `+N/-M 行` 与 unified diff 摘要。改几行不要用本工具重写整个文件。",
            inputSchema: z.object({
                path: z.string().describe("文件路径（相对项目目录解析）"),
                content: z.string().describe("完整文件内容（UTF-8 文本；原样写入，不做转义处理）"),
            }),
            execute: async ({ path: filePath, content }) => {
                // **抛，不 return**（##414 / 与 read 的 ##329 同口径）：失败是工具错误（UI ✗ 且自动展开），
                // 不是「正常结果里写一句失败」—— 后者会被画成 ✓。
                const r = writeFileWhole(cwd, filePath, content);
                audit({ phase: "file-write", cwd, command: filePath, result: countsLabel(r) });
                return formatWriteResult(r);
            },
        }),
        /**
         * `edit` —— **局部替换**（##415）。存在的唯一理由：改 3 行不该重写整个文件。
         *
         * 与 `write` 的分工：write 负责「整份文件是什么」，edit 负责「把这几处换成那几处」。
         * 匹配 / 归一 / diff 全在 core/file-edit.ts（纯函数、可单测）；这里只管 I/O：
         *   路径护栏 → 同文件队列 → 读改写 → 审计 → 抛错（不 return 失败）。
         * 路径护栏 / 错误类 / diff 生成**与 write 共用一份**（`core/file-write.ts` +
         * `core/unified-diff.ts`，##266 review2 去重）；本文件只做 I/O 与审计。
         */
        edit: tool({
            description:
                "对**单个已存在的文件**做局部替换（不要为了改几行就重写整个文件，那是 write 的事）。" +
                "edits 是**有序的**：后一条基于前一条的结果匹配。每条 oldText 必须逐字来自文件且**唯一命中**" +
                "（命中多处会报错并给出次数；确实要全改就传 replaceAll: true）。" +
                "精确匹配失败时会做字符归一（全角/半角、弯直引号、行尾空白）再试，命中后在返回里**明确说明**用了归一；" +
                "未命中的行逐字保留。返回 unified patch。",
            inputSchema: z.object({
                path: z.string().describe("目标文件路径（相对项目目录或绝对路径，必须在项目目录内）"),
                edits: z
                    .array(
                        z.object({
                            oldText: z
                                .string()
                                .describe("要替换的原文（逐字来自文件；必须唯一命中，除非 replaceAll: true）"),
                            newText: z.string().describe("替换成什么（空串 = 删除这段原文）"),
                            replaceAll: z.boolean().optional().describe("允许替换全部命中（缺省 false = 必须唯一）"),
                        }),
                    )
                    .describe("有序的替换列表：后一条基于前一条的结果匹配"),
            }),
            execute: async ({ path: filePath, edits }) => {
                const abs = resolveEditablePath(cwd, filePath);
                const label = displayPath(cwd, abs);
                const t0 = Date.now();
                // 写前审计：与 bash 同一口径（先落盘再执行，保证最后一幕不丢）
                audit({
                    phase: "file-edit-start",
                    cwd,
                    path: label,
                    result: `${edits.length} 条 edits`,
                });
                try {
                    return await withFileEditQueue(abs, () => {
                        const r = editFile(abs, label, edits, (p, c) => writeFileAtomic(p, c));
                        const text = describeEditResult(label, r);
                        audit({
                            phase: "file-edit-end",
                            cwd,
                            path: label,
                            ms: Date.now() - t0,
                            result: clip(text, 500),
                        });
                        // 返回「摘要 + unified patch」：摘要给模型确认命中/归一，patch 给人看改了什么
                        return r.patch === "" ? text : `${text}\n\n${r.patch}`;
                    });
                } catch (e) {
                    // **抛，不 return**（与 read / bash 同口径）：失败必须是 tool-error，
                    // 否则 UI 画 ✓ 且不展开。这里只补一条审计，错误原样上抛（带 fs/ code）。
                    audit({
                        phase: "file-edit-end",
                        cwd,
                        path: label,
                        ms: Date.now() - t0,
                        result: `失败：${clip(e instanceof Error ? e.message : String(e), 300)}`,
                    });
                    throw e;
                }
            },
        }),
    };

    const extra = ctx.extraTools ?? {};
    for (const name of Object.keys(extra)) {
        if (name in built) throw new Error(`[tools] 额外工具与内置工具重名：${name}`);
    }
    return { ...extra, ...built };
}
