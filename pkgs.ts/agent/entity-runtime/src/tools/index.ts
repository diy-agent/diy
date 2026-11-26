// tools/index.ts —— 房间的工具装配。
//
// 分工（2026-11-21 收口，见 docs/plans/2026-11-21-diy1-gap-review.md）：
//   · **语义归内核**：read / write / edit 来自 `@diy-agent/tools::buildTools`，
//     bash / pwsh 来自 `@diy-agent/tools::makeShellTool` —— 续读窗口、原子写、unified diff、
//     字符归一匹配、输出上限、超时杀组、结果头只有一份实现。
//     （以前这里有两份"精简移植"，头注写着"等 build 图修好再换回去"；理由已过期。）
//   · **房间不再加路径规矩**（2026-11-21 用户裁，与 diy1 / 内核同口径）：原先这里有个 `inside`，
//     只拦 read / write / edit 的 `path` —— 但「任务在 git worktree 里」时文件在房间目录之外，
//     write / edit 一律拒、只能退回 `bash` 写 —— 文件改动从此没有 diff 摘要、也没走统一的写路径
//     （diy1 那边还多一层 onAudit 落盘；diy2 本来就没有审计，不拿它当理由），而它本来就不是沙箱
//     （bash 从来不受它约束）。房间目录只是相对路径基准与命令的 cwd。
//   · **宿主能力补在这里**：`ask`（提问闸门）、`journal`（任务日志）、`job`（后台作业账本）。
//     后两者的落点由房间决定（store）；作业表由进程级 RunRegistry 提供。

import type { ToolSet } from 'ai';

import { buildTools, detectPreferredShell, makeShellTool, type ShellSpec } from '@diy-agent/tools';
import { makeJobTool, type RunRegistry } from '@diy-agent/jobs/node';

import type { AskGate } from '../ask';
import { askTool } from './ask';
import { journalTool } from './journal';
import { runCodeTool, type RunCodeHost } from './run-code';
import { unitTools, type UnitHost } from './units';

export type { UnitHost } from './units';
export type { RunCodeHost } from './run-code';
export { DEFAULT_RUN_CODE_TIMEOUT_MS } from './run-code';

/**
 * 一条 bash 命令的缺省预算（毫秒）。
 *
 * 300_000 抄的是 diy1 `DEFAULT_LIMITS.bashTimeoutMs` —— 这里**必须有缺省**：
 * 「0 = 不设超时」看着更自由，实际是把「一轮挂住」的坑丢给调用方（步数刹车管不到
 * 一条卡死的 `npm test`，只会一直挂到人来看）。要放开就显式传 0。
 */
export const DEFAULT_BASH_TIMEOUT_MS = 300_000;

/** 房间能看见 / 能动的那部分后台作业（可见性判据 = 归属串） */
export interface RoomJobs {
    readonly registry: RunRegistry;
    /** 本成员的归属串（`<roomId>#<botId>`；与 `jobs.ts::jobOwnerOf` 同源） */
    readonly owner: string;
}

export interface RoomToolsOptions {
    /** 房间的工作目录（相对路径的解析基准，也是命令的 cwd；**不是**可写范围） */
    cwd: string;
    /** 是否开放 shell；缺省开放 */
    shell?: boolean;
    /** bash 的执行预算：单条命令超时（毫秒；0 = 不设超时）。不传 = `DEFAULT_BASH_TIMEOUT_MS`（300s，与 diy1 同值） */
    bashTimeoutMs?: number;
    /** 提问闸门；不传 = 没有 ask 工具 */
    ask?: AskGate;
    /** 提问的归属成员（按成员停止时只取消他家的提问） */
    askOwner?: string;
    /** 任务日志写入口；不传 = 没有 journal 工具 */
    onJournal?: (input: { kind: import('../db').JournalKind; text: string }) => void;
    /**
     * 任务的需求账本树（读写）；不传 = 没有 `unit_*` 工具。
     * 非 task 房间不该传：unit 是 task 私有的，没有任务就没有图。
     */
    units?: UnitHost;
    /** 后台作业；不传 = bash 没有 `background`、也没有 `job` 工具 */
    jobs?: RoomJobs;
    /**
     * 代码执行（`run_code`）；不传 = 没这个工具。
     * 引擎实现由调用方给（进程内 vm / worker / 子进程），本文件只负责把它包成工具。
     */
    code?: RunCodeHost;
    /** 投递层截断（只改"发给模型的那一份"，execute 的返回值仍是全文）；可返回 Promise */
    toModelOutput?: (text: string, toolCallId: string) => string | Promise<string>;
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
            // 不传 ≠ 不限：缺省就带预算（见 DEFAULT_BASH_TIMEOUT_MS）
            limits: { bashTimeoutMs: options.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS },
            ...(options.toModelOutput === undefined ? {} : { toModelOutput: options.toModelOutput }),
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
    if (options.units !== undefined) Object.assign(extra, unitTools(options.units));
    if (options.code !== undefined) extra['run_code'] = runCodeTool(options.code);

    return buildTools({ cwd, extraTools: extra });
}
