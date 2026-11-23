// server/index.ts —— **生产入口**（也是 `diy2 web` 拉起的那个产物）。
//
// 只做编排，不含领域逻辑、不含路由：
//   读参数（src/cli/options 的声明 + config 的裁决） → 装配（./app） → 监听 127.0.0.1
//   → 落 app.port（下次沿用的端口）+ 注册表 → 优雅退出。
//
// 「import 即 listen」在这里是**有意**的：这个文件就是可执行入口（node build/prod/server/index.mjs
// / `diy2 web` 的子进程），而装配逻辑已经从模块顶层搬进 createDiy2App —— 想复用 handler 的
// 调用方（dev）用 ./app，不需要也不应该 import 本文件。
//
// 参数面：**argv 是唯一输入**（不读 `DIY2_*` 环境变量，见 ./config 的文件头）。
//   缺省 mode = production；staging 由 sha.sh 显式 `--mode development --launch staging`。

import { createServer } from 'node:http';

import { createDiy2App } from './app';
import { describeConfig, modelConfigHint, resolveConfig } from './config';
import { installAppLog } from './log';
import { announce, retract } from './registry';
import { probe } from './probe';
import { listenWithStickyPort } from './listen';
import { parseEntryOptions, serverOptions, toOverrides } from '../src/cli/options';

const USAGE = `用法：node build/prod/server/index.mjs [options]

options:
  --mode <production|development|test>  运行环境（缺省 production）
  --launch <名字>                        入口名（缺省由环境推：prod / lab / test）
  -p, --port <n>                         端口；0 = 内核分配（缺省：生产 5192）
      --home <dir>                       数据根（缺省：生产 ~/.diy/diy2；非生产**必须显式给**）
      --name <名字>                       实例名
      --tools <shell|files>              工具面
      --web-dir <dir>                    UI 产物目录（缺省 <buildRoot>/web）
      --model-config <file>              model.yaml（缺省：<home>/model.yaml；只有生产数据根才回落 ~/.diy/model.yaml）
      --allow-prod-home                  显式放行生产数据根
  -h, --help                             本帮助`;

const options = parseEntryOptions(serverOptions, process.argv.slice(2), USAGE);
if (options.exit !== null) process.exit(options.exit);

const config = await resolveConfig({
    moduleDir: import.meta.dirname,
    mode: options.input.mode,
    overrides: toOverrides(options.input),
});
// 日志装配要在一切要说的话之前：此后本进程不再直接碰 console（一处写日志、两处落地）。
// 级别只看 `DIY_LOG_LEVEL`（不是配置项，不进 argv —— 它是「这次怎么看日志」不是「应用怎么跑」）。
const appLog = installAppLog({ home: config.home, level: process.env['DIY_LOG_LEVEL'] });
const boot = appLog.open('boot');

for (const note of config.notes) boot.warn(note);
// entity-runtime 读 model.yaml 的路径（懒读：只在真发请求时用，所以此处设置即生效）。
// 这是**出**：给它一个信号，不是我们自己读环境。
// `DIY_HOME` 也一并交给它 —— 否则它拿不到数据根，只能回落 `~/.diy`（= 测试实例用了生产配置）。
process.env['DIY_HOME'] ??= config.home;
// `=` 不是 `??=`：外层 shell / agent 里漏出来的 `DIY_MODEL_CONFIG`（常指向 diy1 的
// `~/.diy/model.yaml`）一旦被继承，实例就“用自己的库、别人的 key”。数据根说话。
process.env['DIY_MODEL_CONFIG'] = config.modelConfigPath;
const hint = modelConfigHint(config);
if (hint !== null) boot.warn(hint);

const app = await createDiy2App({
    config,
    port: () => {
        const address = server.address();
        return typeof address === 'object' && address !== null ? address.port : null;
    },
});

