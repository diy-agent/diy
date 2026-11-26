// job.ts —— 后台作业（`bash` 带 background / `job` 工具）的**结构化解读**（纯函数，可测）。
//
// 为什么需要这一层：这两种工具的返回值是给人读的长文本（`<id> · 已结束 · 34.3s` + 命令 +
// 结局 + 输出尾部），而 UI 原先只当普通工具行画 —— 显示成截断的 JSON target，没有 run id、
// 没有状态、没有退出码、没有输出；`job-done` 的 notify 更把整段（含 ANSI 色码）糊在一条
// 分隔线上（2026-11-23 用户："我无法知道他到底啥情况"）。
//
// 判据住这里（而不是组件里）：解析规则能单测，两个 surface 也不会各写一遍。
// 文案的全部真源是 `@diy-agent/jobs/src/run-status.ts`（`runDetail` / `runLine` / `stateLabel`）——
// 那边改文案，这边必须跟着改（有测试钉住）。

import type { JobNotice } from './types';
import type { TimelinePart } from './timeline';

export type JobState = 'running' | 'exited' | 'killed' | 'failed';

/** `job list` 的一行 */
export interface JobRow {
    state: JobState;
    id: string;
    duration: string;
    command: string;
}

/**
 * 一次后台作业工具调用的**可渲染形态**。
 *
 * 字段全是"有就填"：`bash(background)` 只知道 id / 状态 / 日志路径，`job status` 才有
 * 命令 / 结局 / 输出尾巴。缺字段的卡片少画几行，不要编。
 */
export interface JobView {
    /** start = 把命令转到后台；done = 收口通知；其余与 `job` 的 action 同名 */
    action: 'start' | 'done' | 'list' | 'status' | 'output' | 'kill' | 'wait';
    id?: string;
    state?: JobState;
    /** `state` 的人话（与 runtime 的 `stateLabel` 同表） */
    label?: string;
    duration?: string;
    command?: string;
    cwd?: string;
    /** 结局：`退出码 0` / `信号 SIGKILL` / `（未结束）` */
    outcome?: string;
    logPath?: string;
    origin?: string;
    /** 输出尾部（**已去掉 ANSI 色码** —— 原文里的 `\u001b[38;5;...m` 在界面上是乱码） */
    tail?: string;
    /** 尾部之前被截掉的字节数（0 = 没截） */
    tailDroppedBytes?: number;
    /** `（已等 5m00s，仍未结束…）` 这类补充说明 */
    note?: string;
    /** list 的行 */
    rows?: JobRow[];
    /** 工具自己的错误（`[没有这个后台进程]` / `[缺 id]` / 启动失败） */
    error?: string;
    /** 原始返回文本：卡片里给一个「原文」折叠，省得为排障再翻一遍 */
    raw: string;
}

// 要匹配的就是 ESC 字符本身（工具输出里的色码前缀）
// oxlint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** 去掉 ANSI 色码（工具输出里带 `\u001b[38;5;255;48;5;66;1m` 这类前缀） */
export function stripAnsi(text: string): string {
    return text.replace(ANSI, '');
}

const STATES: readonly JobState[] = ['running', 'exited', 'killed', 'failed'];

/** 与 `run-status.ts` 的 `stateLabel` 同一张表（那边改文案，这里跟着改） */
const LABELS: Record<JobState, string> = {
    running: '运行中',
    exited: '已结束',
    killed: '已被杀',
    failed: '启动失败',
};

