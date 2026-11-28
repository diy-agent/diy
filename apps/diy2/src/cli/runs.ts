// src/cli/runs.ts —— 运行产物目录（`<home>/runs/`）的维护命令。
//
// 今天只有一个真命令：`offload` —— 把库里超阈值的工具输出正文搬到 `runs/tool/…`。
// 为什么做成 CLI 而不是「启动时自动跑」：145MB 里 31 条要搬 59MB，跑起来要几秒，
// 而且改的是历史条目 —— 放进 `createDiy2App` 的同步装配段就是拿启动时间换库体积。
// 运维动作就该由人挑时间做（`diy2 stop` → `diy2 runs offload` → `diy2 web`）。
//
// `--dry-run` 是默认的第一次跑法：只统计「会搬多少条 / 多少 MB」，一个字不改。

import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';
import { RpcSchema } from '@diy-agent/rpc';

import { offloadExistingToolOutputs } from '@diy-agent/entity-runtime';

const OffloadStats = z.object({
    scanned: z.number(),
    offloaded: z.number(),
    alreadyOffloaded: z.number(),
    stayed: z.number(),
    failed: z.number(),
    bytesMoved: z.number(),
});

export const runsApi = RpcSchema.group({
    children: {
        runs: RpcSchema.group({
            desc:
                '运行产物（`<home>/runs/`：工具输出 / 作业日志）的维护。' +
                '\n\n**存量库第一次瘦身 → `diy2 runs offload --dry-run` 看会搬多少，再去掉 dry-run 真跑**；' +
                '跑完 `VACUUM` 才把空间还给文件系统。',
            children: {
                offload: RpcSchema.unary({
                    desc:
                        '把库里超过 64KB 的工具输出正文搬到 `<home>/runs/tool/<日>/<房间>/<callId>.txt`，' +
                        '条目改写为 `data.output` 引用（幂等：重跑只搬新的）',
                    input: {
                        home: z
                            .string()
                            .optional()
                            .cliOption({ placeholder: 'dir', desc: '数据根（缺省 ~/.diy2）' }),
                        db: z
                            .string()
                            .optional()
                            .cliOption({ placeholder: 'file', desc: '库文件（缺省 <home>/diy2.db）' }),
                        dryRun: z
                            .boolean()
                            .default(false)
                            .cliOption({ desc: '只统计，不改库、不写盘（第一次先用它）' }),
                    },
                    output: OffloadStats,
                }),
            },
        }),
    },
});

export function runsHandlers(): {
    runs: {
        offload: (req: { input: { home?: string; db?: string; dryRun: boolean } }) => z.infer<typeof OffloadStats>;
    };
} {
    return {
        runs: {
            offload({ input }) {
                const home = input.home ?? join(homedir(), '.diy2');
                const file = input.db ?? join(home, 'diy2.db');
                const db = new DatabaseSync(file);
                try {
                    // 在线跑（实例还开着）时最多等 5s 拿写锁，别当场 SQLITE_BUSY
                    db.exec('PRAGMA busy_timeout = 5000');
                    return offloadExistingToolOutputs(db, { dataRoot: home, dryRun: input.dryRun });
                } finally {
                    db.close();
                }
            },
        },
    };
}
