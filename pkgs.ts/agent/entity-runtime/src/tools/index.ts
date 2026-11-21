// tools/index.ts —— 房间的工具装配。
//
// 分工（2026-11-21 收口，见 docs/plans/2026-11-21-diy1-gap-review.md）：
//   · **语义归内核**：read / write / edit 来自 `@diy-agent/tools::buildTools`，
//     bash / pwsh 来自 `@diy-agent/tools::makeShellTool` —— 续读窗口、原子写、unified diff、
//     字符归一匹配、输出上限、超时杀组、结果头只有一份实现。
//     （以前这里有两份"精简移植"，头注写着"等 build 图修好再换回去"；理由已过期。）
//   · **房间策略留在这里**：路径护栏（`inside`）是 diy2 的房间规矩（diy1 的写入护栏已按
//     用户要求移除，这里保留是为了不放松已有保证），只拦 read / write / edit 的 `path`。
//     注意 bash 本来就不受它约束 —— 它是"别手滑写到房间外"，不是沙箱。
//   · **宿主能力补在这里**：`ask`（提问闸门）、`journal`（任务日志）、`job`（后台作业账本）。
//     后两者的落点由房间决定（store）；作业表由进程级 RunRegistry 提供。

import { isAbsolute, relative, resolve } from 'node:path';

import type { ToolSet } from 'ai';

import {
    buildTools,
    detectPreferredShell,
    makeShellTool,
    type ShellAuditEvent,
    type ShellSpec,
    type ToolAuditEvent,
} from '@diy-agent/tools';
import { makeJobTool, type RunRegistry } from '@diy-agent/jobs/node';

import type { AskGate } from '../ask';
import { askTool } from './ask';
import { journalTool } from './journal';

export { clipModelMessage, clipToolOutput, DEFAULT_CLIP, type ClipPolicy } from './clip';

/** 审计事件：文件工具一条（`ToolAuditEvent`）、shell 一条（`ShellAuditEvent`），宿主自己分派 */
export type RoomAuditEvent = ToolAuditEvent | ShellAuditEvent;

/** 房间能看见 / 能动的那部分后台作业（可见性判据 = 归属串） */
export interface RoomJobs {
    readonly registry: RunRegistry;
    /** 本成员的归属串（`<roomId>#<botId>`；与 `jobs.ts::jobOwnerOf` 同源） */
    readonly owner: string;
}

export interface RoomToolsOptions {
    /** 房间的工作目录（相对路径的解析基准，也是命令的 cwd） */
    cwd: string;
    /** 是否开放 shell；缺省开放 */
    shell?: boolean;
    /** bash 的执行预算：缺省超时（毫秒，0 = 不设超时）。缺省 0 —— 与内核 / diy1 同口径 */
    bashTimeoutMs?: number;
    /** 提问闸门；不传 = 没有 ask 工具 */
    ask?: AskGate;
    /** 提问的归属成员（按成员停止时只取消他家的提问） */
    askOwner?: string;
    /** 任务日志写入口；不传 = 没有 journal 工具 */
    onJournal?: (input: { kind: import('../db').JournalKind; text: string }) => void;
    /** 后台作业；不传 = bash 没有 `background`、也没有 `job` 工具 */
    jobs?: RoomJobs;
    /** 工具执行审计（宿主决定写去哪；不传 = 不审计）。收的是两者的联合，按 `phase` 分派 */
    onAudit?: (event: RoomAuditEvent) => void;
    /** 投递层截断（只改"发给模型的那一份"，execute 的返回值仍是全文） */
    toModelOutput?: (text: string, toolCallId: string) => string;
}

/** 解析到房间目录内；越界抛错（房间策略，见文件头） */
function inside(cwd: string, filePath: string): void {
    const rel = relative(cwd, resolve(cwd, filePath));
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return;
    throw new Error(`[越界] ${filePath} 不在房间目录 ${cwd} 内`);
}

/**
 * 给文件工具套上房间的路径规矩。
 *
 * 只包 `execute` 的入参检查，工具语义（读窗口 / 原子写 / diff / 抛错口径）一律仍是内核那份 ——
 * 这里不重新实现任何一条判断。`path` 缺省（不该发生）时直接放行给内核去报错。
 */
function scoped(def: ToolSet[string], cwd: string): ToolSet[string] {
    const execute = def.execute;
    if (execute === undefined) return def;
    const guarded = {
        ...def,
        execute: async (input: unknown, options: unknown) => {
            const filePath = (input as { path?: unknown } | null)?.path;
            if (typeof filePath === 'string' && filePath !== '') inside(cwd, filePath);
            return (execute as (i: unknown, o: unknown) => Promise<unknown>)(input, options);
        },
    };
    return guarded as ToolSet[string];
}

/** shell 能力探测只做一次（`DIY_SHELL` 是启动期环境事实，不是每房间一份） */
let shellSpec: ShellSpec | undefined;
function preferredShell(): ShellSpec {
    shellSpec ??= detectPreferredShell();
    return shellSpec;
}

/** 给一个房间装配工具集 */
export function buildRoomTools(options: RoomToolsOptions): ToolSet {
    const { cwd } = options;
    const extra: ToolSet = {};

    if (options.shell !== false) {
        const spec = preferredShell();
        const jobs = options.jobs;
        extra[spec.kind === 'pwsh' ? 'pwsh' : 'bash'] = makeShellTool(spec, {
            cwd,
            limits: { bashTimeoutMs: options.bashTimeoutMs ?? 0 },
            ...(options.toModelOutput === undefined ? {} : { toModelOutput: options.toModelOutput }),
            ...(options.onAudit === undefined ? {} : { audit: options.onAudit }),
            // 后台模式：**不传就没有 background 参数**（免得告诉模型一个必然失败的选择）
            ...(jobs === undefined
                ? {}
                : {
                      background: async (input: { command: string; timeoutMs: number; toolCallId?: string }) => {
                          const run = await jobs.registry.spawn({
                              command: input.command,
                              cwd,
                              title: input.command.split('\n')[0]?.slice(0, 120) ?? input.command.slice(0, 120),
                              origin: {
                                  taskUri: jobs.owner,
                                  ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
                              },
                              // 只有模型显式写了 timeout 才设截止：后台 daemon 不该被缺省值静默做掉
                              ...(input.timeoutMs > 0 ? { deadlineMs: input.timeoutMs } : {}),
                          });
                          return [
                              `已转到后台：${run.id}（状态 ${run.state}）`,
                              `输出：${run.logPath}`,
                              '结束时会插话通知你，**不要轮询**；查状态 / 取输出 / 停止用 job 工具。',
                          ].join('\n');
                      },
                  }),
        });
        if (jobs !== undefined) {
            extra['job'] = makeJobTool({
                registry: jobs.registry,
                // 越权边界：一条 run 只对它被起出来的那个成员可见（同一进程里别的房间 / 成员看不见）
                visible: (info) => info.origin?.taskUri === jobs.owner,
                scopeLabel: '本 bot',
            });
        }
    }

    const ask = askTool(options.ask, options.askOwner);
    if (ask !== undefined) extra['ask'] = ask;
    if (options.onJournal !== undefined) extra['journal'] = journalTool(options.onJournal);

    const built = buildTools({
        cwd,
        ...(options.onAudit === undefined ? {} : { onAudit: options.onAudit }),
        extraTools: extra,
    });
    // 房间的路径规矩只加在文件工具上（bash 不受限，见文件头）
    for (const name of ['read', 'write', 'edit']) {
        const def = built[name];
        if (def !== undefined) built[name] = scoped(def, cwd);
    }
    return built;
}
