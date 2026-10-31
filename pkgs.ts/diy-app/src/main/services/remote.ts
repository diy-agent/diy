// remote.ts — 本实例的远程可见性 + 发现服务（##479 第一刀：能找到 + 能 ping）。
//
// 职责分三层：
//   ① **自报**：起一个极简 HTTP/1.1 服务只在 `/ping` 上答身份（`@diy-agent/remote/node` 实现）；
//      ⚠️ 本轮无鉴权 ⇒ 缺省只绑 127.0.0.1，跨机用要显式 `DIY_PING_HOST=<内网/tailscale 地址>`，
//      **绝不要绑公网**（判据与提醒见 `remote/node/ping-server.ts` 文件头）。
//   ② **广播**：mDNS `_diy._tcp`（失败静默 —— 广播不是本机可用的前提）。
//   ③ **发现**：四路发现器（local / mdns / tailscale / manual）合并去重后**列给用户选**，
//      绝不自动连接（判据 4）。
//
// 本文件只做编排与容错：纯逻辑在 `@diy-agent/remote`，IO 在 `@diy-agent/remote/node`，
// 于是这里几乎没有可单测的分支，测试打在包内（`pkgs.ts/diy-remote/tests`）。

import { formatDiscoveryList, type InstanceIdentity, type MergedInstance } from "@diy-agent/remote";
import {
    discoverAll,
    ensureIdentity,
    fetchPing,
    publishMdns,
    setDisplayName,
    startPingServer,
    type MdnsPublisher,
    type PingServerHandle,
} from "@diy-agent/remote/node";
import type { DiscoverFailure, RemoteDiscoverResult, RemotePingResult, RemoteSelf } from "../../shared/remote";
import { setSelfPingPort } from "./instances";

export interface RemoteStartOptions {
    /** 数据根（身份文件落这里） */
    home: string;
    /** 产物变体（prod / lab / test / preview） */
    variant: string;
    /** 实例版本（app.getVersion()） */
    version: string;
    /** 是否做 mDNS 广播（缺省 true；测试环境关掉，别往真网络里发多播） */
    broadcast?: boolean;
}

export interface RemoteDiscoverOptions {
    sources?: readonly string[];
    manual?: readonly string[];
    mdnsTimeoutMs?: number;
    pingTimeoutMs?: number;
}

/**
 * 远程能力的错误（带 code，##394）：跨进程 / 进日志时调用方要能分类，不能只剩一句人读文本。
 * 码的命名跟 `shared/error-triage.ts::isErrorCode` 同一口径（`rpc/…`）。
 */
export class RemoteError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "RemoteError";
        this.code = code;
    }
}

export class RemoteService {
    private handle: PingServerHandle | null = null;
    private publisher: MdnsPublisher | null = null;
    /** 与 PingServer 共享同一对象：改显示名时原地改字段，`/ping` 立刻跟着变（不重启服务） */
    private identity: InstanceIdentity | null = null;
    private variant = "";
    /** 数据根（rename 要写回身份文件，故记住启动时那个） */
    private home = "";

    get isStarted(): boolean {
        return this.handle !== null;
    }

    get pingPort(): number | null {
        return this.handle?.port ?? null;
    }

