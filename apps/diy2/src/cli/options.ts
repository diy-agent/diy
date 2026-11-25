// src/cli/options.ts —— diy2 **全局参数声明的唯一处**（数据根 / 端口 / 入口名 / 工具面）。
//
// 三处消费，一份声明：
//   1. **CLI 产物**（src/cli/index.ts）：`web` / `stop` / `port` / `home` 各自把 `configShape`
//      合并进自己的 input —— 于是 `diy2 web --home X` 与 `diy2 port --home X` 认同一组选项、
//      同一套校验；
//   2. **服务端入口**（`build/prod/server/index.mjs`）与 **dev 入口**（server/dev.ts）：
//      `parseEntryOptions(serverOptions | devOptions, argv, usage)` —— 与 CLI 同一个解析器
//      （`@diy-agent/rpc/cli`：kebab 别名 / 短名 / 类型预转 / zod 校验 / `--help` 预扫）。
//      它们不是「命令」，所以不套命令外壳，差别只有「解析失败时谁打 usage」；
//   3. **单测**：直接构造 `ConfigOverrides` 对象，不经 argv。
//
// 为什么不再有 `--variant` / `DIY2_*` 环境变量：见 server/config.ts 的文件头。
// 一句话：**参数是 argv 的事，环境变量只出不进**。

import { z } from 'zod';
import '@diy-agent/rpc'; // `.cliOption()` 的 zod 扩展（副作用补丁，必须在 zod 链之前 import）
import { parseOptions } from '@diy-agent/rpc/cli';

import type { ConfigOverrides } from '../../server/config';

/** 数据根缺省的说明文案（缺省值由 server/config.ts 裁决，这里只说规则） */
const HOME_DESC = '数据根（缺省：生产 ~/.diy/diy2；非生产必须显式给）';

export const ENV_VALUES = ['production', 'development', 'test'] as const;

/**
 * 配置类选项的字段（**不是**完整 schema：各命令 / 各入口自己认为哪些有缺省）。
 *
 * 用 shape 而不是整个 object 复用：生产入口的 `mode` 缺省 production、dev 入口缺省
 * development —— 同一批字段，不同的入口语义。
 */
export const configShape = {
    home: z.string().optional().cliOption({ placeholder: 'dir', desc: HOME_DESC }),
    port: z.number().int().min(0).max(65535).optional().cliOption({
        short: 'p',
        placeholder: 'n',
        desc: '端口；0 = 内核分配（缺省：生产 5192，其余沿用 <home>/app.port）',
    }),
    name: z.string().optional().cliOption({ placeholder: '名字', desc: '实例名（多实例时人认得出的身份）' }),
    launch: z
        .string()
        .optional()
        .cliOption({ placeholder: '名字', desc: '入口名（prod / lab / staging / test…；缺省由环境推）' }),
    tools: z.enum(['shell', 'files']).optional().cliOption({ desc: '工具面：shell = 带 bash；files = 只读文件工具' }),
    maxSteps: z.number().int().min(1).optional().cliOption({
        placeholder: 'n',
        desc: '一轮的步数上限（缺省 = 内核 200；防止工具死循环烧钱）',
    }),
    bashTimeoutMs: z.number().int().min(1).optional().cliOption({
        placeholder: 'ms',
        desc: '单条 bash 命令的超时毫秒（缺省 = 内核 300s）',
    }),
    allowProdHome: z.boolean().optional().cliOption({ desc: '显式放行生产数据根（只给 dev 入口用）' }),
    webDir: z.string().optional().cliOption({
        placeholder: 'dir',
        desc: 'UI 产物目录（缺省 <buildRoot>/web；调试用）',
    }),
    modelConfig: z.string().optional().cliOption({
        placeholder: 'file',
        desc: 'model.yaml 路径（缺省：<home>/model.yaml；测试实例不读生产那档）',
    }),
} as const;

/** 完整配置对象（CLI 各命令把它并进自己的 input） */
export const configOptions = z.object(configShape);

export type ConfigOptions = z.infer<typeof configOptions>;

/** 服务端入口：`mode` 缺省 production（`diy2 web` / staging 都用它） */
export const serverOptions = z.object({
    ...configShape,
    mode: z
        .enum(ENV_VALUES)
        .default('production')
        .cliOption({ desc: '运行环境（缺省 production；staging 用 development）' }),
});

/** dev 入口：`mode` 缺省 development（写进代码，不靠环境变量） */
export const devOptions = z.object({
    ...configShape,
    mode: z.enum(ENV_VALUES).default('development').cliOption({ desc: '运行环境（缺省 development）' }),
});

/** argv 选项值 → 配置对象（`undefined` 一律不写进 overrides，免得分不清「没给」和「给了空」） */
export function toOverrides(input: Partial<ConfigOptions>): ConfigOverrides {
    return {
        home: input.home,
        port: input.port,
        name: input.name,
        launch: input.launch,
        tools: input.tools,
        maxSteps: input.maxSteps,
        bashTimeoutMs: input.bashTimeoutMs,
        allowProdHome: input.allowProdHome === true ? true : undefined,
        webDir: input.webDir,
        modelConfig: input.modelConfig,
    };
}

/**
 * 配置对象 → argv（CLI 的 `web` 命令拉起服务端产物时用）。
 *
 * 为什么要转：服务端产物（`build/prod/server/index.mjs`）是**独立进程**，它自己的 argv 是
 * 唯一输入面（它同样不读环境）。这里不准备任何「已裁决」的值 —— 端口传**原始** `--port`
 * （传实际端口会把「0 = 内核分配」这种意图丢掉），数据根传原始 `--home`。
 */
export function toArgv(overrides: ConfigOverrides): string[] {
    const out: string[] = [];
    const push = (flag: string, value: string | number | undefined): void => {
        if (value !== undefined) out.push(flag, String(value));
    };
    push('--home', overrides.home);
    push('--port', overrides.port);
    push('--name', overrides.name);
    push('--launch', overrides.launch);
    push('--tools', overrides.tools);
    push('--max-steps', overrides.maxSteps);
    push('--bash-timeout-ms', overrides.bashTimeoutMs);
    push('--web-dir', overrides.webDir);
    push('--model-config', overrides.modelConfig);
    if (overrides.allowProdHome === true) out.push('--allow-prod-home');
    return out;
}

/** `parseEntryOptions` 的结果：要么拿到 input，要么该退出（help / 用法错） */
export type EntryParse<T> = { input: T; exit: null } | { input: null; exit: number };

/**
 * 入口脚本读自己那几个参数（服务端 / dev 入口）。
 *
 * 与 CLI 同一个解析器，只是**失败时打 usage 并返回退出码**（而不是自己 exit）——
 * 入口脚本可能还被别的东西 import（测试 / 装配），突然退进程是不礼貌的。
 */
export function parseEntryOptions<TSchema extends z.ZodObject<z.ZodRawShape>>(
    schema: TSchema,
    argv: string[],
    usage: string,
): EntryParse<z.infer<TSchema>> {
    try {
        const { input, helpRequested } = parseOptions(schema, argv);
        if (helpRequested) {
            console.log(usage);
            return { input: null, exit: 0 };
        }
        return { input, exit: null };
    } catch (error) {
        console.error(`[diy2] 参数错误：${(error as Error).message}`);
        console.error(usage);
        return { input: null, exit: 2 };
    }
}
