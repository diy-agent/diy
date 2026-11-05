// uri.ts — bot 的全局标识（##497）：**纯函数**，不碰 fs、不认识 nodeId 从哪来。
//
// 同一个 bot 有两种写法，用途不同：
//   稳定标识  `diy://<nodeId>/bot/<botId>`     ← 存储 / 通信 / 日志**只写这个**
//   显示地址  `diy://<address>/bot/<botId>`    ← 只给人看（改显示名就变，不许当键）
//
// nodeId = `/ping` 响应里的 `id`（`diy-` + 8 位 hex；启动时生成、写进 `$DIY_HOME`、永不改）。
// address = `formatAddress()` 的结果（`ccc@c-mac/diy-web.lab:8123`），**本身可以带 `/`** ——
// 所以解析必须找**最后一个** `/bot/`，不能按段切。
//
// 用户裁决（##497）：nodeId 就是身份，copy 数据目录 = 克隆身份，不做特殊处理；不做 rekey。

import { BotError } from "./errors.js";

/** `/ping` 的实例 id 形状（`diy-` + 8 位小写 hex） */
export const NODE_ID_PATTERN = /^diy-[0-9a-f]{8}$/;

/** botId 的形状（与 store 的目录名同一把尺子） */
export const BOT_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

const SCHEME = "diy://";
const SEP = "/bot/";

/** 拼稳定标识用的原料 */
export interface BotUriParts {
    readonly nodeId: string;
    readonly botId: string;
}

/** 解析结果：稳定标识（可跨机器定位） */
export interface BotUriRef {
    readonly kind: "stable";
    /** 恒 false；只为让 `ref.displayOnly === true` 这条判据在联合类型上随手可写 */
    readonly displayOnly: false;
    readonly nodeId: string;
    readonly botId: string;
    /** 原样的 uri（未改写） */
    readonly uri: string;
}

/** 解析结果：显示地址（只能展示，不能当键 / 不能跨机器定位） */
export interface BotUriDisplayRef {
    readonly kind: "display";
    readonly displayOnly: true;
    /** 显示地址的 node 段（`ccc@c-mac/diy-web.lab:8123`） */
    readonly address: string;
    readonly botId: string;
    readonly uri: string;
}

export type ParsedBotUri = BotUriRef | BotUriDisplayRef;

/** 拼稳定标识 `diy://<nodeId>/bot/<botId>`；形状不对就抛，绝不拼出半个 uri */
export function botUri(parts: BotUriParts): string {
    if (!NODE_ID_PATTERN.test(parts.nodeId)) {
        throw new BotError("bot/invalid-uri", `nodeId 必须是实例 id（diy-xxxxxxxx）：${JSON.stringify(parts.nodeId)}`);
    }
    if (!BOT_ID_PATTERN.test(parts.botId) || parts.botId === "." || parts.botId === "..") {
        throw new BotError("bot/invalid-uri", `botId 非法：${JSON.stringify(parts.botId)}`);
    }
    return `${SCHEME}${parts.nodeId}${SEP}${parts.botId}`;
}

/** 反解 uri：稳定标识 / 显示地址都认；形状不对 = null（不抛，调用方自己决定怎么报） */
export function parseBotUri(uri: string): ParsedBotUri | null {
    if (typeof uri !== "string" || !uri.startsWith(SCHEME)) return null;
    const rest = uri.slice(SCHEME.length);
    // 显示地址的 node 段自带 `/`（`ccc@c-mac/diy-web.lab:8123`）⇒ 必须取最后一个分隔符
    const at = rest.lastIndexOf(SEP);
    if (at <= 0) return null;
    const node = rest.slice(0, at);
    const botId = rest.slice(at + SEP.length);
    if (botId === "" || !BOT_ID_PATTERN.test(botId) || botId === "." || botId === "..") return null;
    if (NODE_ID_PATTERN.test(node)) {
        return { kind: "stable", displayOnly: false, nodeId: node, botId, uri };
    }
    return { kind: "display", displayOnly: true, address: node, botId, uri };
}

/** 这条解析结果能不能当键存（稳定标识才算） */
export function isStableBotUri(ref: ParsedBotUri | null): ref is BotUriRef {
    return ref !== null && ref.kind === "stable";
}

/**
 * 下一个 bot id（`bot-<n>`，n = 现有最大值 + 1）。
 *
 * 2026-11-05（A3）从 `chat.ts` 搬到这里：它只做字符串解析，**不该背 chat.ts 的 fs 依赖**。
 * 搬走的直接收益：`@diy-agent/bot-config-page` 的 barrel 从「可达 node:fs」变成安全的
 * （它经 admin.ts 引这个函数，而 admin 不该把整个对话宿主的依赖拖进来）。
 */
export function nextBotId(existing: Iterable<string>): string {
    let max = 0;
    for (const id of existing) {
        const match = /^bot-(\d+)$/.exec(id);
        if (match !== null) max = Math.max(max, Number(match[1]));
    }
    return `bot-${String(max + 1)}`;
}
