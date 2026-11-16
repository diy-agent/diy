// transport.ts — 传输层**接口**（Link）+ 进程内实现。
//
// 本包不依赖 `@diy-agent/rpc`：actor 只认「能收发帧」这件事。ws / http / electron / stdio
// 的适配器在别的包里写，越界的东西永远只是 `Frame`（或它的 JSON 串，见 wire.ts `frameLink`）。
//
// 为什么接口这么小：一收一发就是全部。谁连谁、断线重连、鉴权、多路复用，都不是 actor 的事 ——
// 那些是「链路」的职责，actor 只要求「帧到得了、回执回得去、事件推得出」。

import type { Frame } from './wire.js';
import { decodeFrame, encodeFrame } from './wire.js';

/** 一条链路（一端）。actor 与调用方各自持有一端 */
export interface Link {
    send(frame: Frame): void;
    /** 注册收帧回调，返回注销函数 */
    onFrame(handler: (frame: Frame) => void): () => void;
}

/** 只搬字符串的链路（给 ws / http 适配器用：它们不用知道帧的结构） */
export interface TextLink {
    send(text: string): void;
    onText(handler: (text: string) => void): () => void;
}

/** 会话两端 */
export interface LinkPair {
    /** 调用方那一端 */
    caller: Link;
    /** actor 那一端 */
    actor: Link;
}

/**
 * 进程内链路：两端互投，用微任务排队模拟真链路的异步边界。
 *
 * 别改成同步直投：真链路（ws）不会在 `send()` 里就跑对面的处理逻辑，
 * 同步直投会把「重入 / 队列自锁」这类 bug 藏起来，等上真链路才炸。
 */
export function createInProcessPair(): LinkPair {
    const sides = { caller: new Set<(f: Frame) => void>(), actor: new Set<(f: Frame) => void>() };

    const end = (from: 'caller' | 'actor'): Link => {
        const mine = sides[from];
        const other = from === 'caller' ? sides.actor : sides.caller;
        return {
            send(frame) {
                queueMicrotask(() => {
                    for (const h of other) h(frame);
                });
            },
            onFrame(handler) {
                mine.add(handler);
                return () => mine.delete(handler);
            },
        };
    };

    return { caller: end('caller'), actor: end('actor') };
}

/** 把字符串链路包成帧链路（适配器侧一行搞定；坏帧在链路层丢弃，不往业务层传） */
export function frameLink(inner: TextLink, onBadFrame?: (message: string) => void): Link {
    const handlers = new Set<(frame: Frame) => void>();
    inner.onText((text) => {
        const decoded = decodeFrame(text);
        if (!decoded.ok) {
            onBadFrame?.(decoded.message);
            return;
        }
        for (const h of handlers) h(decoded.frame);
    });
    return {
        send(frame) {
            inner.send(encodeFrame(frame));
        },
        onFrame(handler) {
            handlers.add(handler);
            return () => handlers.delete(handler);
        },
    };
}
