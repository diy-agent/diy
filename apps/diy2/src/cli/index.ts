// src/cli/index.ts —— diy2 的命令行（全部命令都在这里，包括 `web` 的进程生命周期）。
//
// 为什么用 RPC 的 CLI 能力而不是手写 switch：
//   · 命令树 / help / `--json` / 退出码从 zod 声明**生成**，与将来的远端域同一套；
//   · 本地命令用 **mem 传输**（`CliApp.inProcess`）：不起服务、不开端口，
//     域定义与 handlers 就是普通函数 —— 既是 CLI，也是单测入口；
//   · 以后需要实例的域（agent / room / task …）换成 http/ws 传输即可，命令层不动。
//
// `bin/diy2` 只做三件事：找到这个产物、清掉继承来的 `DIY2_*`、把 argv 原样交过来。
// 参数声明在 ./options（一份形状三处消费），裁决在 server/config.ts —— bin 里不再有解析器。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';
import '@diy-agent/rpc'; // .cliOption 的 zod 扩展（副作用补丁）
import { CliApp } from '@diy-agent/rpc/cli';

import { findAppRoot } from '../../server/config';
import { instanceApi, instanceHandlers } from './instance';
import { factsApi, factsHandlers } from './facts';

/** 全局选项（只在 CLI 进程里消费；与 diy-app 的 `--json` 同形） */
const globalOptions = z.object({
    json: z.boolean().default(false).cliOption({ short: 'j', desc: '以 JSON 输出（脚本消费）' }),
});

const moduleDir = import.meta.dirname;

/**
 * 版本号从 package.json 读（不再由 bin 塞进 `DIY2_CLI_VERSION` 环境变量）：
 * 产物在 `<appRoot>/build/prod/cli/`，向上找 appRoot 与发布形态/仓库形态都成立。
 */
const version = ((): string => {
    const appRoot = findAppRoot(moduleDir);
    if (appRoot === undefined) return '';
    try {
        const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { version?: string };
        return pkg.version ?? '';
    } catch {
        return '';
    }
})();

const argv = process.argv.slice(2);

const cli = CliApp.inProcess({
    name: 'diy2',
    version,
    scopes: [
        { prefix: 'diy2', api: instanceApi, handlers: instanceHandlers({ moduleDir }) },
        { prefix: 'diy2', api: factsApi, handlers: factsHandlers() },
    ],
    // `instance` 摊平（`diy2 list` / `diy2 web` / `diy2 stop`）；`facts` 保留域层（`diy2 facts brief`），
    // 免得 brief/get/find/status 与实例命令抢顶层、也免得和将来的域撞名
    cliRootPath: ['instance', '!facts'],
    globalOptions,
    cwd: process.cwd(),
});

const { code, out, err } = await cli.run(argv);
for (const line of out) console.log(line);
for (const line of err) console.error(line);
cli.dispose();
process.exit(code);
