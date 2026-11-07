/**
 * rpc.ts — 意图测试的两种「进程内/长连」装配（替代 `./diy.sh` 子进程）。
 *
 * 为什么要它：旧写法每条断言起一个 `./diy.sh`（实测 0.68s，冷启 2.7s），
 * 一个 34 条的文件就 137s。被测的规则 99% 不在进程边界上 —— 三条通道按需选：
 *
 *   memRpc()  —— 与 main 同进程：`createMemTransportPair` + 生产 `bindAppHandlers`。
 *                最便宜（微秒级），用于 core/main 规则（task / project / persona / flow …）。
 *   appRpc()  —— 真 app 进程：起一次 Electron，用 `HttpClientBinding` 长连它的 rpc 端口。
 *                需要 renderer 在场的域（`diy.ui.*`）走这条；比 CLI 快一个数量级（~1ms/调用）。
 *   （第三条仍是 `./diy.sh`：只有被测对象就是 CLI 进程本身时才用。）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    ChannelClientBinding,
    ChannelServerBinding,
    createMemTransportPair,
    createTypedClient,
} from "@diy-agent/rpc";
import { HttpClientBinding } from "@diy-agent/rpc/http";
import { apiDef } from "../../src/main/services/api-def";
import { bindAppHandlers } from "../../src/main/services/api-impl";
import { startElectronTest, type ElectronTest } from "../electron-test";

export type Rpc = ReturnType<typeof createTypedClient<typeof apiDef>>;

/** 一个隔离的数据根（= $DIY_HOME），用完 dispose 删掉 */
export interface TestHome {
    readonly path: string;
    dispose(): void;
}

export function tempHome(prefix = "intent-"): TestHome {
    const path = mkdtempSync(join(tmpdir(), prefix));
    process.env["DIY_HOME"] = path;
    return {
        path,
        dispose: () => rmSync(path, { recursive: true, force: true }),
    };
}

/**
 * 同进程 rpc：跑的是**生产 handler**（不是 mock），但数据根是临时目录。
 * 适合：纯数据/规则类需求（不涉及窗口）。
 */
export function memRpc(): { rpc: Rpc; dispose(): void } {
    const { serverTx, clientTx } = createMemTransportPair();
    bindAppHandlers(new ChannelServerBinding(serverTx));
    const client = new ChannelClientBinding(clientTx);
    const rpc = createTypedClient<typeof apiDef>(client, apiDef);
    return { rpc, dispose: () => client.dispose() };
}

/**
 * 真 app + 长连 rpc：需要 renderer 的域（`diy.ui.*`）用这条。
 * 一个文件只起一次（beforeAll → afterAll），别在每个 it 里起。
 */
export async function appRpc(): Promise<{ rpc: Rpc; electron: ElectronTest; dispose(): Promise<void> }> {
    const electron = await startElectronTest();
    const client = new HttpClientBinding(`http://127.0.0.1:${String(electron.port)}`);
    const rpc = createTypedClient<typeof apiDef>(client, apiDef);
    return {
        rpc,
        electron,
        dispose: async () => {
            client.dispose();
            await electron.stop();
        },
    };
}
