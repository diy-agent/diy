// server/probe.ts —— 实例探活 + **身份校验**（服务端侧共用；bin/diy2 是发布形态的纯 JS，
// 不能 import TS 源，故那里有一份等价实现，判据注释互相指认）。
//
// 为什么探活必须验身份：`app.port` 只记得「上次监听的端口」，不记得「那次是谁在监听」。
// 端口释放后可能被**另一个实例**（别的 worktree / 别的数据根）占用，只探「这个端口有 HTTP
// 响应」就会把别人的实例当自己用（仓库 ##328 的现场：生产与 dev 互相串台）。
// 唯一可靠的判据是**活体自报**：连上去问 `/api/info`，比它回报的 home。

import { APP_ID, samePath } from './config';
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
