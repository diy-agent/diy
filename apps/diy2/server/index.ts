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
import { createMigrateModeApp, probeMigration } from './migrate-mode';
import { MIGRATE_WORKER_FLAG, runMigrationWorker } from './migrate-worker';
import { describeConfig, modelConfigHint, resolveConfig } from './config';
import { installAppLog } from './log';
import { announce, retract } from './registry';
import { probe } from './probe';
import { listenWithStickyPort } from './listen';
import { parseEntryOptions, serverOptions, toOverrides } from '../src/cli/options';

// ── 迁移子进程（2026-11-27）────────────────────────────────────
// 生产产物只有 index.mjs 一个文件，没有单独的 migrate-worker 可 spawn ——
// 所以复用本入口：`node index.mjs --migrate-worker <db>`，在这里就去干活并退出。
// 必须在读参数 / 装配之前分流，否则会顺手起一个正常的 web 进程。
if (process.argv.includes(MIGRATE_WORKER_FLAG)) {
    runMigrationWorker(process.argv[process.argv.indexOf(MIGRATE_WORKER_FLAG) + 1]);
    process.exit(process.exitCode ?? 0);
}

const USAGE = `用法：node build/prod/server/index.mjs [options]

options:
  --mode <production|development|test>  运行环境（缺省 production）
  --launch <名字>                        入口名（缺省由环境推：prod / lab / test）
  -p, --port <n>                         端口；0 = 内核分配（缺省：生产 5192）
      --home <dir>                       数据根（缺省：生产 ~/.diy2；非生产**必须显式给**）
      --name <名字>                       实例名
      --tools <shell|files>              工具面
      --web-dir <dir>                    UI 产物目录（缺省 <buildRoot>/web）
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

/** 实际监听端口（服务器稍后才建，回调懒得读，所以用 let） */
let server: ReturnType<typeof createServer> | undefined;
const portOf = (): number | null => {
    const address = server?.address();
    return typeof address === 'object' && address !== null ? address.port : null;
};

/** `/api/info` 的回包：迁移态与真 app 共用（外层靠它判「这个端口是不是我的实例」） */
const infoOf = (): Record<string, unknown> => ({
    app: 'diy2',
    pid: process.pid,
    port: portOf() ?? (config.port === 0 ? null : config.port),
    home: config.home,
    env: config.env,
    variant: config.launch,
    launch: config.launch,
    name: config.name,
    tools: config.tools,
});

// ── 启动闸门（2026-11-27）─────────────────────────────────────
// `createDiy2App()` 一上手就 openStore，而迁移是**同步**跑的 —— 照常装配的话，
// 迁移页刚渲染、迁移已经跑完了，这个页面就成了事后回顾。
// 所以先只读探一下（不打开 store、不改库）：有待迁移就先把 app 装配成「迁移态」，
// 只服务迁移页；迁完再换成真 app —— **同一个端口、同一个 server**，不换壳子。
const migration = probeMigration(config.dbPath);
if (migration.pending) {
    boot.info('库还有未完成的迁移，先停在迁移页', { applied: migration.applied, total: migration.total });
}

let app = migration.pending ? null : await createDiy2App({ config, port: portOf });
const migrator = migration.pending
    ? await createMigrateModeApp({
          config,
          port: portOf,
          info: infoOf,
          onDone: async () => {
              app = await createDiy2App({ config, port: portOf });
              void app.resume();
          },
      })
    : null;

// 只绑本机：这个进程带着 read/write/edit/bash 工具，监听 0.0.0.0 等于把任意命令执行面
// 暴露给整个局域网（而且没有鉴权）。要远程用请走 SSH 隧道。
server = createServer((req, res) => {
    void (app ?? migrator)!.handle(req, res);
});
// `/rpc` 的 WS 与 HTTP 共用同一个 server；不是它的 path 返回 false，留给别人
// （迁移态没有 RPC 面：库没迁完，任何业务请求都该被拒）
server.on('upgrade', (req, socket, head) => {
    app?.handleUpgrade(req, socket, head);
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
// 后台跑、不 await：它是串行背景活（可能跑很久），启动不等它
// （迁移态没有 app：等迁完在 onDone 里 resume）
void app?.resume();

const shutdown = (signal: string): void => {
    boot.info(`${signal} → 关闭`);
    // flush 日志：BatchLogRecordProcessor 有缓冲，不 flush 会丢掉最后几条（正好是关闭前那几条）
    void appLog.shutdown();
    // 刻意**不删** app.port：它记的是「下次用哪个端口」，删了下次就换成内核随机端口。
    app?.close();
    migrator?.close();
    void retract();
    server.close(() => process.exit(0));
    // 长连接（SSE）可能挂住 close 回调：兜底硬退
    setTimeout(() => process.exit(0), 1500).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
