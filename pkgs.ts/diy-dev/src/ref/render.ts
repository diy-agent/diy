// src/ref/render.ts — 进度渲染器（TTY 原地重绘 / 非 TTY 里程碑行 + 心跳提示）
//
// 消费端就是本地终端（190 修正 1：dev CLI 是进程内 mem transport，进度不进 RPC 协议）：
//   - TTY：\r 原地刷新当前进度行，阶段切换换行落盘
//   - 非 TTY（管道 / 日志）：只打里程碑行（信息行 / 阶段切换 / done），绝不输出 \r
//   - 心跳：由 exec.ts 按「输出活动」驱动 waiting()，只提示不杀进程（默认不自动中断）
// 条目行（P1.5）：begin 打 [i/N] 头行，done 打 ✓/✗ + 耗时 + 大小（done 行里的 bytes）。
// F1：done({ noTiming:true }) 不显示耗时列（该条目没跑任何 git 命令，如 tag 固定直接跳过）。
// F2：waiting 按「静默时长翻倍」降频（首报立即，5s→10s→20s→40s…）；feed/begin/info/drain
//     视为输出活动、重置为下次首报。缓冲未完段的落盘不受节流影响（仍在心跳行之前执行）。
// F5：done 幂等 —— 同条目重复收尾只出一行（impl 的 catch 在成功 done 之后抛错不重复打）。

import { parseGitProgress } from "./progress";

export interface Sink {
    write(s: string): void;
}

export interface RendererOpts {
    /** true=原地重绘；false=里程碑行。判据：process.stderr.isTTY && !NO_COLOR */
    isTTY: boolean;
    /** 时钟注入（测试用），缺省 Date.now */
    now?: () => number;
}

export interface DoneEntry {
    ok: boolean;
    /** 覆盖 begin 时的标签（未 begin 过时必填） */
    label?: string;
    /** 成功附加说明（如「tag 固定，跳过 pull」） */
    note?: string;
    /** 失败原因（多行原样缩进输出） */
    fail?: string;
    /** true = 本条目未执行任何 git 命令，不显示耗时列（如 tag 固定直接跳过 pull） */
    noTiming?: boolean;
}

function fmtDuration(ms: number): string {
    if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return `${m}m${s}s`;
}

export class ProgressRenderer {
    private readonly sink: Sink;
    private readonly isTTY: boolean;
    private readonly now: () => number;

    /** 当前原地行内容（仅 TTY；null = 无进行中行） */
    private curText: string | null = null;
    private curWidth = 0;
    /** 当前阶段 + 该阶段 done 是否已落（非 TTY 里程碑判重） */
    private phase: string | null = null;
    private phaseDone = false;
    /** feed 分段缓冲（chunk 边界可能截断段） */
    private buf = "";
    /** 最近一次输出文本（waiting 兜底） */
    private lastText = "";
    /** 最近一次 done 行的体积串（条目行用） */
    private lastBytes: string | undefined;
    /** 已作为「最后进度」展示过的缓冲段（避免连续心跳重复打） */
    private pendingShown = "";
    /** 当前条目标签与起始时间 */
    private label = "";
    private startedAt = 0;
    /** 最近一次 done 的标签（F5 幂等守卫：同条目重复收尾只出一行） */
    private lastDoneLabel = "";
    /** 下次心跳行所需的静默时长（F2 翻倍降频；0 = 首报立即） */
    private nextWaitReport = 0;

    constructor(sink: Sink, opts: RendererOpts) {
        this.sink = sink;
        this.isTTY = opts.isTTY;
        this.now = opts.now ?? Date.now;
    }

    /** 开始一个条目：打标签头行并复位条目状态。 */
    begin(label: string): void {
        this.flush();
        this.phase = null;
        this.phaseDone = false;
        this.lastBytes = undefined;
        this.lastText = "";
        // 条目边界自洁：残段不该跨条目（正常路径都经 drain() 清过，这里兜住未来新增的不 drain 路径）
        this.buf = "";
        this.pendingShown = "";
        this.label = label;
        this.startedAt = this.now();
        this.lastDoneLabel = "";
        this.nextWaitReport = 0; // 新条目 = 新一轮输出活动，心跳恢复首报
        this.sink.write(`${label}\n`);
    }

    /**
     * 喂一段 git 输出（任意 chunk 边界）：内部按 [\r\n] 切段 + trim 后逐段渲染。
     * TTY 原地重绘；非 TTY 只打里程碑行（信息行 / 阶段切换 / done）。
     */
    feed(chunk: string): void {
        this.buf += chunk;
        this.nextWaitReport = 0; // 有输出活动 → 下次静默首报（与 exec 的静默判据同源）
        const parts = this.buf.split(/[\r\n]/);
        this.buf = parts.pop() ?? "";
        for (const p of parts) this.emit(p);
    }

