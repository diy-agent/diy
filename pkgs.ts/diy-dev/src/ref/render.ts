// src/ref/render.ts — 进度渲染器（TTY 原地重绘 / 非 TTY 里程碑行 + 心跳提示）
//
// 消费端就是本地终端（190 修正 1：dev CLI 是进程内 mem transport，进度不进 RPC 协议）：
//   - TTY：\r 原地刷新当前进度行，阶段切换换行落盘
//   - 非 TTY（管道 / 日志）：只打里程碑行（信息行 / 阶段切换 / done），绝不输出 \r
//   - 心跳：由 exec.ts 按「输出活动」驱动 waiting()，只提示不杀进程（默认不自动中断）
// 条目行（P1.5）：begin 打 [i/N] 头行，done 打 ✓/✗ + 耗时 + 大小（done 行里的 bytes）。

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
        this.label = label;
        this.startedAt = this.now();
        this.sink.write(`${label}\n`);
    }

    /**
     * 喂一段 git 输出（任意 chunk 边界）：内部按 [\r\n] 切段 + trim 后逐段渲染。
     * TTY 原地重绘；非 TTY 只打里程碑行（信息行 / 阶段切换 / done）。
     */
    feed(chunk: string): void {
        this.buf += chunk;
        const parts = this.buf.split(/[\r\n]/);
        this.buf = parts.pop() ?? "";
        for (const p of parts) this.emit(p);
    }

    /** 停滞提示：距上次任何输出 ≥ silentMs 时由心跳驱动。只提示，不杀进程。 */
    waiting(silentMs: number, last?: string): void {
        // 缓冲里的未完段（未遇 \r/\n）也是「最后输出」——静默前 git 常停在这种段上，先让它可见
        const pending = this.buf.trim();
        if (pending && pending !== this.pendingShown) {
            this.pendingShown = pending;
            if (this.isTTY) this.draw(pending);
            else this.sink.write(`${pending}\n`);
        }
        const text = last ?? (pending || this.lastText || "(无输出)");
        this.flush();
        const dur = silentMs < 1000 ? `${silentMs}ms` : `${Math.round(silentMs / 1000)}s`;
        this.sink.write(
            `! 已静默 ${dur}（最后: ${text}）— 进程仍在运行，未自动中断；如需中止按 Ctrl+C\n`,
        );
    }

    /** 条目收尾：✓/✗ + 耗时 + 大小（done 行 bytes）+ 可选说明 / 失败详情。 */
    done(entry: DoneEntry): void {
        this.flush();
        const label = entry.label ?? this.label;
        const dur = this.startedAt > 0 ? fmtDuration(this.now() - this.startedAt) : "";
        const symbol = entry.ok ? "✓" : "✗";
        const bytes = this.lastBytes ? `  ${this.lastBytes}` : "";
        const note = entry.note ? `  ${entry.note}` : "";
        this.sink.write(`${symbol} ${label}${dur ? `  ${dur}` : ""}${bytes}${note}\n`);
        if (entry.fail) {
            for (const line of entry.fail.split("\n")) this.sink.write(`  ${line}\n`);
        }
        this.label = "";
        this.startedAt = 0;
        this.lastBytes = undefined;
    }

    /** 普通信息行（如 `$ git clone …` 回显、pull 合并摘要），先落进行中的进度行。 */
    info(text: string): void {
        this.flush();
        this.sink.write(`${text}\n`);
        this.lastText = text;
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

/** 进程级默认渲染器：stderr，TTY 判定 process.stderr.isTTY && !NO_COLOR。 */
export function getDefaultRenderer(): ProgressRenderer {
    if (!defaultRenderer) {
        defaultRenderer = new ProgressRenderer(process.stderr, {
            isTTY: process.stderr.isTTY === true && !process.env.NO_COLOR,
        });
    }
    return defaultRenderer;
}
