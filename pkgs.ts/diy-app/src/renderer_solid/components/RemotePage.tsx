/**
 * RemotePage — 远程导航页（##507）：一屏列「我」+「其他机器」，配对走已有 HubPage 弹层。
 *
 * 用户原话（##507 body）：
 *   > 一屏列「我」+「其他机器」，每个机器三个动作：
 *     [添加为卫星节点]（我当主控，建邀请）
 *     [申请成为它的卫星]（我当卫星，连它）
 *     [web 远程访问]（open 浏览器到 https://该节点/）
 *
 * 三条硬约束：
 *   ① **不重写配对**：两个方向的动作都只是打开 HubPage（host / join 两屏），
 *      协议、五屏、审批全在 HubPage —— 判据 4/5 靠这个成立；
 *   ② mDNS 行**不可配对**（与 HubPage 判据 22 同源，见 shared/remote-nav.pairingAllowed），
 *      只留「web 远程访问」；
 *   ③ 数据一律来自结构化 RPC（remote.self / remote.list / hub.status / hub.link），
 *      不解析 CLI 文本；错误必须看得见（红条 + 原文）。
 *
 * 展示语义（webAccessUrl / pairingAllowed / PAIR_ACTIONS / joinUrlFor）在
 * `shared/remote-nav.ts` 纯函数里，本文件只取数、排版、把动作接到既有出口。
 */
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { diyService } from "../lib/rpc";
import { notificationStore } from "../store/notificationStore";
import { HubPage } from "./HubPage";
import type { DiscoveredRow, RemoteSelf } from "../../shared/remote";
import {
    PAIR_ACTIONS,
    joinUrlFor,
    machineLabel,
    pairingAllowed,
    sourceLabel,
    webAccessUrl,
} from "../../shared/remote-nav";

function msgOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** Hub 弹层的打开参数（null = 关着） */
interface HubLayer {
    tab: "host" | "join";
    /** join 屏预填；host 屏忽略 */
    url?: string;
}

interface HubIdentity {
    hubNodeId: string;
    domainId: string;
    endpoint?: string;
}

interface HubMember {
    nodeId: string;
    displayName: string;
    status: string;
    online: number;
    createdAt: string;
}