// 只绑本机：这个进程带着 read/write/edit/bash 工具，监听 0.0.0.0 等于把任意命令执行面
// 暴露给整个局域网（而且没有鉴权）。要远程用请走 SSH 隧道。
const server = createServer(app.handle);
// `/rpc` 的 WS 与 HTTP 共用同一个 server；不是它的 path 返回 false，留给别人
server.on('upgrade', (req, socket, head) => {
    app.handleUpgrade(req, socket, head);
});

/** 同一数据根已有实例在跑 → 不再起第二个（同一份 sqlite 双写） */
async function alreadyRunning(): Promise<number | null> {
    // 候选地址 = `app.port` 记录（上次用的那个）+ 本次裁决的端口。
    // 记录**不是**存活证据，只决定「先往哪儿看」；身份由 /api/info 自报的 home 判。
    // 生产尤其靠它：监听端口固定 5192，不从记录里取，但实例可能正跑在 `--port 5300` 上——
    // 只看 5192 就会当没人，第二个进程起来双写同一份 sqlite。
    const candidates = [...new Set([config.recordedPort, config.port])].filter(
        (port): port is number => port !== null && port !== 0,
    );
    for (const port of candidates) {
        const result = await probe(port, config.home);
        if (result.kind === 'mine') return port;
        if (result.kind === 'other') {
            boot.error(`端口 ${port} 被**另一个数据根**的实例占着`, { port, otherHome: result.info?.home ?? null });
            boot.error('换端口：--port 0（或 --port <n>），或先 diy2 stop');
            process.exit(1);
        }
    }
    return null;
}

const fatal = (error: Error): never => {
    boot.error('启动失败', { err: error.message }, error);
    process.exit(1);
};

const reused = await alreadyRunning();
if (reused !== null) {
    boot.info(`这个数据根已有实例在监听 http://127.0.0.1:${reused}`, { home: config.home });
    boot.info('要重启：先 `diy2 stop`（或 `diy2 web --restart`），不要直接起第二个进程');
    await appLog.shutdown();
    process.exit(0);
}

// 启动期错误由这里接（而不是 `server.on('error')`）：监听要能**重试**（开发侧端口被占时
// 回落到内核分配，见 ./listen），而常驻 error 监听器会在第一次 EADDRINUSE 时就把进程抬走。
function badStartup(error: NodeJS.ErrnoException): never {
    if (error.code === 'EADDRINUSE') {
        boot.error(`端口 ${config.port} 已被占用`, { home: config.home });
        boot.error('换端口：--port 0（内核分配）/ --port <n>；或先 diy2 stop');
        process.exit(1);
    }
    return fatal(error);
}

const { port } = await listenWithStickyPort(config, server).catch(badStartup);

// 监听成功之后的运行期错误：没有恢复手段，直提失败
server.on('error', (error: NodeJS.ErrnoException) => fatal(error));

boot.info(`${describeConfig(config, port)} → http://127.0.0.1:${port}`);
if (config.webDir !== undefined) boot.info('UI 产物', { dir: config.webDir });
else boot.warn('未找到 UI 产物（只提供 /api）—— 开发请用 `./sha.sh dev`');

// 实例自报（dev 启动器 / workbench / remote 靠它看见本实例）
await announce(config, port);

// 续跑排在**监听之后**（##554）：它一调就会发 LLM 请求。放在这里的意思是「门先打开，
// 重活再慢慢做」—— 用户在 UI 里看到的是实例已经可用，而不是一屏启动期错误日志。
app.resume();

const shutdown = (signal: string): void => {
    boot.info(`${signal} → 关闭`);
    // flush 日志：BatchLogRecordProcessor 有缓冲，不 flush 会丢掉最后几条（正好是关闭前那几条）
    void appLog.shutdown();
    // 刻意**不删** app.port：它记的是「下次用哪个端口」，删了下次就换成内核随机端口。
    app.close();
    void retract();
    server.close(() => process.exit(0));
    // 长连接（SSE）可能挂住 close 回调：兜底硬退
    setTimeout(() => process.exit(0), 1500).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
