// ipc.ts — 把 node 的 IPC 通道包成 rpc 的 EnvelopeTransport
//
// 这是整个跨进程方案里**唯一**要自己写的东西，10 行。
// rpc 的能力（cancel 帧、超时、错误码、断线清理、四种流）全在这个接口之后，
// 换一根管子（ws / http / electron / 内存队列）只换这一个文件。

import type { EnvelopeTransport } from '@diy-agent/rpc';

// `_Envelope` 不是公开导出（它在 rpc 内部）。从 on() 的签名里推出来 ——
// 这样 rpc 改信封形状时这边不用跟。
type Envelope = Parameters<Parameters<EnvelopeTransport['on']>[0]>[0];

/** node 的 IPC 通道长这样：`child` 和 `process` 都满足这个形状 */
export interface IpcChan {
    send(msg: unknown): unknown;
    on(cb: (msg: unknown) => void): () => void;
    onClose(cb: () => void): () => void;
}

export function ipcTransport(chan: IpcChan): EnvelopeTransport {
    return {
        send: (payload) => {
            chan.send(payload);
        },
        on: (handler) => chan.on((msg) => handler(msg as Envelope)),
        onClose: (cb) => chan.onClose(cb),
    };
}

/** 父侧：把 ChildProcess 的 IPC 通道包一层 */
export function childChan(child: import('node:child_process').ChildProcess): IpcChan {
    return {
        send: (msg) => {
            child.send(msg as Parameters<typeof child.send>[0]);
        },
        on: (cb) => {
            child.on('message', cb);
            return () => child.off('message', cb);
        },
        onClose: (cb) => {
            child.on('exit', cb);
            return () => child.off('exit', cb);
        },
    };
}

/** 子侧：process 自己就是一个通道 */
export function processChan(): IpcChan {
    return {
        send: (msg) => process.send?.(msg),
        on: (cb) => {
            process.on('message', cb);
            return () => process.off('message', cb);
        },
        onClose: (cb) => {
            process.on('disconnect', cb);
            return () => process.off('disconnect', cb);
        },
    };
}
