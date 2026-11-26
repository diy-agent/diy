// tools/run-code.ts —— `run_code`：让 bot 用一段代码代替「bash 拼 CLI + 解析文本」。
//
// 为什么要有它：同一个动作（列 bot / 改任务 / 查状态）用 CLI 要「拼命令 + 读输出 + 猜格式」，
// 用代码就是 `await api.bots.update({...})` —— 强类型、参数错立刻报、返回值是结构化对象。
// 这也是 diy 的独有优势：服务端 handler 就在本进程里，不必绕 shell 子进程。
//
// 分工：引擎（`@diy-agent/code-runtime`）只管**怎么跑**；这里只管**给模型什么接口**。

import { tool } from 'ai';
import { z } from 'zod';

import { formatApiHelp, makeGlobals, type ApiHelpItem, type CodeRuntime } from '@diy-agent/code-runtime';

/**
 * 一条代码的缺省预算：比 bash 短得多 —— 代码里不该出现「跑十分钟」的活（那该转后台作业）。
 *
 * 为什么给 30s 而不是 10s：`chat.wait` 是个合法用法（写 `await api.chat.wait({timeoutMs})` 守一件事），
 * 预算比它小的话「一用就撞超时」；差距留得够开，模型中招的概率才低。
 */
export const DEFAULT_RUN_CODE_TIMEOUT_MS = 30_000;

export interface RunCodeHost {
    /** 执行引擎（策略位：进程内 vm / worker / 子进程，换实现不改这里） */
    readonly runtime: CodeRuntime;
    /**
     * 强类型 RPC 调用端（`createTypedClient` 的产物）。
     * 不传 = 这条房间不给 RPC 能力，只有纯 JS（仍能算数、拼数据）。
     */
    readonly api?: unknown;
    /** `api` 的物化清单（`api` 是 Proxy，模型无法枚举，只能靠这份） */
    readonly apiHelp?: readonly ApiHelpItem[];
    /** 本工具的缺省超时；不传 = `DEFAULT_RUN_CODE_TIMEOUT_MS` */
    readonly timeoutMs?: number;
    /** 取消（用户点停 / 本轮被中止） */
    readonly signal?: AbortSignal;
}

/** `run_code` 的完整说明书 —— 模型只看得到这段文字，写清"能用什么 / 不能用什么" */
function describe(host: RunCodeHost): string {
    const hasApi = host.api !== undefined;
    const lines = [
        '执行一段 **JS 代码体**（不是表达式）：可以直接写 await / return，不用自己套 IIFE。',
        '比 bash+CLI 更可靠：参数错会立刻报错，返回值是结构化对象，不用解析文本。',
        '',
        '可用：',
        ...(hasApi
            ? [
                  '· api.… —— 后台 RPC（强类型）。调用形式：`await api.rooms.list({})`；',
                  '  先调 `apiHelp()` 看有哪些方法（不调就只能猜）。',
              ]
            : ['· （这个会话没有挂 RPC，只能用纯 JS）']),
        '· console.log/info/warn/error —— 输出随结果返回（总量超 64KB 截断）',
        '· sleep(ms) / now() / clone(v) / fetch',
        '· JSON / Math / Date / URL / TextEncoder / TextDecoder',
        '',
        '没有：process / require / import —— 需要文件就用 bash 工具。',
        '返回值必须可序列化：函数、循环引用会得到 `[unserializable: …]` 占位串。',
        `超时缺省 ${String(host.timeoutMs ?? DEFAULT_RUN_CODE_TIMEOUT_MS)}ms（可用 timeoutMs 调）。`,
        '同步死循环会被杀掉；`await` 之后卡住的长任务只能等超时 —— 长时间活请用 bash 的 background。',
    ];
    return lines.join('\n');
}

export function runCodeTool(host: RunCodeHost) {
    return tool({
        description: describe(host),
        inputSchema: z.object({
            code: z.string().min(1).describe('JS 代码体（可含 await / return）'),
            timeoutMs: z.number().int().min(0).optional().describe('本次超时（毫秒；0 = 不设，排障用）'),
        }),
        execute: async ({ code, timeoutMs }) => {
            const budget = timeoutMs ?? host.timeoutMs ?? DEFAULT_RUN_CODE_TIMEOUT_MS;
            const result = await host.runtime.run(code, {
                timeoutMs: budget,
                ...(host.signal === undefined ? {} : { signal: host.signal }),
                globals: makeGlobals({
                    api: host.api,
                    ...(host.apiHelp === undefined ? {} : { apiHelp: host.apiHelp }),
                    ...(host.signal === undefined ? {} : { signal: host.signal }),
                }),
            });
            return {
                outcome: result.outcome,
                value: result.value,
                logs: result.logs,
                truncated: result.truncated,
                durationMs: result.durationMs,
            };
        },
    });
}

export { formatApiHelp };
