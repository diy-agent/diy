// src/cli/instance.ts —— 本机实例域（list / stop / port / home）。
//
// 为什么从 `bin/diy2` 搬到这里：CLI 命令树由 `@diy-agent/rpc/cli` 生成（mem 传输，进程内），
// 域定义与 handlers 都在 TS 里，才能被 `./sha.sh check` 与单测覆盖；bin 只剩：
//   · `start` 的进程生命周期（前台跑、Ctrl-C 停、`--restart`）—— 它不是一次「命令调用」；
//   · 把参数翻译成 `DIY2_*` 环境变量，然后转调本 CLI 产物。
//
// 判据与 `server/config.ts` / `server/registry.ts` / `server/probe.ts` 共用一份：
// 端口不承载身份（`app.port` 只是「上次用的端口」），存活 = `/api/info` 自报 home + pid。

import { z } from 'zod';
import { RpcSchema } from '@diy-agent/rpc';

import { readPortFile, resolveConfig, samePath, type Diy2Config } from '../../server/config';
import { isPidAlive, readAppRecords, registryDir, type InstanceRecord } from '../../server/registry';
import { probe } from '../../server/probe';

/** 一行实例（对外形状；`home` = 实例自报的数据根，不是本进程的） */
const InstanceRow = z.object({
    pid: z.number(),
    port: z.number().nullable(),
    home: z.string(),
    variant: z.string(),
    env: z.string(),
    launch: z.string().nullable(),
    name: z.string().nullable(),
    worktree: z.string().nullable(),
    startedAt: z.string(),
    updatedAt: z.string(),
});

function rowOf(rec: InstanceRecord): z.infer<typeof InstanceRow> {
    return {
        pid: rec.pid,
        port: rec.port,
        home: rec.diyHome,
        variant: rec.variant,
        env: rec.env,
        launch: rec.launch,
        name: rec.name,
        worktree: rec.worktree,
        startedAt: rec.startedAt,
        updatedAt: rec.updatedAt,
    };
}

export const instanceApi = RpcSchema.group({
    children: {
        instance: RpcSchema.group({
            desc: `本机 diy2 实例（注册表 + 探活；端口不承载身份，判据是 /api/info 自报的 home）`,
            children: {
                list: RpcSchema.unary({
                    alias: 'ps',
                    desc: `列出本机在跑的 diy2 实例（死进程顺手清掉）`,
                    input: {},
                    output: z.object({ instances: z.array(InstanceRow) }),
                }),
                stop: RpcSchema.unary({
                    desc: `停实例：缺省 = 本数据根；--all = 本机全部；--worktree <dir> = 那个 worktree 的全部`,
                    input: {
                        all: z.boolean().optional().cliOption({ desc: '停本机全部 diy2 实例' }),
                        worktree: z
                            .string()
                            .optional()
                            .cliOption({ desc: '只停这个 worktree 起的实例（目录前缀匹配）' }),
                    },
                    output: z.object({ stopped: z.number(), instances: z.array(InstanceRow) }),
                }),
                port: RpcSchema.unary({
                    desc: `本数据根实例的实际端口（给脚本用；没有在跑的实例 → 退出码 1）`,
                    input: {},
                    output: z.number(),
                }),
                home: RpcSchema.unary({
                    desc: `本数据根（给脚本用）`,
                    input: {},
                    output: z.string(),
                }),
            },
        }),
    },
});

const STOP_TIMEOUT_MS = 3000;
const STOP_POLL_MS = 100;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/** SIGTERM → 等 → 仍在则 SIGKILL；返回是否真的发过信号（已经没了 = false） */
async function stopOne(pid: number): Promise<boolean> {
    try {
        process.kill(pid, 'SIGTERM');
    } catch {
        return false;
    }
    const startedAt = Date.now();
    while (isPidAlive(pid) && Date.now() - startedAt < STOP_TIMEOUT_MS) await delay(STOP_POLL_MS);
    if (isPidAlive(pid)) {
        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            /* 刚好自己退了 */
        }
    }
    return true;
}

/** 本数据根在跑的实例（`app.port` 只给候选端口，身份靠探活回包） */
export async function probeMine(config: Diy2Config): Promise<{ pid: number; port: number; home: string } | null> {
    const port = readPortFile(config.portFile);
    if (port === null) return null;
    const result = await probe(port, config.home);
    if (result.kind !== 'mine' || result.info === undefined) return null;
    const info = result.info;
    if (info.port === null) return null;
    return { pid: info.pid, port: info.port, home: info.home };
}

/** handlers 的依赖（单测可换掉目录 / 探活，不碰真实注册表与网络） */
export interface InstanceDeps {
    readonly config: Diy2Config;
    readonly dir?: string;
    readonly probeMine?: (config: Diy2Config) => Promise<{ pid: number; port: number; home: string } | null>;
}

export function instanceHandlers(deps?: Partial<InstanceDeps>): {
    instance: {
        list: () => { instances: ReturnType<typeof rowOf>[] };
        stop: (req: { input: { all?: boolean; worktree?: string } }) => Promise<{
            stopped: number;
            instances: ReturnType<typeof rowOf>[];
        }>;
        port: () => Promise<number>;
        home: () => string;
    };
} {
    const config = deps?.config ?? resolveConfig();
    const dir = deps?.dir ?? registryDir();
    const probeIt = deps?.probeMine ?? probeMine;

    return {
        instance: {
            list: () => ({ instances: readAppRecords(dir).map(rowOf) }),
            stop: async ({ input }) => {
                const records = readAppRecords(dir).filter((rec) => {
                    if (input.all === true) return true;
                    if (input.worktree !== undefined) {
                        return rec.worktree !== null && samePath(rec.worktree, input.worktree);
                    }
                    return samePath(rec.diyHome, config.home);
                });
                const stopped: InstanceRecord[] = [];
                for (const rec of records) {
                    if (await stopOne(rec.pid)) stopped.push(rec);
                }
                // 注册表没记录时，拿 app.port 里的端口试一次（老版本起的无注册表实例）。
                // 记录不证明存活，只是候选地址；身份仍由回包校验。
                if (stopped.length === 0 && input.all !== true && input.worktree === undefined) {
                    const mine = await probeIt(config);
                    if (mine !== null && (await stopOne(mine.pid))) {
                        const now = new Date().toISOString();
                        stopped.push({
                            pid: mine.pid,
                            app: 'diy2',
                            launch: null,
                            worktree: null,
                            name: null,
                            mode: null,
                            port: mine.port,
                            pingPort: null,
                            diyHome: mine.home,
                            variant: config.variant,
                            env: config.env,
                            argv: [],
                            cwd: '',
                            startedAt: now,
                            updatedAt: now,
                            parents: [],
                        });
                    }
                }
                return { stopped: stopped.length, instances: stopped.map(rowOf) };
            },
            port: async () => {
                const mine = await probeIt(config);
                if (mine === null) throw new Error('本数据根上没有在跑的实例');
                return mine.port;
            },
            home: () => config.home,
        },
    };
}
