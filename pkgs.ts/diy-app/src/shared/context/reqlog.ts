// src/shared/context/reqlog.ts
// 🎯 「真发请求的流量日志」节点（变量树里的 `reqlog`）—— 纯函数，禁止 import node:*
//
// ── 为什么要把它放进变量树（用户 2026-10-15）──
// 「把请求日志的位置也增加到上下文树，并说明此字段的查找规则，比如这是啥目录怎么定位自己
//   步骤所在行的请求」。上下文树主要是**给模型定位信息**用的 ——「我自己的东西在哪、怎么找」
//   是稳定信息，模型才能自查"我上一步到底发出去了什么"。
//
// ── 形态（##310 六轮拍板）──
// 值 = `{ file }`（**纯数据**，就一个字段）；全部解释（这是什么文件、路径规则、怎么定位、
// 怎么开全文）在 `.describe()` 里 → 派生进信封的 `help.reqlog`（见 envelope.ts）。
// 「值节点里禁出现解释性字段」：`about` / `dir` / `locate` / `body` 那套已删 ——
// 一条信息只在一处，且那一处由代码派生、不会腐坏（用户原话：「没有 reqlog.about 这个变量，
// 只有 zod 的 description 作为帮助」）。
//
// ── 为什么行号给不出来 ──
// 那条记录是请求**发出之后**才落盘的，组装上下文时它还不存在（UI 侧由流量日志反查，
// 见 traffic-step.ts）。所以这里只说"怎么找"，不编行号。

import { z } from "zod";

/** 流量日志节点的**契约**（唯一真源；`help.reqlog` 由它派生） */
export const ReqlogSchema = z
    .object({
        file: z
            .string()
            .describe(
                "今天的流量日志文件（绝对路径；`$DIY_HOME/log/network/<YYYY-MM-DD>.jsonl`，按天切分）。" +
                    "本应用**每次真发 HTTP 请求**都往它追加一行（一行 = 一条 JSON，含请求体与响应）——" +
                    "自己刚发出去的那条就在里面。定位自己这一步的那条：" +
                    "`grep -n '\"taskUri\":\"<你的 task.uri>\"' <file> | tail -20`（行号 = 文件内第几行）；" +
                    "一轮多步 = 同一个 turnId 多行；定位某一步用 `stepSeq`（逻辑步，1 起，同变更历史的 stepNo）、" +
                    "这一步重试了几次看 `attemptInStep`（1 = 首试，2 = 第 1 次重试…；同一步多条按它排就是重试链）；" +
                    "⚠️ 老字段 `attempt` 是**本 run 内的往返序号**（跨步累计、重试也 +1）—— 既不是步序也不是重试序号，" +
                    "老记录没有 stepSeq / attemptInStep 时才退用它。字段表见日志行本身的键" +
                    "（真源 `pkgs.ts/diy-app/src/shared/traffic-record.ts`）。" +
                    "reqBody 默认只留首尾各一段（`truncated: true` 时 JSON 解不开）；要看全文先开" +
                    "「记录完整请求内容」（流量页右上角开关；CLI 侧 = 本应用 CLI 的 `traffic setFullCapture true`，" +
                    "参数是**位置参数**、不是 `--on`）再复现。" +
                    "`log/network/` 等同 cache，可随时清理 —— 老日期查不到是正常的。" +
                    "⚠️ **只有 `log/` 是 cache**：`local/` 下的 ops/llm/steps 是会话数据，不在可清之列。",
            ),
    })
    .describe("本应用真发请求的**流量日志**：一行 = 一次真发 HTTP 请求（含请求体与响应）");

/** `reqlog` 节点的值（**纯数据**，解释见 `ReqlogSchema` 的 desc） */
export interface ReqlogValue {
    /** 今天的日志文件（绝对路径；按天切分，跨天换文件） */
    file: string;
}

/** 构造节点值（main 侧把数据根与实际文件名传进来；本文件保持纯函数） */
export function reqlogValue(opts: { home: string; dirRel: string; fileName: string }): ReqlogValue {
    return { file: `${opts.home}/${opts.dirRel}/${opts.fileName}` };
}
