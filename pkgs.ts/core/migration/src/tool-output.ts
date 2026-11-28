// tool-output.ts —— 「哪些 tool 正文该搬出库」的唯一判据（2026-11-28）。
//
// 为什么判据放在迁移包里：外置既是**写入闸**（新条目在投影层就落盘）也是**存量迁移**（老条目
// 由 020 搬走）。两边一旦各写一份阈值 / 条件，就会出现「新条目搬了、老条目说搬完了却没搬」。
// 这里只依赖 SQL 与纯对象，不认识 store —— 迁移包零领域依赖的约定不变。
//
// 判据只有一条：`data.result` 的 **UTF-8 字节数** > 64KB，且还没有 `data.output`。
//   · 有 `output` ⇒ 正文已经在 `runs/tool/…` 文件里，幂等跳过；
//   · `result` 不是字符串（结构化结果，如截图）⇒ 不动；
//   · 64KB 是投递层的截断阈值（`TOOL_OUTPUT_MAX_BYTES`），与那边同一个数。

/** 超过这个字节数才外置（与投递层的 64KB 截断阈值同一个数） */
export const TOOL_OUTPUT_OFFLOAD_BYTES = 64 * 1024;

/**
 * 预筛阈值（字符数）：`length(item)` 数的是 JSON 文本的字符，判据却是 UTF-8 字节 ——
 * 一个中文字符占 3 字节，所以字符数最少可以是字节数的 1/3。预筛宽一点只是多解析几十行；
 * 窄了会**漏搬**（31MB 那种巨块就是靠这条筛出来的）。
 */
const PREFILTER_CHARS = Math.floor(TOOL_OUTPUT_OFFLOAD_BYTES / 3);

/**
 * 一条已解析的条目该搬多少字节；返回 undefined = 不该搬。
 * `offload` 逐条改写时也用这一个函数，保证与体检结果一致。
 */
export function offloadBytesOf(item: unknown): number | undefined {
    if (typeof item !== 'object' || item === null) return undefined;
    const record = item as { type?: unknown; data?: { output?: unknown; result?: unknown } };
    if (record.type !== 'tool') return undefined;
    const data = record.data;
    if (data === undefined || data === null) return undefined;
    if (data.output !== undefined) return undefined;
    if (typeof data.result !== 'string') return undefined;
    const bytes = Buffer.byteLength(data.result, 'utf8');
    return bytes > TOOL_OUTPUT_OFFLOAD_BYTES ? bytes : undefined;
}

/** 体检结果：还有多少条该搬、正文共多少字节 */
export interface ToolOutputOffloadPlan {
    rows: number;
    bytes: number;
}

/**
 * 只读体检（迁移页「会搬多少」与 `done()` 都靠它）。
 *
 * 不用 `json_extract` 全表扫：真库 4.3 万条 / 232MB 时那样要 4 秒；`length(item)` 预筛 +
 * 只解析长条目是 1.3 秒（迁移页打开一次、启动基线判断一次，可以接受）。
 */
export function toolOutputsToOffload(db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } }): ToolOutputOffloadPlan {
    let rows: Array<{ item: string }>;
    try {
        rows = db.prepare('SELECT item FROM entity_items WHERE length(item) > ?').all(PREFILTER_CHARS) as Array<{
            item: string;
        }>;
    } catch {
        return { rows: 0, bytes: 0 }; // 老库还没有 entity_items：没什么可搬
    }
    let count = 0;
    let bytes = 0;
    for (const row of rows) {
        let item: unknown;
        try {
            item = JSON.parse(row.item);
        } catch {
            continue;
        }
        const size = offloadBytesOf(item);
        if (size === undefined) continue;
        count += 1;
        bytes += size;
    }
    return { rows: count, bytes };
}