export function RemotePage() {
    const [self, setSelf] = createSignal<RemoteSelf | null>(null);
    const [rows, setRows] = createSignal<DiscoveredRow[]>([]);
    const [discoverErrors, setDiscoverErrors] = createSignal<string[]>([]);
    const [identity, setIdentity] = createSignal<HubIdentity | null>(null);
    const [members, setMembers] = createSignal<HubMember[]>([]);
    const [link, setLink] = createSignal<{ hubNodeId: string; hubEndpoint: string } | null>(null);
    const [error, setError] = createSignal<string | null>(null);
    const [inFlight, setInFlight] = createSignal(false);
    const [hubLayer, setHubLayer] = createSignal<HubLayer | null>(null);
    /** web 访问调用结果（判据 3：断言 openUrl 被调；也给用户看一眼） */
    const [lastWebUrl, setLastWebUrl] = createSignal<string | null>(null);

    const refresh = async () => {
        if (inFlight()) return;
        setInFlight(true);
        try {
            const [s, list, st, lk] = await Promise.all([
                diyService.diy.remote.self({}).catch(() => null),
                diyService.diy.remote.list({ sources: "mdns,tailscale,local", manual: undefined, mdnsTimeoutMs: 800 }),
                diyService.diy.hub.status({}).catch(() => null),
                diyService.diy.hub.link({}).catch(() => null),
            ]);
            setSelf(s);
            setRows(list.rows);
            setDiscoverErrors(list.errors.map((e) => `${e.source}: ${e.message}`));
            const id = st?.data.identity;
            setIdentity(
                id
                    ? {
                          hubNodeId: id.hubNodeId,
                          domainId: id.domainId,
                          ...(id.endpoint ? { endpoint: id.endpoint } : {}),
                      }
                    : null,
            );
            setMembers(st?.data.memberships ?? []);
            setLink(lk?.data ? { hubNodeId: lk.data.hubNodeId, hubEndpoint: lk.data.hubEndpoint } : null);
            setError(null);
        } catch (e) {
            setError(`拉取远程状态失败：${msgOf(e)}`);
        } finally {
            setInFlight(false);
        }
    };

    onMount(() => {
        void refresh();
        const timer = setInterval(() => void refresh(), 5000);
        onCleanup(() => clearInterval(timer));
    });

    /** 打开配对弹层 —— 两个方向都只切 HubPage 的屏，不另起协议（判据 4） */
    const openHub = (tab: "host" | "join", url?: string) => {
        setHubLayer({ tab, ...(url ? { url } : {}) });
    };

    /**
     * web 远程访问：拼 https 根地址 → RPC `traffic.openUrl`（主进程 shell.openExternal）。
     * 失败必须看得见（toast + 红条），不静默。
     */
    const openWeb = async (endpoint: string) => {
        const url = webAccessUrl(endpoint);
        if (!url) {
            notificationStore.addToast("error", `无法解析 web 地址：${endpoint}`, {
                source: "远程页 · web 访问",
                reason: "发现行给的 endpoint 解析不出 host（可能是畸形地址）",
                detail: "远程页按发现器给的 endpoint 归一成 https 根地址；解析失败时不发 openUrl，避免打开错页面。",
            });
            return;
        }
        try {
            const r = await diyService.diy.traffic.openUrl({ url });
            setLastWebUrl(url);
            if (r.ok) {
                notificationStore.addToast("success", `已在浏览器打开 ${url}`, {
                    source: "远程页 · web 访问",
                    reason: "人点了「web 远程访问」，openUrl 成功",
                    detail: "调用 traffic.openUrl → 主进程 shell.openExternal 打开系统默认浏览器。",
                });
                setError(null);
            } else {
                const m = r.message ?? "未知错误";
                setError(`打开 ${url} 失败：${m}`);
                notificationStore.addToast("error", `打开失败：${m}`, {
                    source: "远程页 · web 访问",
                    reason: "openUrl 返回 ok:false（见页面红条原文）",
                    detail: "主进程 shell.openExternal 失败；红条里是原始错误，不吞。",
                });
            }
        } catch (e) {
            const m = msgOf(e);
            setError(`打开 ${url} 失败：${m}`);
            notificationStore.addToast("error", `打开失败：${m}`, {
                source: "远程页 · web 访问",
                reason: "openUrl RPC 调用抛错（见页面红条原文）",
                detail: "RPC 未返回（主进程 import electron 失败等）；红条里是原始错误，不吞。",
            });
        }
    };

    /** 角色：有 link = 卫星；有 identity = 主控；都没有 = 未配对 */
    const roleText = () => {
        if (link()) return "卫星";
        if (identity()) return "主控";
        return "未配对";
    };

    const selfLabel = () => {
        const s = self();
        if (!s) return "…";
        return s.displayName || s.host || s.id;
    };

    return (
        <div class="flex flex-col h-full min-h-0 overflow-auto p-4 gap-3" data-remote-page>
            <Show when={error()}>
                <div class="alert alert-error shrink-0 py-2 text-sm" data-remote-error role="alert">
                    <span class="flex-1 whitespace-pre-wrap">{error()}</span>
                    <button class="btn btn-xs" onClick={() => setError(null)}>
                        知道了
                    </button>
                </div>
            </Show>

            <div class="flex flex-wrap gap-3 items-start">
                {/* ── 我 ── */}
                <section class="card bg-base-200/60 min-w-[280px] flex-1" data-remote-self>
                    <div class="card-body py-3 gap-1">
                        <h2 class="card-title text-base">我</h2>
                        <dl class="text-sm grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                            <dt class="opacity-60">节点 ID</dt>
                            <dd class="font-mono break-all" data-remote-self-id>
                                {self()?.id ?? identity()?.hubNodeId ?? "—"}
                            </dd>
                            <dt class="opacity-60">显示名</dt>
                            <dd data-remote-self-name>{selfLabel()}</dd>
                            <dt class="opacity-60">所属域</dt>
                            <dd class="font-mono" data-remote-self-domain>
                                {identity()?.domainId ?? "—"}
                            </dd>
                            <dt class="opacity-60">对外地址</dt>
                            <dd class="font-mono break-all text-xs">
                                {identity()?.endpoint ?? self()?.endpoint ?? "—"}
                            </dd>
                            <dt class="opacity-60">角色</dt>
                            <dd data-remote-self-role>{roleText()}</dd>
                        </dl>
                        <Show when={link()}>
                            {(l) => (
                                <div class="text-xs opacity-70 font-mono break-all" data-remote-self-link>
                                    已加入 {l().hubNodeId}（{l().hubEndpoint}）
                                </div>
                            )}
                        </Show>
                        <div class="flex gap-2 mt-1">
                            <button class="btn btn-xs btn-primary" data-remote-open-host onClick={() => openHub("host")}>
                                本机作为主控（建邀请）
                            </button>
                            <button class="btn btn-xs" data-remote-open-join onClick={() => openHub("join")}>
                                加入其他主控
                            </button>
                        </div>
                    </div>
                </section>

                {/* ── 其他机器 ── */}
                <section class="card bg-base-200/60 flex-[2] min-w-[320px]" data-remote-machines>
                    <div class="card-body py-3 gap-2">
                        <div class="flex items-center justify-between">
                            <h2 class="card-title text-base">其他机器</h2>
                            <button class="btn btn-xs" disabled={inFlight()} data-remote-refresh onClick={() => void refresh()}>
                                {inFlight() ? "刷新中…" : "刷新"}
                            </button>
                        </div>
                        <Show
                            when={rows().length > 0}
                            fallback={<p class="text-sm opacity-60" data-remote-empty>没发现其他机器（mDNS / tailscale / local）。</p>}
                        >
                            <ul class="space-y-2">
                                <For each={rows()}>
                                    {(row) => {
                                        const label = machineLabel(row);
                                        const canPair = pairingAllowed(row);
                                        const webUrl = webAccessUrl(row.endpoint);
                                        return (
                                            <li
                                                class="rounded-box bg-base-100/70 px-3 py-2 flex flex-wrap items-center gap-2"
                                                data-remote-machine={row.endpoint}
                                                data-remote-machine-label={label}
                                            >
                                                <div class="flex-1 min-w-0">
                                                    <div class="font-semibold truncate" data-remote-machine-name>
                                                        {label}
                                                    </div>
                                                    <div class="text-xs opacity-60 font-mono break-all">
                                                        {row.endpoint} · {sourceLabel(row)}
                                                        <Show when={row.sources.length > 1}>
                                                            {" "}
                                                            （{row.sources.join(" + ")}）
                                                        </Show>
                                                    </div>
                                                </div>
                                                <div class="flex flex-wrap gap-1 justify-end">
                                                    <For each={PAIR_ACTIONS}>
                                                        {(action) => (
                                                            <Show when={canPair || action.key === "invite"}>
                                                                <button
                                                                    class="btn btn-xs btn-primary"
                                                                    data-remote-action={action.key}
                                                                    data-remote-action-for={row.endpoint}
                                                                    title={
                                                                        action.key === "invite"
                                                                            ? "我当主控，给这台机器建邀请"
                                                                            : "我当卫星，连到这台机器"
                                                                    }
                                                                    onClick={() =>
                                                                        openHub(
                                                                            action.tab,
                                                                            action.key === "join" ? joinUrlFor(row.endpoint) : undefined,
                                                                        )
                                                                    }
                                                                >
                                                                    {action.label}
                                                                </button>
                                                            </Show>
                                                        )}
                                                    </For>
                                                    <button
                                                        class="btn btn-xs"
                                                        data-remote-web={row.endpoint}
                                                        disabled={!webUrl}
                                                        title={webUrl ?? "地址解析失败"}
                                                        onClick={() => void openWeb(row.endpoint)}
                                                    >
                                                        web 远程访问
                                                    </button>
                                                </div>
                                            </li>
                                        );
                                    }}
                                </For>
                            </ul>
                        </Show>
                        <Show when={discoverErrors().length > 0}>
                            <div class="text-xs text-warning" data-remote-discover-errors>
                                {discoverErrors().join(" · ")}
                            </div>
                        </Show>
                        <Show when={lastWebUrl()}>
                            {(u) => (
                                <div class="text-xs opacity-70 font-mono" data-remote-last-web>
                                    最近打开：{u()}
                                </div>
                            )}
                        </Show>
                    </div>
                </section>
            </div>

            {/* ── 已配对 ── */}
            <section class="card bg-base-200/60" data-remote-paired>
                <div class="card-body py-3 gap-2">
                    <h2 class="card-title text-base">已配对</h2>
                    <Show
                        when={members().length > 0}
                        fallback={<p class="text-sm opacity-60" data-remote-paired-empty>还没有已配对的节点。</p>}
                    >
                        <table class="table table-sm" data-remote-paired-table>
                            <thead>
                                <tr>
                                    <th>节点</th>
                                    <th>状态</th>
                                    <th>加入时间</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                <For each={members()}>
                                    {(m) => (
                                        <tr data-remote-paired-row={m.nodeId}>
                                            <td>
                                                <div class="font-semibold">{m.displayName}</div>
                                                <div class="text-xs opacity-55 font-mono">{m.nodeId}</div>
                                            </td>
                                            <td>
                                                <span
                                                    classList={{
                                                        "text-success": m.status === "active",
                                                        "opacity-50": m.status !== "active",
                                                    }}
                                                >
                                                    {m.status === "active" ? (m.online > 0 ? "● 在线" : "○ 离线") : "已撤销"}
                                                </span>
                                            </td>
                                            <td class="text-xs opacity-60">{m.createdAt}</td>
                                            <td class="text-right">
                                                <Show when={m.status === "active"}>
                                                    <button
                                                        class="btn btn-xs btn-ghost"
                                                        data-remote-paired-detail={m.nodeId}
                                                        onClick={() => openHub("host")}
                                                    >
                                                        详情
                                                    </button>
                                                </Show>
                                            </td>
                                        </tr>
                                    )}
                                </For>
                            </tbody>
                        </table>
                    </Show>
                    <div>
                        <button class="btn btn-sm" data-remote-add-node onClick={() => openHub("join")}>
                            + 添加其他节点
                        </button>
                    </div>
                </div>
            </section>

            {/* ── 配对弹层：HubPage 复用（判据 4/5：五屏都在这里） ── */}
            <Show when={hubLayer()}>
                {(layer) => (
                    <dialog class="modal modal-open" data-hub-layer open>
                        <div class="modal-box max-w-4xl w-[min(92vw,880px)] max-h-[90vh] p-0 overflow-hidden">
                            <div class="h-[min(80vh,720px)] min-h-0">
                                <HubPage
                                    initialTab={layer().tab}
                                    initialUrl={layer().url}
                                    onClose={() => setHubLayer(null)}
                                />
                            </div>
                        </div>
                        <form method="dialog" class="modal-backdrop">
                            <button data-hub-layer-backdrop onClick={() => setHubLayer(null)}>
                                close
                            </button>
                        </form>
                    </dialog>
                )}
            </Show>
        </div>
    );
}
