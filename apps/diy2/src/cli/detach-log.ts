// detach-log.ts —— `--detach` 后台实例的输出落盘（`<home>/log/stdout.log`）。
//
// 为什么要有：以前 detach 用 `stdio: 'ignore'`，进程的终端输出直接丢弃 ——
// 想留日志的人只能自己 `nohup … >> /tmp/xxx.log 2>&1`，输出散落各处、/tmp 还会被清
// （实测现场：prod 实例的输出落在 /tmp/diy2-prod-stdout.log）。
// 现在由 CLI 统一把 fd1/fd2 接到 `<home>/log/stdout.log`（append + 超限滚动），
// 与 `<home>/log/app/`（OTel jsonl 主账）同一数据根 —— 清 home 就清干净。
//
// 轮转口径与 diy-app diagnostics 同款（简单覆盖 `.1`）：打开前超 10MB 就 rename，
// 中途失败最多丢历史那份 —— 日志是旁路，绝不把启动带崩。
//
// 写进去的内容 = TerminalLogRecordExporter 的终端行（`[diy2:boot] …`）⊕ 裸 stderr
// （未捕获异常、第三方 console）；结构化主账仍在 `log/app/*.log`，这里只是人读那一份。

import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 单文件上限：超了滚动为 `.1`（旧 `.1` 被覆盖 —— 与 diagnostics 的 MAX_LOG_BYTES 同款简单口径） */
const MAX_BYTES = 10 * 1024 * 1024;

/** 后台输出日志的绝对路径（`<home>/log/stdout.log`） */
export function detachLogPath(home: string): string {
    return join(home, 'log', 'stdout.log');
}

/**
 * 打开后台输出日志（append），返回 fd 给 spawn 的 `stdio` 用。
 *
 * 调用方在 spawn 之后要 `closeSync` 掉自己这份（子进程有自己的副本）。
 * 任何一步失败都返回 null —— 退回 `stdio: 'ignore'` 语义，
 * **日志写不进去不许把起服务挡死**。
 */
export function openDetachLog(home: string): number | null {
    const file = detachLogPath(home);
    try {
        mkdirSync(dirname(file), { recursive: true });
        if (existsSync(file) && statSync(file).size > MAX_BYTES) {
            renameSync(file, `${file}.1`);
        }
        return openSync(file, 'a');
    } catch {
        return null;
    }
}

/** 关掉父进程这份 fd（null 安全；spawn 后调用） */
export function closeDetachLog(fd: number | null): void {
    if (fd === null) return;
    try {
        closeSync(fd);
    } catch {
        /* 已关 / 关失败都不影响子进程（它有自己的副本） */
    }
}
