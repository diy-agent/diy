// src/ops-io.ts
// 🎯 ops 行的**读**（写见 turns.ts 的 `createOpsAppender`）：按字节偏移读、跳前缀、找轮首。
//
// 为什么读也要在包里（##432 刀 1）：`ops` 是「turns 的 ref 指向的东西」—— 读同一份文件、
// 认同一套行首/半行约束，才谈得上「core 只依赖接口」。core 拿到的是**已解好的 op 数组**。

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

/** 文件字节大小（不存在 = 0） */
export function fileSize(fp: string): number {
    try {
        return statSync(fp).size; // sync-io-ok: 一次 stat（冷加载路径）
    } catch {
        return 0;
    }
}

/** 文件的完整行数（分块数换行，不整份读进内存；断代路径专用） */
export function countFileLines(fp: string): number {
    if (!existsSync(fp)) return 0;
    const CHUNK = 256 * 1024;
    let n = 0;
    try {
        const fd = openSync(fp, "r"); // sync-io-ok: 断代路径一次（冷加载）
        try {
            const buf = Buffer.allocUnsafe(CHUNK);
            let got: number;
            while ((got = readSync(fd, buf, 0, CHUNK, null)) > 0) {
                for (let i = 0; i < got; i++) if (buf[i] === 0x0a) n++;
            }
        } finally {
            closeSync(fd); // sync-io-ok: 同一 open/close 对
        }
    } catch {
        return 0;
    }
    return n;
}

/**
 * 读 `[from, to)` 的 op 行，返回实际消费到的字节偏移（只到**最后一个完整行**为止，
 * 尾部半行留给下一次）。
 *
 * 为什么不是「读满一次就完事」（任务 290 review B1）：`Buffer.allocUnsafe` 的未初始化区
 * 在短读（信号打断、offset 越界）时会被当作日志解析 —— 未初始化堆内存里恰好有个换行，
 * 消费位置就会被推过真实数据，**永久跳掉一段对话**。故：循环读满 + 一切以 got 为界。
 */
export function readOpsRange<T = unknown>(fp: string, from: number, to: number): { ops: T[]; consumed: number } {
    const len = to - from;
    if (len <= 0) return { ops: [], consumed: from };
    const fd = openSync(fp, "r");
    try {
        const buf = Buffer.allocUnsafe(len);
        let got = 0;
        while (got < len) {
            const n = readSync(fd, buf, got, len - got, from + got);
            if (n <= 0) break;
            got += n;
        }
        const lastNl = got > 0 ? buf.lastIndexOf(0x0a, got - 1) : -1;
        if (lastNl < 0) return { ops: [], consumed: from }; // 连一行都还完整不了
        const text = buf.subarray(0, lastNl + 1).toString("utf-8");
        const ops: T[] = [];
        for (const line of text.split("\n")) {
            const t = line.trim();
            if (!t) continue;
            try {
                ops.push(JSON.parse(t) as T);
            } catch (e) {
                console.warn(`[persistence] 跳过无法解析的 jsonl 行 ${fp}:`, String(e).slice(0, 120));
            }
        }
        return { ops, consumed: from + lastNl + 1 };
    } finally {
        closeSync(fd);
    }
}

/** `at-1` 处的字节是不是换行（读不到就当是 —— 宁可按行首处理，不无端跳行） */
function prevByteIsNewline(fp: string, at: number): boolean {
    try {
        const fd = openSync(fp, "r"); // sync-io-ok: 单字节校验（冷加载）
        try {
            const b = Buffer.allocUnsafe(1);
            if (readSync(fd, b, 0, 1, at - 1) !== 1) return true;
            return b[0] === 0x0a;
        } finally {
            closeSync(fd); // sync-io-ok: 同一 open/close 对
        }
    } catch {
        return true;
    }
}

