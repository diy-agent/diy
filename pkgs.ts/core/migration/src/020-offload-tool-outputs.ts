import { TOOL_OUTPUT_OFFLOAD_BYTES, toolOutputsToOffload } from './tool-output.js';
import type { Migration } from './types.js';

/**
 * 存量工具输出搬出库（2026-11-28）。
 *
 * 为什么要有它：写入闸只对**新**条目生效，而真库里已经躺着 3.6 万条 `tool` / 145MB，
 * 其中 31 条 >64KB 吃掉了 59MB（最大单条 31MB）。不搬，这部分体积永远不会自己变小，
 * 而它们没有任何查询价值：界面要的是「跑了什么、成没成、头尾几行」。
 *
 * 为什么做成迁移而不是「启动时自动跑」：
 *   · 迁移器已有**子进程 + 进度 + 事务 + 记账**这套骨架，天然满足「要几秒且不能卡事件循环」；
 *   · 一次性历史转换，迁过就该记住（`schema_migrations`），重跑没有意义；
 *   · 由**迁移页**触发，人挑时间做 —— 不是为了省事而把它塞进启动同步段。
 *
 * VACUUM 不在这里：它不能跑在事务里，而且需要独占库。迁移子进程在整段迁移**之后**做
 * （见 `apps/diy2/server/migrate-worker.ts`）；这里只负责把正文挪到文件、把条目改小。
 *
 * 幂等：已有 `data.output` 的条目跳过；写盘失败的单条保持原样（`failed` 计数）。
 */
export const migration: Migration = {
    id: 'offload-tool-outputs',
    title: '工具输出正文搬出库（>64KB → runs/tool/…）',
    plan: {
        from: `entity_items 里 >${String(TOOL_OUTPUT_OFFLOAD_BYTES / 1024)}KB 的 tool 正文`,
        to: 'runs/tool/<日>/<房间>/<callId>.txt + data.output 引用',
        note: '正文进文件、条目只留引用与头尾预览；迁完 VACUUM 才把空间还给文件系统',
        rows: (rt) => toolOutputsToOffload(rt.db).rows,
        detail: (rt) => {
            const { rows, bytes } = toolOutputsToOffload(rt.db);
            if (rows === 0) return '没有需要搬的条目';
            const mb = bytes / 1048576;
            return `会搬 ${String(rows)} 条 / ${mb >= 0.1 ? `${mb.toFixed(1)}MB` : `${String(Math.round(bytes / 1024))}KB`}`;
        },
    },
    done: (rt) => toolOutputsToOffload(rt.db).rows === 0,
    up: (rt) => {
        const stats = rt.offloadToolOutputs((done, total) => {
            rt.progress?.(done, total);
        });
        const mb = stats.bytesMoved / 1048576;
        rt.log(
            `工具输出外置：搬走 ${String(stats.offloaded)} 条 / ${mb.toFixed(1)}MB` +
                (stats.failed > 0 ? `；${String(stats.failed)} 条写盘失败（保持原样）` : ''),
        );
    },
};