    /**
     * 起 `/ping` + mDNS 广播 + 注册表回填。**任何失败都不抛**：
     * 远程能力是附加项，坏了她不该让整个实例起不来（与 inbox-sweep 同口径）。
     */
    async start(opts: RemoteStartOptions): Promise<void> {
        this.variant = opts.variant;
        this.home = opts.home;
        try {
            const { identity } = ensureIdentity(opts.home);
            this.identity = identity;
            const handle = await startPingServer({
                identity,
                variant: opts.variant,
                version: opts.version,
            });
            this.handle = handle;
            // 注册表回填：本机其它实例 / CLI 的 local 发现器靠它找到我
            setSelfPingPort(handle.port);
            this.publisher =
                opts.broadcast === false
                    ? null
                    : publishMdns({
                          port: handle.port,
                          id: identity.id,
                          displayName: identity.displayName,
                          variant: opts.variant,
                      });
            const loopback = handle.host === "127.0.0.1" || handle.host === "::1" || handle.host === "localhost";
            console.log(
                `[remote] /ping ${handle.baseUrl}  id=${identity.id} name=${identity.displayName}` +
                    (loopback ? "  (仅本机可连；跨机发现请设 DIY_PING_HOST=<内网/tailscale 地址>，勿暴露公网)" : "") +
                    (this.publisher === null
                        ? "  (mDNS 未启用)"
                        : this.publisher.published
                          ? "  (mDNS 已广播)"
                          : "  (mDNS 广播失败，其它发现方式不受影响)"),
            );
        } catch (e) {
            console.error("[remote] /ping 启动失败（远程发现不可用；本机功能不受影响）：", e);
        }
    }

    /** 停 /ping + 撤广播。返回 Promise 只是为了**测试能等端口真正释放**（生产退出时不需要等） */
    async stop(): Promise<void> {
        this.publisher?.stop();
        this.publisher = null;
        const handle = this.handle;
        this.handle = null;
        await handle?.close();
    }

    /** 本实例自报（CLI `diy remote self` / UI 展示用） */
    self(): RemoteSelf {
        if (this.handle === null || this.identity === null) {
            throw new RemoteError(
                "rpc/ping-not-started",
                "本实例的 /ping 未启动（远程能力不可用；看 main 日志的 [remote] 行）",
            );
        }
        // 绑 0.0.0.0 / :: 时不能把它当可连地址给出去 —— 换成回环
        const advertised = this.handle.host === "0.0.0.0" || this.handle.host === "::" ? "127.0.0.1" : this.handle.host;
        return {
            id: this.identity.id,
            displayName: this.identity.displayName,
            variant: this.variant,
            endpoint: `http://${advertised}:${this.handle.port}`,
            host: this.handle.host,
            port: this.handle.port,
            mdns: this.publisher?.published ?? false,
            ping: this.handle.info(),
        };
    }

    /** 改显示名（id 不变）—— 用户可改的那个名字 */
    rename(displayName: string): RemoteSelf {
        if (this.home === "") throw new RemoteError("rpc/ping-not-started", "远程服务未启动，无法改显示名");
        const next = setDisplayName(this.home, displayName);
        if (this.identity !== null) {
            // 原地改：`startPingServer` 持有同一个对象，故 /ping 下一请求就返回新名字
            this.identity.id = next.id;
            this.identity.displayName = next.displayName;
        }
        return this.self();
    }

    /** ping 一台实例（失败返回 ok:false，不抛） */
    async ping(endpoint: string, timeoutMs = 1500): Promise<RemotePingResult> {
        return fetchPing(endpoint, timeoutMs);
    }

    /** 四路发现 → 合并去重 → 列给用户选（**不自动连接**） */
    async discover(opts: RemoteDiscoverOptions = {}): Promise<RemoteDiscoverResult> {
        const result = await discoverAll({
            sources: opts.sources,
            manual: opts.manual,
            mdnsTimeoutMs: opts.mdnsTimeoutMs,
            pingTimeoutMs: opts.pingTimeoutMs,
        });
        const rows: MergedInstance[] = result.items;
        const errors: DiscoverFailure[] = result.errors;
        // 失败的那几路必须**出声**（别让「tailscale 明明装了却没结果」变成静默谜团）
        const text =
            errors.length === 0
                ? formatDiscoveryList(rows)
                : `${formatDiscoveryList(rows)}\n${errors.map((e) => `  ⚠ ${e.source} 发现失败：${e.message}`).join("\n")}`;
        return { rows, text, errors };
    }
}

/** 进程级单例（api-impl 绑定用；main 负责 start/stop） */
export const remoteService = new RemoteService();
