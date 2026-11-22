// src/cli/web.ts —— `diy2 web`（别名 `start`）：**进程生命周期**那条命令。
//
// 为什么它在 CLI 里而不是 bin 里：bin/diy2 现在只做「把 argv 交给 CLI 产物」一件事
// （找产物路径 + 清环境），所有语义都在 TS 侧 —— 于是这条命令能被 `./sha.sh check` 与单测覆盖，
// 也不必为了「先解析两个参数」在 bin 里再写一份解析器（那正是这次重构要消掉的东西）。
//
// 语义（与仓库其它 app 一致）：**探活 → 验身份 → 复用或拉起**。
//   · 身份判据只有一条：`GET /api/info` 自报的 `home`（端口只是缓存，见 server/probe.ts）；
//   · 端口上的实例还可能是**别的数据根**的（别的 worktree / 别的实例）→ 报错，不串台；
//   · 拉起 = 起 `build/prod/server/index.mjs`（**独立进程**，argv 是它唯一的输入面）。
//
// 前台 vs 后台：前台 `stdio: 'inherit'`（日志直接进终端，Ctrl-C 一起退）；
// 后台 `detached + unref`，然后靠探活等它就绪（端口未知时只能这样等，`app.port` 不证明存活）。
//
// 依赖方向：本文件**不** import instance.ts（否则 instance → web → instance 成环，
// 顶层求值时 webProcedure 还在 TDZ 里）；共用的 probeMine / stopOne 各自在自己的模块。

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { RpcSchema } from '@diy-agent/rpc';

import { resolveConfig, serverEntryOf, webDirOf } from '../../server/config';
import { probeMine } from '../../server/probe';
import { configShape, toArgv, toOverrides } from './options';
import { stopOne } from './stop';

/** 后台等就绪 / 前台等自报，都最多等这么久 */
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 120;

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function urlOf(port: number): string {
    return `http://127.0.0.1:${port}`;
}

/** 打开浏览器：打不开就算了（不影响服务本身） */
function openBrowser(target: string): void {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
    try {
        spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
    } catch {
        /* 无桌面环境 */
    }
}

/** web 的入参形状（单独一段：`WebInput` 要能精确推导，`inputSchema` 的类型是宽的 `z.ZodType`） */
const webInputShape = {
    ...configShape,
    detach: z.boolean().optional().cliOption({ desc: '起在后台（脚本 / 启动器用）' }),
    restart: z.boolean().optional().cliOption({ desc: '先停掉同数据根的实例再起' }),
    open: z.boolean().optional().cliOption({ desc: '就绪后打开浏览器' }),
};

export type WebInput = z.infer<z.ZodObject<typeof webInputShape>>;

export const webProcedure = RpcSchema.unary({
    alias: ['start'],
    desc: `起服务（已有本数据根实例 → 复用；前台，Ctrl-C 停）`,
    input: webInputShape,
    output: z.object({
        port: z.number(),
        pid: z.number(),
        home: z.string(),
        reused: z.boolean(),
    }),
});

/** 后台实例就绪：端口未知（0 = 内核分配）只能靠探活等它自己写 app.port */
async function waitForInstance(
    config: ReturnType<typeof resolveConfig>,
    timeoutMs = READY_TIMEOUT_MS,
): Promise<{ pid: number; port: number; home: string } | null> {
    const startedAt = Date.now();
    for (;;) {
        const mine = await probeMine(config);
        if (mine !== null) return mine;
        if (Date.now() - startedAt > timeoutMs) return null;
        await delay(READY_POLL_MS);
    }
}

/**
 * web 命令的 handler。
 *
 * @param moduleDir 用来向上找 appRoot（CLI 产物里传 `import.meta.dirname`，即 build/prod/cli）
 */
export function webHandler(moduleDir: string) {
    return async ({
        input,
    }: {
        input: WebInput;
    }): Promise<{ port: number; pid: number; home: string; reused: boolean }> => {
        const overrides = toOverrides(input);
        const config = resolveConfig({ moduleDir, mode: 'production', overrides });
        for (const note of config.notes) console.warn(`[diy2] ${note}`);

        const entry = serverEntryOf(config.appRoot);
        if (!existsSync(entry)) {
            throw new Error(
                `缺服务端产物 ${entry}\n  仓库里：cd ${config.appRoot} && ./sha.sh build\n` +
                    '  npm 安装的包：重新安装一次（发布产物里应该带 build/prod/）',
            );
        }
        if (config.webDir === undefined) {
            console.warn(`[diy2] 没有 UI 产物（${webDirOf(config.appRoot)}）：这次只提供 /api`);
        }

        let mine = await probeMine(config);
        if (mine !== null && input.restart === true) {
            await stopOne(mine.pid);
            // 端口记录还在（退出不删），所以停完要重新探；探不到才算真的没了
            mine = null;
        }
        if (mine !== null) {
            console.log(`diy2 已在运行：${urlOf(mine.port)}（pid=${mine.pid} home=${mine.home}）`);
            if (input.open === true) openBrowser(urlOf(mine.port));
            return { port: mine.port, pid: mine.pid, home: mine.home, reused: true };
        }

        const argv = [entry, ...toArgv(overrides)];

        if (input.detach === true) {
            const child = spawn(process.execPath, argv, { detached: true, stdio: 'ignore' });
            child.unref();
            const info = await waitForInstance(config);
            if (info === null) {
                throw new Error(`后台实例没起来（看 ${config.home} 的日志，或去掉 --detach 前台跑一次看输出）`);
            }
            console.log(`diy2 后台已起：${urlOf(info.port)}（pid=${info.pid} home=${info.home}）`);
            if (input.open === true) openBrowser(urlOf(info.port));
            return { port: info.port, pid: info.pid, home: info.home, reused: false };
        }

        // 前台：日志直接进本终端。端口可能由内核分配，所以「就绪」的判据是探活（不是解析输出）。
        const child = spawn(process.execPath, argv, { stdio: 'inherit' });
        const info = await waitForInstance(config);
        if (info !== null) {
            console.log(`[diy2] ${urlOf(info.port)}`);
            if (input.open === true) openBrowser(urlOf(info.port));
        }
        const [code] = (await once(child, 'exit')) as [number | null, unknown];
        if (code !== 0 && code !== null) throw new Error(`服务端退出码 ${code}`);
        return { port: config.port, pid: child.pid ?? 0, home: config.home, reused: false };
    };
}