    /**
     * 停滞提示：距上次任何输出 ≥ silentMs 时由心跳驱动。只提示，不杀进程。
     * 降频（F2）：首报立即（阈值 0），之后按静默时长翻倍再报（5s→10s→20s→40s…），
     * 越久越稀疏；feed/begin/info/drain 视为输出活动会把阈值清零、恢复下次首报。
     */
    waiting(silentMs: number, last?: string): void {
        // 缓冲里的未完段（未遇 \r/\n）也是「最后输出」——静默前 git 常停在这种段上，先让它可见。
        // 这段落盘不受降频节流影响（节流只拦心跳行本身）。
        const pending = this.buf.trim();
        if (pending && pending !== this.pendingShown) {
            this.pendingShown = pending;
            if (this.isTTY) this.draw(pending);
            else this.sink.write(`${pending}\n`);
        }
        if (silentMs < this.nextWaitReport) return; // 翻倍降频：未到下次报告阈值，本轮不刷行
        // 阈值按整秒翻倍（5001ms → 10000ms），避免定时器漂移把 10s 报挤到 15s
        const baseSec = Math.floor(silentMs / 1000) * 1000;
        this.nextWaitReport = (baseSec || silentMs) * 2;
        const text = last ?? (pending || this.lastText || "(无输出)");
        this.flush();
        const dur = silentMs < 1000 ? `${silentMs}ms` : `${Math.round(silentMs / 1000)}s`;
        this.sink.write(
            `! 已静默 ${dur}（最后: ${text}）— 进程仍在运行，未自动中断；如需中止按 Ctrl+C\n`,
        );
    }

    /**
     * 条目收尾：✓/✗ + 耗时 + 大小（done 行 bytes）+ 可选说明 / 失败详情。
     * 幂等（F5）：同条目重复收尾只出一行；既未 begin 也无 label/fail 的空调用直接忽略。
     * noTiming（F1）：无命令执行时不显示耗时列（标签行已由 begin 打过）。
     */
    done(entry: DoneEntry): void {
        const label = entry.label ?? this.label;
        if (!label && !entry.fail) return; // 空标签且无详情：重复/无效调用，不打空行
        if (label && label === this.lastDoneLabel) return; // 同条目第二次收尾：吞（幂等）
        this.flush();
        const dur =
            entry.noTiming || this.startedAt === 0 ? "" : fmtDuration(this.now() - this.startedAt);
        const symbol = entry.ok ? "✓" : "✗";
        const bytes = this.lastBytes ? `  ${this.lastBytes}` : "";
        const note = entry.note ? `  ${entry.note}` : "";
        this.sink.write(`${symbol} ${label}${dur ? `  ${dur}` : ""}${bytes}${note}\n`);
        if (entry.fail) {
            for (const line of entry.fail.split("\n")) this.sink.write(`  ${line}\n`);
        }
        this.lastDoneLabel = label;
        this.label = "";
        this.startedAt = 0;
        this.lastBytes = undefined;
        this.nextWaitReport = 0; // 条目收尾也是活动，心跳恢复首报
    }

    /** 普通信息行（如 `$ git clone …` 回显、pull 合并摘要），先落进行中的进度行。 */
    info(text: string): void {
        this.flush();
        this.sink.write(`${text}\n`);
        this.lastText = text;
        this.nextWaitReport = 0; // 输出活动 → 下次静默首报
    }

    /** 一条命令结束：吐出残留缓冲段、落进行中行、复位阶段状态（条目状态留给 done）。 */
    drain(): void {
        if (this.buf) {
            const b = this.buf;
            this.buf = "";
            this.emit(b);
        }
        this.flush();
        this.phase = null;
        this.phaseDone = false;
        this.nextWaitReport = 0; // 一条命令结束 → 下一条命令心跳恢复首报
    }

    /** 单段渲染（已 trim）。 */
    private emit(seg: string): void {
        const text = seg.trim();
        if (!text) return;
        this.lastText = text;
        this.pendingShown = "";
        const prog = parseGitProgress(text);

        if (prog) {
            if (prog.bytes) this.lastBytes = prog.bytes;
            const phaseChanged = prog.phase !== this.phase;
            if (phaseChanged) {
                this.flush(); // 旧阶段的进行中行落盘
                this.phase = prog.phase;
                this.phaseDone = false;
            }
            if (this.isTTY) {
                this.draw(text);
            } else if (phaseChanged || (prog.done && !this.phaseDone)) {
                this.sink.write(`${text}\n`); // 里程碑：阶段切换 / 该阶段 done 首现
            }
            if (prog.done) this.phaseDone = true;
        } else {
            // 信息行（Cloning into / From … / warning 等）
            this.flush();
            this.sink.write(`${text}\n`);
        }
    }

    /** TTY 原地刷新当前行（\r 回行首 + padding 抹掉旧尾）。 */
    private draw(text: string): void {
        const pad = text.length < this.curWidth ? " ".repeat(this.curWidth - text.length) : "";
        this.sink.write(`\r${text}${pad}`);
        this.curText = text;
        this.curWidth = Math.max(this.curWidth, text.length);
    }

    /** 落盘进行中的 TTY 行（非 TTY 无进行中行）。 */
    private flush(): void {
        if (this.isTTY && this.curText !== null) {
            this.sink.write("\n");
            this.curText = null;
            this.curWidth = 0;
        }
    }
}

let defaultRenderer: ProgressRenderer | null = null;

/**
 * 测试钩子（review §二#5）：注入/复位进程级单例 —— 非 null=替换，null=下次取用时重建。
 * 仅测试断言短命令输出通道（run() → info()）用；生产路径禁用。
 */
export function setDefaultRendererForTest(r: ProgressRenderer | null): void {
    defaultRenderer = r;
}

/** 进程级默认渲染器：stderr，TTY 判定 process.stderr.isTTY && !NO_COLOR。 */
export function getDefaultRenderer(): ProgressRenderer {
    if (!defaultRenderer) {
        defaultRenderer = new ProgressRenderer(process.stderr, {
            isTTY: process.stderr.isTTY === true && !process.env.NO_COLOR,
        });
    }
    return defaultRenderer;
}