function isState(value: unknown): value is JobState {
    return typeof value === 'string' && (STATES as readonly string[]).includes(value);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/**
 * 工具结果 → 文本。
 *
 * 三种形状都要认：字符串（本项目工具）、ai-sdk 的 `{type:'text', value}` 包装、以及
 * 落库后又被 JSON 化的对象。认不出就返回空串（卡片只剩 id / 状态）。
 */
function resultTextOf(result: unknown): string {
    if (typeof result === 'string') return result;
    const record = recordOf(result);
    if (record === undefined) return '';
    const value = record['value'];
    if (typeof value === 'string') return value;
    if (value === undefined) return '';
    try {
        return JSON.stringify(value);
    } catch {
        return '';
    }
}

/** 一行 `key：value` 里的值（行首必须是这个 key，避免把输出正文里的同名文本当字段） */
function field(text: string, key: string): string | undefined {
    const match = new RegExp(`^${key}：(.*)$`, 'm').exec(text);
    return match?.[1]?.trim();
}

const ROW = /^(运行中|已结束|已被杀|启动失败) · (\S+) · (\S+) · (.*)$/;

/**
 * 时长文案（与 `@diy-agent/jobs` 的 `formatDuration` 逐字一致）。
 * chat-core 不能 import 那个包（它走 node 侧），所以这里只复制这一小段纯逻辑。
 */
function formatDurationMs(ms: number | undefined): string | undefined {
    if (ms === undefined || Number.isNaN(ms) || ms < 0) return undefined;
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const total = Math.round(ms / 1000);
    return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}

/** 结局文案（与 `@diy-agent/jobs` 的 `exitText` 逐字一致：结局与状态正交） */
function exitTextOf(state: JobState | undefined, exitCode?: number | null, signal?: string | null): string | undefined {
    if (state === undefined) return undefined;
    if (state === 'running') return '（未结束）';
    if (signal !== undefined && signal !== null) return `信号 ${signal}`;
    if (exitCode === undefined || exitCode === null) return '无退出码';
    return `退出码 ${exitCode}`;
}

/**
 * `job-done` 通知 → `JobView`（收口卡片）。
 *
 * 与工具返回那一路同形，所以界面只画一个组件；差别只在 `action: 'done'`（不显示动作 chip）。
 * `text` 带上原文（卡片里可折叠），`tail` 已去过 ANSI。
 */
export function jobViewOfNotice(job: JobNotice, text: string): JobView {
    const state = isState(job.state) ? job.state : undefined;
    // 老 envelope 可能没 state：宁可不写结局，也不要猜「成功」
    const outcome = exitTextOf(state, job.exitCode, job.signal);
    return {
        action: 'done',
        id: job.run,
        ...(state === undefined ? {} : { state, label: LABELS[state] }),
        ...(outcome === undefined ? {} : { outcome }),
        ...(job.durationMs === undefined ? {} : { duration: formatDurationMs(job.durationMs) }),
        ...(job.command === undefined ? {} : { command: job.command }),
        ...(job.tail === undefined ? {} : { tail: stripAnsi(job.tail) }),
        ...(job.truncatedBytes === undefined ? {} : { tailDroppedBytes: job.truncatedBytes }),
        raw: stripAnsi(text),
    };
}

function rowState(label: string): JobState {
    const entry = (Object.entries(LABELS) as [JobState, string][]).find(([, text]) => text === label);
    return entry?.[0] ?? 'running';
}

/**
 * 工具 part → `JobView`；不是后台作业工具就返回 `undefined`（调用方照常画普通工具行）。
 *
 * 判据：`name === 'job'`，或 `name === 'bash'` 且 `args.background === true`。
 * 后者不能漏：**转后台的那次调用**才是用户第一次看见这条作业的地方。
 */
export function jobOf(part: TimelinePart & { kind: 'tool' }): JobView | undefined {
    const args = recordOf(part.args);
    const isStart = part.name === 'bash' && args?.['background'] === true;
    if (part.name !== 'job' && !isStart) return undefined;

    const raw = stripAnsi(resultTextOf(part.result));
    const action = isStart ? ('start' as const) : ((args?.['action'] as JobView['action']) ?? 'status');
    const view: JobView = { action, raw };

    if (isStart) {
        // `已转到后台：r-xxx（状态 running）`
        const started = /已转到后台：(\S+?)（状态 (\S+?)）/.exec(raw);
        if (started?.[1] !== undefined) view.id = started[1];
        if (isState(started?.[2])) {
            view.state = started[2]!;
            view.label = LABELS[view.state];
        }
        view.logPath = field(raw, '输出');
        const command = args?.['command'];
        if (typeof command === 'string') view.command = command;
        // 没看到「已转到后台」= 启动本身失败（工具会抛错，part.state = error）
        if (view.id === undefined && raw !== '') view.error = raw.split('\n')[0] ?? raw;
        return view;
    }

    const id = args?.['id'];
    if (typeof id === 'string' && id !== '') view.id = id;

    if (raw === '') return view; // 还在跑：结果没回来

    // 工具自己的失败文案（`[没有这个后台进程] …` / `[缺 id] …`）
    if (raw.startsWith('[')) {
        view.error = raw.split('\n')[0] ?? raw;
        return view;
    }

    if (action === 'list') {
        view.rows = raw
            .split('\n')
            .map((line) => ROW.exec(line.trim()))
            .filter((match): match is RegExpExecArray => match !== null)
            .map((match) => ({
                state: rowState(match[1]!),
                id: match[2]!,
                duration: match[3]!,
                command: match[4]!,
            }));
        return view;
    }

    if (action === 'kill') {
        // id 后面紧跟中文句号（`）：r-1。稍后用 job status 确认终态。`）—— 不能直接 `\S+` 吞到空白
        const stopped = /已发送停止信号（进程组 ([^）\s]+)）：([^。\s]+)/.exec(raw);
        if (stopped?.[2] !== undefined) view.id = stopped[2];
        view.note = raw.trim();
        return view;
    }

    // status / output / wait：`runDetail` 那套
    const head = /^(\S+) · (\S+) · (\S+)$/m.exec(raw);
    if (head?.[1] !== undefined) view.id = head[1];
    const label = head?.[2];
    const known = (Object.entries(LABELS) as [JobState, string][]).find(([, text]) => text === label);
    if (known !== undefined) {
        view.state = known[0];
        view.label = known[1];
    }
    view.duration = head?.[3];
    view.command = field(raw, '命令');
    view.cwd = field(raw, '目录');
    view.outcome = field(raw, '结局');
    // 还在跑的那条：`runDetail` 的「结局」行只在收口后才有，而「未结束」正是用户要的判断
    // （`job wait` 等满上限回来的那一行就是这种：状态 running，没有结局行）
    if (view.outcome === undefined && view.state === 'running') view.outcome = '（未结束）';
    view.logPath = field(raw, '输出');
    view.origin = field(raw, '来源');

    const tailHead = /^—— 输出尾部(?:（前 (\d+) 字节已截断）)? ——$/m.exec(raw);
    if (tailHead !== null) {
        if (tailHead[1] !== undefined) view.tailDroppedBytes = Number(tailHead[1]);
        const body = raw.slice(tailHead.index + tailHead[0].length).replace(/^\n/, '');
        // 尾部之后只有 `（已等 …，仍未结束…）` 这类补充说明，摘出去单独一行
        const noteAt = /^（已等 .*$/m.exec(body);
        if (noteAt !== null) {
            view.note = noteAt[0];
            view.tail = body.slice(0, noteAt.index).replace(/\n+$/, '');
        } else {
            view.tail = body.replace(/\n+$/, '');
        }
    } else if (raw.includes('（无输出）')) {
        view.tail = '';
    }
    // `（已等 …，仍未结束…）` 可能出现在尾部之后，也可能没有尾部（`（无输出）`）—— 都得捞出来
    if (view.note === undefined) {
        const waitNote = /^（已等 .*$/m.exec(raw);
        if (waitNote !== null) view.note = waitNote[0];
    }
    return view;
}
