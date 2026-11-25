// src/cli/instance.ts —— 本机实例域（list / stop / port / home）+ `web`（进程生命周期）。
//
// 为什么从 `bin/diy2` 搬到这里：CLI 命令树由 `@diy-agent/rpc/cli` 生成（mem 传输，进程内），
// 域定义与 handlers 都在 TS 里，才能被 `./sha.sh check` 与单测覆盖。
// bin/diy2 现在只剩一件事：找到 CLI 产物、清掉继承来的 `DIY2_*`、把 argv 原样交过去。
//
// 参数面：`--home` / `--port` / `--name` / `--launch` … 声明在 ./options（一份形状，三处消费：
// 这里、服务端入口、单测）。数据根 / 端口的**裁决**在 `server/config.ts` —— 这里只把
// argv 翻成 overrides 再问它，不自己算一遍。
//
// 判据与 `server/config.ts` / `server/registry.ts` / `server/probe.ts` 共用一份：
// 端口不承载身份（`app.port` 只是「上次用的端口」），存活 = `/api/info` 自报 home + pid。
//
// 依赖方向（避免成环）：本文件 → web.ts → {server/probe.ts, ./stop.ts}；
// web.ts **不** import 本文件（stopOne / probeMine 已经搬出去），所以顶层求值没有 TDZ。

import { z } from 'zod';
import { RpcSchema } from '@diy-agent/rpc';

import { resolveConfig, samePath, type ConfigOverrides, type Diy2Config } from '../../server/config';
import { readAppRecords, registryDir, type InstanceRecord } from '../../server/registry';
import { probeMine } from '../../server/probe';
import { configShape, toOverrides, type ConfigOptions } from './options';
import { webHandler, webProcedure } from './web';
import { stopOne } from './stop';

/** 一行实例（对外形状；`home` = 实例自报的数据根，不是本进程的） */
const InstanceRow = z.object({
    pid: z.number(),
    port: z.number().nullable(),
    home: z.string(),
    /** 老字段（= launch 的值）：外部脚本还在读它 */
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
                    desc: `停实例：缺省 = --home（缺省生产根 ~/.diy/diy2）；--all = 本机全部；--worktree <dir> = 那个 worktree 的全部`,
                    input: {
                        ...configShape,
                        all: z.boolean().optional().cliOption({ desc: '停本机全部 diy2 实例' }),
                        worktree: z
                            .string()
                            .optional()
                            .cliOption({ desc: '只停这个 worktree 起的实例（按记录里的 worktree 根精确匹配）' }),
                    },
                    output: z.object({ stopped: z.number(), instances: z.array(InstanceRow) }),
                }),
                port: RpcSchema.unary({
                    desc: `本数据根实例的实际端口（给脚本用；没有在跑的实例 → 退出码 1）`,
                    input: { ...configShape },
                    output: z.number(),
                }),
                home: RpcSchema.unary({
                    desc: `本数据根（给脚本用；裁决规则同 --home）`,
                    input: { ...configShape },
                    output: z.string(),
                }),
                web: webProcedure,
            },
        }),
    },
});

/** handlers 的依赖（单测可换掉注册表目录 / 探活，不碰真实注册表与网络） */
export interface InstanceDeps {
    /** 用来向上找 appRoot（CLI 产物里传 `import.meta.dirname`） */
    readonly moduleDir?: string;
    readonly dir?: string;
    readonly probeMine?: (config: Diy2Config) => Promise<{ pid: number; port: number; home: string } | null>;
}

/** argv 选项 → 配置（instance 命令都在发布形态里跑，环境固定 production） */
async function configOf(moduleDir: string, input: Partial<ConfigOptions>): Promise<Diy2Config> {
    const overrides: ConfigOverrides = toOverrides(input);
    return resolveConfig({ moduleDir, mode: 'production', overrides });
}

export function instanceHandlers(deps?: Partial<InstanceDeps>): {
    instance: {
        list: () => Promise<{ instances: ReturnType<typeof rowOf>[] }>;
        stop: (req: { input: { all?: boolean; worktree?: string } & Partial<ConfigOptions> }) => Promise<{
            stopped: number;
            instances: ReturnType<typeof rowOf>[];
        }>;
        port: (req: { input: Partial<ConfigOptions> }) => Promise<number>;
        home: (req: { input: Partial<ConfigOptions> }) => Promise<string>;
        web: ReturnType<typeof webHandler>;
    };
} {
    const moduleDir = deps?.moduleDir ?? import.meta.dirname;
    const dir = deps?.dir ?? registryDir();
    const probeIt = deps?.probeMine ?? probeMine;

    return {
        instance: {
            list: async () => ({ instances: (await readAppRecords(dir)).map(rowOf) }),
            stop: async ({ input }) => {
                const config = await configOf(moduleDir, input);
                const records = (await readAppRecords(dir)).filter((rec) => {
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
                            launch: config.launch,
                            worktree: null,
                            name: null,
                            mode: null,
                            port: mine.port,
                            pingPort: null,
                            diyHome: mine.home,
                            variant: config.launch,
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
            port: async ({ input }) => {
                const mine = await probeIt(await configOf(moduleDir, input));
                if (mine === null) throw new Error('本数据根上没有在跑的实例');
                return mine.port;
            },
            home: async ({ input }) => (await configOf(moduleDir, input)).home,
            web: webHandler(moduleDir),
        },
    };
}
