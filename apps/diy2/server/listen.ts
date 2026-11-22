// server/listen.ts —— 「监听 + 端口粘性落盘」的唯一实现（dev 与生产入口共用）。
//
// 为什么单独一个文件：端口粘性有三件事必须**一起**做，散在两个调用方里一定会漏一件：
//   1. 先按配置里的端口监听（它可能来自 `app.port` 记录，见 config.resolvePort）；
//   2. 被占用时**只在可漂移的来源上**回落到内核分配（0），并把新端口重新落盘 ——
//      显式 `--port` 被占就报错：人点名要的端口被悄悄换掉，比直接失败更难查；
//   3. 监听成功后把实际端口写进 `app.port`（**下次启动沿用它**，退出不删）。
//
// `app.port` 不是活体登记：“有没有人在跑”只能靠探活（`/api/info` 的 home，见 ./probe）；
// 所以这里也**不能**加删除 —— 删掉就等于丢掉粘性（dev 每次重启换 URL）。
//
// 漂移只发生在开发侧：生产的门牌固定（5192），被占由 index.ts 报错收场，不该自己换地址。
// 「同一数据根已有实例」的判据不在这里（那要先探活，见 index.ts 的 alreadyRunning）。

import type { Server } from 'node:http';

import { writePortFile, type Diy2Config } from './config';

export interface ListenResult {
    /** 实际监听端口（内核分配 / 漂移后都算准） */
    port: number;
    /** 漂移前的端口；没漂过就是 null（调用方据此决定要不要提醒） */
    driftedFrom: number | null;
}

/**
 * 这些来源的端口是「上次顺手用的」，被占了换一个不算意外：
 *   · recorded —— 记的是过去，过去可能已经被别人占了（**记录不证明那个端口现在空着**）；
 *   · default —— dev 的缺省本来就是 0（内核分配），不可能撞；
 *   · **cli / env 不在内**：那是人显式点名的端口，撞了就该报错让人决定。
 */
function driftable(config: Diy2Config): boolean {
    if (config.env === 'production') return false;
    return config.portSource === 'recorded' || config.portSource === 'default';
}

/** listen 一次，成功/失败各自收口（失败的 server 还能再 listen —— 这是漂移能重试的前提） */
function listenOnce(server: Server, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException): void => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = (): void => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        // 只绑本机：进程里带着 read/write/edit/bash 工具，等于任意命令执行面
        server.listen(port, '127.0.0.1');
    });
}

/**
 * 监听并落盘端口记录。
 *
 * 失败（非漂移场景，例如显式端口被占 / 权限不足）**原样抛给调用方**：
 * 各入口的报错话术不同（dev 提示 `./sha.sh stop`，生产提示 `diy2 stop`），不该在这里统一。
 */
export async function listenWithStickyPort(config: Diy2Config, server: Server): Promise<ListenResult> {
    let driftedFrom: number | null = null;
    try {
        await listenOnce(server, config.port);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || !driftable(config)) throw error;
        driftedFrom = config.port;
        // 回落 0：让内核挑一个空闲端口。不做「+1 顺延探测」—— 探测到 listen 之间仍有竞态，
        // 而且顺延会把邻居的端口范围蹭脏；内核分配是这里唯一无竞态的选法。
        await listenOnce(server, 0);
    }

    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : config.port;
    writePortFile(config.portFile, port);
    if (driftedFrom !== null) {
        console.log(`[diy2] 端口 ${driftedFrom} 被占用 → 改用 ${port}（下次沿用；想固定就换掉占用者）`);
    }
    return { port, driftedFrom };
}
