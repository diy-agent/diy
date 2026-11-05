/**
 * RemotePage — 远程导航页（##507 起，##511 改成「蓝牙 / WiFi」范式）。
 *
 * 用户原话（##511）：
 *   > 现在一堆 ui 堆在一起，信息量过大，很乱，连接状态和候选连接的信息需要整合，
 *   > 需要隐藏一些信息到二级页面
 *
 * 三条硬约束（判据 3/4/5/6）：
 *   ① **每行最多 3 个可见元素**：状态点 + 名字 + 一个值（已连接 / 离线 / 未连接 / 可配对），
 *      所有操作收进 `⋯` 菜单；
 *   ② **同一台机器只出现一行** —— 「其他机器」（发现到的）与「已配对」（memberships）合并成
 *      一份按状态分组（合并规则在 `shared/remote-nav.mergeDevices`，纯函数单测锁死）；
 *   ③ **完整信息进二级页面**：点某行 → 详情（PID / 端点 / 来源 / 加入时间 / 密钥…）；
 *      我的身份从主区挪到「本机 · 设置」（不在主列表里）。
 *
 * 配对本身仍**不重写**：两个方向的动作都只是打开 HubPage（host / join 两屏），
 * 协议、五屏、审批全在 HubPage —— 判据 4/5 靠这个成立。
 *
 * 数据一律来自结构化 RPC（remote.self / remote.list / hub.status / hub.link / hub.connection），
 * 不解析 CLI 文本；错误必须看得见（红条 + 原文）。
 */
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { diyService } from "../lib/rpc";
import { notificationStore } from "../store/notificationStore";
import { HubPage } from "./HubPage";
import type { DiscoveredRow, RemoteSelf } from "../../shared/remote";
import {
    DEVICE_GROUPS,
    deviceEndpoint,
    devicePairingAllowed,
    joinUrlFor,
    mergeDevices,
    sourceLabel,
    webAccessUrl,
    type DeviceRow,
    type HubConnectionState,
    type HubLinkRow,
    type HubMemberRow,
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

/** 状态点颜色：已连接绿、已配对灰、未配对空心 */
/** 连接列（列 1）：这条行现在能不能通 —— 与授权无关 */
const CONNECTION_LABEL: Record<DeviceRow["connection"], string> = {
    online: "在线",
    offline: "离线",
    unknown: "未知",
};
/** 授权列（列 2）：我和它是什么管理关系 —— 与连接无关 */
const TRUST_LABEL: Record<DeviceRow["trust"], string> = {
    master: "管理节点",
    satellite: "成员节点",
    none: "未配对",
    revoked: "已撤销",
};
const TRUST_CLASS: Record<DeviceRow["trust"], string> = {
    master: "badge badge-primary badge-sm",
    satellite: "badge badge-secondary badge-sm",
    none: "badge badge-ghost badge-sm",
    revoked: "badge badge-error badge-sm",
};
/** 连接点的颜色由**连接状态**决定（不是分组）——「在线但未配对」应该显示绿点 */
const DOT_CLASS_CONN: Record<DeviceRow["connection"], string> = {
    online: "bg-success",
    offline: "bg-base-300",
    unknown: "bg-warning",
};

const DOT_CLASS: Record<DeviceRow["group"], string> = {
    connected: "bg-success",
    paired: "bg-base-content/40",
    available: "bg-transparent border border-base-content/40",
};

export function RemotePage() {
    const [self, setSelf] = createSignal<RemoteSelf | null>(null);
    const [rows, setRows] = createSignal<DiscoveredRow[]>([]);
    const [discoverErrors, setDiscoverErrors] = createSignal<string[]>([]);
    const [identity, setIdentity] = createSignal<HubIdentity | null>(null);
    const [members, setMembers] = createSignal<HubMemberRow[]>([]);
    const [link, setLink] = createSignal<HubLinkRow | null>(null);
    const [connection, setConnection] = createSignal<HubConnectionState | null>(null);
    const [error, setError] = createSignal<string | null>(null);
    const [inFlight, setInFlight] = createSignal(false);
    const [hubLayer, setHubLayer] = createSignal<HubLayer | null>(null);
    /** 二级页面：当前展开的那台机器（null = 关着） */
    const [detailKey, setDetailKey] = createSignal<string | null>(null);
    /** web 访问调用结果（也给用户看一眼） */
    const [lastWebUrl, setLastWebUrl] = createSignal<string | null>(null);

    const refresh = async () => {
        if (inFlight()) return;
        setInFlight(true);
        try {
            const [s, list, st, lk, conn] = await Promise.all([
                diyService.diy.remote.self({}).catch(() => null),
                diyService.diy.remote.list({ sources: "tailscale,local", manual: undefined, mdnsTimeoutMs: 800 }),
                diyService.diy.hub.status({}).catch(() => null),
                diyService.diy.hub.link({}).catch(() => null),
                diyService.diy.hub.connection({}).catch(() => null),
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
            setLink(
                lk?.data ? { hubNodeId: lk.data.hubNodeId, hubEndpoint: lk.data.hubEndpoint } : null,
            );
            setConnection((conn?.data.state as HubConnectionState | undefined) ?? null);
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

    /** 合并后的一份清单（判据 4：同一台机器只出现一行） */
    const devices = createMemo(() =>
        mergeDevices({
            // local 源与本机同用户：从 self().address 的 `user@host/...` 取出 user 段
            ...(self()?.address && self()!.address.includes("@")
                ? { user: self()!.address.slice(0, self()!.address.indexOf("@")) }
                : {}),
            members: members(),
            discovered: rows(),
            link: link(),
            connection: connection(),
        }),
    );

    const grouped = createMemo(() => {
        const all = devices();
        return DEVICE_GROUPS.map((g) => ({ ...g, rows: all.filter((r) => r.group === g.key) })).filter(
            (g) => g.rows.length > 0,
        );
    });

    const detail = createMemo(() => {
        const key = detailKey();
        if (!key) return null;
        return devices().find((r) => r.key === key) ?? null;
    });

    /** 打开配对弹层 —— 两个方向都只切 HubPage 的屏，不另起协议（判据 4） */
    const openHub = (tab: "host" | "join", url?: string) => {
        setDetailKey(null);
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
                    reason: "人点了「web 访问」，openUrl 成功",
                    detail: "调用 traffic.openUrl → 主进程 shell.openExternal 打开系统默认浏览器。",
                });
                setError(null);
            } else {
                const m = r.message ?? "未知错误";
                setError(`打开 ${url} 失败：${m}`);
            }
        } catch (e) {
            setError(`打开 ${url} 失败：${msgOf(e)}`);
        }
    };

    const doRevoke = async (nodeId: string) => {
        try {
            await diyService.diy.hub.revoke({ nodeId });
            setDetailKey(null);
            await refresh();
        } catch (e) {
            setError(`撤销 ${nodeId} 失败：${msgOf(e)}`);
        }
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

            {/* ── 一台机器一行（已连接 / 已配对 / 未配对 三段） ── */}
            <section class="card bg-base-200/60" data-remote-machines>
                <div class="card-body py-3 gap-2">
                    <div class="flex items-center justify-between">
                        <h2 class="card-title text-base">设备</h2>
                        <button class="btn btn-xs" disabled={inFlight()} data-remote-refresh onClick={() => void refresh()}>
                            {inFlight() ? "刷新中…" : "刷新"}
                        </button>
                    </div>

                    <Show
                        when={grouped().length > 0}
                        fallback={<p class="text-sm opacity-60" data-remote-empty>没发现其他设备（mDNS / tailscale / local）。</p>}
                    >
                        <For each={grouped()}>
                            {(g) => (
                                <div class="space-y-1" data-remote-group={g.key}>
                                    <div class="text-xs opacity-60 px-1">{g.label}</div>
                                    <ul class="space-y-1">
                                        {/* 判据 3：一行只有 状态点 + 名字 + 一个值；操作在 ⋯ 里 */}
                                        <For each={g.rows}>
                                            {(row) => (
                                                <li
                                                    class="group flex items-center gap-2 rounded-box bg-base-100/70 px-3 py-2 cursor-pointer hover:bg-base-100"
                                                    data-remote-machine={row.key}
                                                    data-remote-machine-label={row.name}
                                                    data-remote-row={row.key}
                                                    data-remote-row-group={row.group}
                                                    onClick={() => setDetailKey(row.key)}
                                                >
                                                    <span
                                                        class={`shrink-0 w-2.5 h-2.5 rounded-full ${DOT_CLASS_CONN[row.connection]}`}
                                                        data-remote-dot={row.connection}
                                                        title={CONNECTION_LABEL[row.connection]}
                                                    />
                                                    {/* 主标识用显示地址（local 源拼得出）：
                                                        一眼看完 user@host:port/app.variant，比裸名字信息量大 */}
                                                    <span
                                                        class="flex-1 min-w-0 truncate font-semibold"
                                                        title={row.address ?? row.name}
                                                        data-remote-machine-name
                                                    >
                                                        {row.address ?? row.name}
                                                    </span>
                                                    <span class="shrink-0 w-16 text-xs opacity-50 font-mono" data-remote-pid>
                                                        {row.pid === undefined ? "—" : String(row.pid)}
                                                    </span>
                                                    {/* 两列分开（2026-11-05 用户裁）：连接 ≠ 授权 */}
                                                    <span
                                                        class="shrink-0 w-14 text-xs opacity-70"
                                                        data-remote-connection={row.connection}
                                                    >
                                                        {CONNECTION_LABEL[row.connection]}
                                                    </span>
                                                    <span class="shrink-0 w-20" data-remote-trust={row.trust}>
                                                        <span class={TRUST_CLASS[row.trust]}>{TRUST_LABEL[row.trust]}</span>
                                                    </span>
                                                    <details
                                                        class="dropdown dropdown-end shrink-0"
                                                        onClick={(e) => e.stopPropagation()}
                                                    >
                                                        <summary
                                                            class="btn btn-xs btn-ghost px-1"
                                                            data-remote-more={row.key}
                                                            aria-label="更多操作"
                                                        >
                                                            ⋯
                                                        </summary>
                                                        <ul class="dropdown-content menu bg-base-100 rounded-box shadow z-30 w-52 p-1">
                                                            <li>
                                                                <button data-remote-action="detail" onClick={() => setDetailKey(row.key)}>
                                                                    详情
                                                                </button>
                                                            </li>
                                                            <Show when={devicePairingAllowed(row)}>
                                                                <li>
                                                                    <button data-remote-action="invite" onClick={() => openHub("host")}>
                                                                        添加为卫星节点
                                                                    </button>
                                                                </li>
                                                                <li>
                                                                    <button
                                                                        data-remote-action="join"
                                                                        onClick={() => openHub("join", joinUrlFor(row.discovered!.endpoint))}
                                                                    >
                                                                        申请成为它的卫星
                                                                    </button>
                                                                </li>
                                                            </Show>
                                                            <Show when={webAccessUrl(deviceEndpoint(row) ?? "")}>
                                                                {(url) => (
                                                                    <li>
                                                                        <button
                                                                            data-remote-action="web"
                                                                            onClick={() => void openWeb(deviceEndpoint(row) ?? "")}
                                                                            title={url()}
                                                                        >
                                                                            web 远程访问
                                                                        </button>
                                                                    </li>
                                                                )}
                                                            </Show>
                                                            <Show when={row.member && row.member.status === "active"}>
                                                                <li>
                                                                    <button
                                                                        class="text-error"
                                                                        data-remote-action="revoke"
                                                                        onClick={() => void doRevoke(row.member!.nodeId)}
                                                                    >
                                                                        移除
                                                                    </button>
                                                                </li>
                                                            </Show>
                                                        </ul>
                                                    </details>
                                                </li>
                                            )}
                                        </For>
                                    </ul>
                                </div>
                            )}
                        </For>
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

                    <div class="flex gap-2 pt-1">
                        <button class="btn btn-xs" data-remote-add-pair onClick={() => openHub("join")}>
                            ＋ 配对新设备
                        </button>
                    </div>
                </div>
            </section>

            {/* ── 本机（判据 6：身份不进主列表；放在「设置」区，要展开才看全） ── */}
            <details class="card bg-base-200/40" data-remote-self open>
                <summary class="px-3 py-2 cursor-pointer text-sm opacity-70">本机 · 设置</summary>
                <div class="card-body py-3 gap-1">
                    <dl class="text-sm grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                        <dt class="opacity-60">节点 ID</dt>
                        <dd class="font-mono break-all" data-remote-self-id>
                            {self()?.id ?? identity()?.hubNodeId ?? "—"}
                        </dd>
                        <dt class="opacity-60">显示名</dt>
                        <dd data-remote-self-name>{self()?.displayName || self()?.host || "…"}</dd>
                        <dt class="opacity-60">所属域</dt>
                        <dd class="font-mono" data-remote-self-domain>
                            {identity()?.domainId ?? "—"}
                        </dd>
                        <dt class="opacity-60">对外地址</dt>
                        <dd class="font-mono break-all text-xs">{identity()?.endpoint ?? self()?.endpoint ?? "—"}</dd>
                        <dt class="opacity-60">角色</dt>
                        <dd data-remote-self-role>{link() ? "卫星" : identity() ? "主控" : "未配对"}</dd>
                        <Show when={link()}>
                            {(l) => (
                                <>
                                    <dt class="opacity-60">连到</dt>
                                    <dd class="font-mono break-all text-xs" data-remote-self-link>
                                        {l().hubEndpoint}（{l().hubNodeId}）
                                    </dd>
                                </>
                            )}
                        </Show>
                    </dl>
                    <div class="flex gap-2 mt-1">
                        <button class="btn btn-xs btn-primary" data-remote-open-host onClick={() => openHub("host")}>
                            本机作为主控（建邀请）
                        </button>
                        <button class="btn btn-xs" data-remote-open-join onClick={() => openHub("join")}>
                            加入其他主控
                        </button>
                    </div>
                </div>
            </details>

            {/* ── 二级页面：一台机器的完整信息（判据 5） ── */}
            <Show when={detail()}>
                {(row) => (
                    <dialog class="modal modal-open" data-remote-detail open>
                        <div class="modal-box max-w-xl">
                            <div class="flex items-center gap-2">
                                <span class={`w-2.5 h-2.5 rounded-full ${DOT_CLASS_CONN[row().connection]}`} />
                                <h3 class="text-lg font-semibold flex-1 truncate" data-remote-detail-name>
                                    {row().name}
                                </h3>
                                <span class="text-xs opacity-60">{row().status}</span>
                            </div>
                            <dl class="mt-3 text-sm grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                                <Show when={row().member}>
                                    {(m) => (
                                        <>
                                            <dt class="opacity-60">节点 ID</dt>
                                            <dd class="font-mono break-all">{m().nodeId}</dd>
                                            <dt class="opacity-60">配对状态</dt>
                                            <dd>{m().status === "active" ? "已配对" : "已撤销"}</dd>
                                            <dt class="opacity-60">活连接</dt>
                                            <dd>{m().online}</dd>
                                            <dt class="opacity-60">加入时间</dt>
                                            <dd class="text-xs">{m().createdAt}</dd>
                                        </>
                                    )}
                                </Show>
                                <Show when={row().link}>
                                    {(l) => (
                                        <>
                                            <dt class="opacity-60">我连到</dt>
                                            <dd class="font-mono break-all text-xs">{l().hubEndpoint}</dd>
                                            <dt class="opacity-60">长连状态</dt>
                                            <dd data-remote-detail-connection>{row().status}</dd>
                                        </>
                                    )}
                                </Show>
                                <Show when={row().discovered}>
                                    {(d) => (
                                        <>
                                            <dt class="opacity-60">端点</dt>
                                            <dd class="font-mono break-all text-xs">{d().endpoint}</dd>
                                            <dt class="opacity-60">来源</dt>
                                            <dd class="text-xs">
                                                {sourceLabel(d())}
                                                <Show when={d().sources.length > 1}>（{d().sources.join(" + ")}）</Show>
                                            </dd>
                                            <Show when={d().meta?.pid}>
                                                {(pid) => (
                                                    <>
                                                        <dt class="opacity-60">PID</dt>
                                                        <dd class="font-mono text-xs">{pid()}</dd>
                                                    </>
                                                )}
                                            </Show>
                                            <Show when={d().meta?.variant}>
                                                {(v) => (
                                                    <>
                                                        <dt class="opacity-60">变体</dt>
                                                        <dd class="font-mono text-xs">{v()}</dd>
                                                    </>
                                                )}
                                            </Show>
                                        </>
                                    )}
                                </Show>
                            </dl>

                            <div class="modal-action flex-wrap gap-1">
                                <Show when={devicePairingAllowed(row())}>
                                    <button class="btn btn-sm" data-remote-detail-action="invite" onClick={() => openHub("host")}>
                                        添加为卫星节点
                                    </button>
                                    <button
                                        class="btn btn-sm btn-primary"
                                        data-remote-detail-action="join"
                                        onClick={() => openHub("join", joinUrlFor(row().discovered!.endpoint))}
                                    >
                                        申请成为它的卫星
                                    </button>
                                </Show>
                                <Show when={webAccessUrl(deviceEndpoint(row()) ?? "")}>
                                    <button
                                        class="btn btn-sm"
                                        data-remote-detail-action="web"
                                        onClick={() => void openWeb(deviceEndpoint(row()) ?? "")}
                                    >
                                        web 远程访问
                                    </button>
                                </Show>
                                <Show when={row().member && row().member!.status === "active"}>
                                    <button
                                        class="btn btn-sm btn-ghost text-error"
                                        data-remote-detail-action="revoke"
                                        onClick={() => void doRevoke(row().member!.nodeId)}
                                    >
                                        移除
                                    </button>
                                </Show>
                                <button class="btn btn-sm" data-remote-detail-close onClick={() => setDetailKey(null)}>
                                    关闭
                                </button>
                            </div>
                        </div>
                        <form method="dialog" class="modal-backdrop">
                            <button onClick={() => setDetailKey(null)}>close</button>
                        </form>
                    </dialog>
                )}
            </Show>

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
