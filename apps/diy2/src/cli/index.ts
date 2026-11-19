// src/cli/index.ts —— diy2 的命令行（除 `start` 的进程生命周期外，全部走 @diy-agent/rpc/cli）。
//
// 为什么用 RPC 的 CLI 能力而不是手写 switch：
//   · 命令树 / help / `--json` / 退出码从 zod 声明**生成**，与将来的远端域同一套；
//   · 本地命令用 **mem 传输**（`CliApp.inProcess`）：不起服务、不开端口，
//     域定义与 handlers 就是普通函数 —— 既是 CLI，也是单测入口；
//   · 以后需要实例的域（agent / room / task …）换成 http/ws 传输即可，命令层不动。
//
// `start` 不进命令树：它是「进程生命周期」而不是一次命令调用（前台跑、Ctrl-C 停），
// 留在 bin/diy2；其余命令由这里接管。

import { z } from 'zod';
import '@diy-agent/rpc'; // .cliOption 的 zod 扩展（副作用补丁）
import { CliApp } from '@diy-agent/rpc/cli';

import { instanceApi, instanceHandlers } from './instance';

/** 全局选项（只在 CLI 进程里消费；与 diy-app 的 `--json` 同形） */
const globalOptions = z.object({
    json: z.boolean().default(false).cliOption({ short: 'j', desc: '以 JSON 输出（脚本消费）' }),
});

const argv = process.argv.slice(2);

const cli = CliApp.inProcess({
    name: 'diy2',
    version: process.env['DIY2_CLI_VERSION'] ?? '',
    scopes: [{ prefix: 'diy2', api: instanceApi, handlers: instanceHandlers() }],
    // `instance` 只是域层：用户敲 `diy2 list`，不是 `diy2 instance list`
    cliRootPath: ['instance'],
    globalOptions,
    cwd: process.cwd(),
});

const { code, out, err } = await cli.run(argv);
for (const line of out) console.log(line);
for (const line of err) console.error(line);
cli.dispose();
process.exit(code);
