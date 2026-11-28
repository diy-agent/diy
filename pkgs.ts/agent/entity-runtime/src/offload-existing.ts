// offload-existing.ts —— 存量工具输出一次性搬出库（2026-11-28）。
//
// 为什么要有它：写入闸（`projection.ts` 的 `tool.completed`）只对新数据生效，
// 而真库里已经躺着 36,155 条 `tool` 条目 / 145MB（5 条 ≥4MB 吃 60MB，最大单条 31MB）。
// 不搬，库里那 145MB 永远不会自己变小。
//
// 规矩（与写入闸同一套判据，不发明新的）：
//   · 已有 `data.output` ⇒ 跳过（幂等：重跑不会二次搬家）；
//   · `data.result` 不是字符串（结构化结果）⇒ 不动；
//   · ≤ 64KB ⇒ 不动（今天平均 2.2KB，几千个小文件比留在库里更糟）；
//   · 写盘失败 ⇒ 这条不动（宁可库大一点，也不能丢原文）。
//
// **不自己开库**：调用方传 `DatabaseSync`（迁移脚本 / CLI 负责「先停实例 + 备份 + 跑完 VACUUM」）。
// 这里只碰两张事实：`entity_items.item` 与新目录 `runs/tool/…`。

import type { DatabaseSync } from 'node:sqlite';

import type { Item } from '@diy-agent/protocol';

import { OUTPUT_OFFLOAD_BYTES, createOutputStore } from './output-store';

export interface OffloadStats {
    /** 扫过的 tool 条目 */
    scanned: number;
    /** 真搬出去的条数 */
    offloaded: number;
    /** 已经有 output（幂等跳过） */
    alreadyOffloaded: number;
    /** 没超阈值 / 不是字符串 */
    stayed: number;
    /** 写盘失败（条目保持原样） */
    failed: number;
    /** 正文从表里挪走的字节数（约等于库能少多少） */
    bytesMoved: number;
}

interface Row {
    seq: number;
    entity_id: string;
    item: string;
    at: number | null;
}

const BATCH = 200;

/**
 * 把库里超阈值的工具输出正文搬到 `runs/tool/…`，并把条目改写为 `data.output` 引用。
 *
 * @param db      已打开的库（迁移脚本保证没有实例在写）
 * @param options `dataRoot` = 数据根（ref 相对它）；`dryRun` = 只统计不改
 */
export function offloadExistingToolOutputs(
    db: DatabaseSync,
    options: { readonly dataRoot: string; readonly dryRun?: boolean },
): OffloadStats {
    const store = createOutputStore({ dataRoot: options.dataRoot });
    const stats: OffloadStats = {
        scanned: 0,
        offloaded: 0,
        alreadyOffloaded: 0,
        stayed: 0,
        failed: 0,
        bytesMoved: 0,
    };

    const select = db.prepare(
        `SELECT seq, entity_id, json_extract(item, '$.at') AS at, item
           FROM entity_items
          WHERE json_extract(item, '$.type') = 'tool' AND seq > ?
          ORDER BY seq
          LIMIT ${BATCH}`,
    );
    const update = db.prepare('UPDATE entity_items SET item = ? WHERE seq = ?');

    let after = 0;
    for (;;) {
        const rows = select.all(after) as unknown as Row[];
        if (rows.length === 0) break;
        after = Number(rows[rows.length - 1]!.seq);

        if (options.dryRun !== true) db.exec('BEGIN');
        try {
            for (const row of rows) {
                stats.scanned += 1;
                const item = JSON.parse(row.item) as Extract<Item, { type: 'tool' }>;
                const data = item.data;
                if (data.output !== undefined) {
                    stats.alreadyOffloaded += 1;
                    continue;
                }
                const result = data.result;
                if (typeof result !== 'string' || Buffer.byteLength(result, 'utf8') <= OUTPUT_OFFLOAD_BYTES) {
                    stats.stayed += 1;
                    continue;
                }
                // dryRun **不写盘**：只统计「会搬多少」，不往数据根丢文件
                if (options.dryRun === true) {
                    stats.bytesMoved += Buffer.byteLength(result, 'utf8');
                    stats.offloaded += 1;
                    continue;
                }
                // item.id 形如 `tool-${toolCallId}`（projection 的 tool.started）；迁移时按它还原
                const callId = item.id.startsWith('tool-') ? item.id.slice('tool-'.length) : item.id;
                const ref = store.put(row.entity_id, row.at ?? Date.now(), callId, result);
                if (ref === undefined) {
                    stats.failed += 1;
                    continue;
                }
                delete data.result;
                data.output = ref;
                stats.bytesMoved += Buffer.byteLength(result, 'utf8');
                stats.offloaded += 1;
                update.run(JSON.stringify(item), row.seq);
            }
            if (options.dryRun !== true) db.exec('COMMIT');
        } catch (error) {
            if (options.dryRun !== true) db.exec('ROLLBACK');
            throw error;
        }
    }
    return stats;
}
