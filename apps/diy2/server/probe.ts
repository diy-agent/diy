// server/probe.ts —— 实例探活 + **身份校验**（服务端 / CLI / dev 启动器共用一份）。
//
// 为什么探活必须验身份：`app.port` 只记得「上次监听的端口」，不记得「那次是谁在监听」。
// 端口释放后可能被**另一个实例**（别的 worktree / 别的数据根）占用，只探「这个端口有 HTTP
// 响应」就会把别人的实例当自己用（仓库 ##328 的现场：生产与 dev 互相串台）。
// 唯一可靠的判据是**活体自报**：连上去问 `/api/info`，比它回报的 home。
//
// 这里也是 `probeMine`（「本数据根的实例」）的唯一实现：CLI 的 `port` / `stop` / `web`
// 与删掉的 bin 旧实现共用它 —— 判据只有一份，就不会出现「bin 认为是自己、CLI 认为不是」。

import { APP_ID, readPortFile, samePath, type Diy2Config } from './config';
import type { Diy2AppInfo } from './app';

export interface ProbeResult {
    /** mine = 本数据根的实例；other = 别人的实例；none = 端口上没人应答 */
    kind: 'mine' | 'other' | 'none';
    port: number;
    info?: Diy2AppInfo;
}

/** 取某端口的 `/api/info`（连接 + 读回的总预算 timeoutMs）；不可信回包抛错 */
export async function fetchInfo(port: number, timeoutMs = 1500): Promise<Diy2AppInfo> {
    const response = await fetch(`http://127.0.0.1:${port}/api/info`, {
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as Partial<Diy2AppInfo>;
    if (body.app !== APP_ID || typeof body.home !== 'string' || typeof body.pid !== 'number') {
        throw new Error('不是 diy2 实例');
    }
    return body as Diy2AppInfo;
}

/** 探测某端口上的实例身份（home 是本进程认定的数据根） */
export async function probe(port: number, home: string, timeoutMs = 1500): Promise<ProbeResult> {
    try {
        const info = await fetchInfo(port, timeoutMs);
        return { kind: samePath(info.home, home) ? 'mine' : 'other', port, info };
    } catch {
        return { kind: 'none', port };
    }
}

/**
 * 本数据根在跑的实例（`app.port` 只给**候选端口**，身份靠探活回包判）。
 *
 * 返回 null = 没找到（文件缺失 / 端口上没人 / 那个端口是别人的）。调用方**不能**把这个
 * 结果当「端口空闲」用 —— 端口可能被别的实例占着，那是 probe 的 `other`。
 */
export async function probeMine(config: Diy2Config): Promise<{ pid: number; port: number; home: string } | null> {
    const port = readPortFile(config.portFile);
    if (port === null) return null;
    const result = await probe(port, config.home);
    if (result.kind !== 'mine' || result.info === undefined) return null;
    const info = result.info;
    if (info.port === null) return null;
    return { pid: info.pid, port: info.port, home: info.home };
}