/** 从 `at` 向后找下一个行首（= 第一个 `\n` 之后）；找不到（尾部半行）= 文件尾 */
function skipToNextLineStart(fp: string, at: number, size: number): number {
    const CHUNK = 64 * 1024;
    try {
        const fd = openSync(fp, "r"); // sync-io-ok: 冷加载路径
        try {
            const buf = Buffer.allocUnsafe(CHUNK);
            let pos = at;
            while (pos < size) {
                const want = Math.min(CHUNK, size - pos);
                const got = readSync(fd, buf, 0, want, pos);
                if (got <= 0) break;
                const nl = buf.subarray(0, got).indexOf(0x0a);
                if (nl >= 0) return pos + nl + 1;
                pos += got;
            }
        } finally {
            closeSync(fd); // sync-io-ok: 同一 open/close 对
        }
    } catch {
        /* 读不到就当文件尾 */
    }
    return size;
}

/**
 * 从 `from` 字节读到文件尾 → op 列表（##420：会话加载的**唯一跳前缀入口**）。
 *
 * 多一道**行首校验**：`from` 来自压缩边界的锚点（理论上必是轮首行的行首），但边界可能被手改 /
 * 来自旧版本，一旦指到行中（更糟：多字节 UTF-8 字符中间），从那儿解出的第一条就是半行脏 JSON。
 * 故：只有当 `from-1` 处的字节是 `\n` 才认它是行首，否则向后跳到下一个行首再开始。
 */
export function readOpsFrom<T = unknown>(fp: string, from: number): T[] {
    const size = fileSize(fp);
    if (size <= 0) return [];
    let start = Math.max(0, Math.min(from, size));
    if (start > 0 && start < size) {
        if (!prevByteIsNewline(fp, start)) start = skipToNextLineStart(fp, start, size);
    }
    if (start >= size) return [];
    return readOpsRange<T>(fp, start, size).ops;
}

/**
 * 按轮 id 找它 `start` 行的字节偏移（压缩边界记 ops 锚点时用；找不到 = -1）。
 *
 * 成本 = 一次顺序扫描（只在**压缩事件**里调，不是每步）。判据用 JSON 解析复核，
 * 不靠字面前缀（内容里凑巧出现同样字节串不算）。
 */
export function findTurnOffset(fp: string, turnId: string): number {
    const size = fileSize(fp);
    if (size <= 0) return -1;
    const CHUNK = 256 * 1024;
    const needle = Buffer.from(`{"op":"start","id":${JSON.stringify(turnId)},"kind":"turn"`, "utf-8");
    const fd = openSync(fp, "r");
    try {
        const buf = Buffer.allocUnsafe(CHUNK + needle.length);
        let from = 0;
        while (from < size) {
            const want = Math.min(CHUNK, size - from);
            let got = 0;
            while (got < want) {
                const n = readSync(fd, buf, got, want - got, from + got);
                if (n <= 0) break;
                got += n;
            }
            const view = buf.subarray(0, got + (from + got < size ? Math.min(needle.length, size - from - got) : 0));
            // 读跨块边界的一小段尾巴，避免轮首行落在块尾时漏检
            let hit = view.indexOf(needle);
            while (hit >= 0) {
                const at = from + hit;
                if (at <= size && isTurnStartAt(fp, at)) return at;
                hit = view.indexOf(needle, hit + 1);
            }
            if (from + got >= size) break;
            from += got;
        }
    } finally {
        closeSync(fd);
    }
    return -1;
}

/** `at` 处是否是一条轮 `start` 行的**行首**（字节级 BOM/短路校验）。 */
export function isTurnStartAt(fp: string, at: number): boolean {
    let fd: number;
    try {
        fd = openSync(fp, "r");
    } catch {
        return false;
    }
    try {
        if (at > 0) {
            const b = Buffer.allocUnsafe(1);
            if (readSync(fd, b, 0, 1, at - 1) !== 1 || b[0] !== 0x0a) return false;
        }
        const buf = Buffer.allocUnsafe(4096);
        const got = readSync(fd, buf, 0, buf.length, at);
        if (got <= 0) return false;
        const nl = buf.subarray(0, got).indexOf(0x0a);
        const line = buf.subarray(0, nl < 0 ? got : nl).toString("utf-8");
        try {
            const op = JSON.parse(line) as { op?: unknown; kind?: unknown };
            return op.op === "start" && op.kind === "turn";
        } catch {
            return false;
        }
    } finally {
        closeSync(fd);
    }
}
