/**
 * HubPage — 配对页（##500）：主控建邀请 / 审批 / 管理，卫星比对地址 + 输码。
 *
 * 协议真源 `docs/plans/2026-11-01-hub-pairing.md`。三条 UI 硬约束（判据 20–24）：
 *   ① 主控建邀请页**码 + 真实地址 + 二维码同屏**，二维码内容不含 code；
 *   ② 卫星页先大字号显示「将连接到 xxx」，人点「是，继续」之后才出现输码框；
 *   ③ mDNS 发现项**不可直接配对**（点了只提示改用 tailscale 地址）。
 *
 * 数据一律来自 `diy.hub.*`（结构化），不解析 CLI 文本；错误必须看得见（红条 + 原文）。
 */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import QRCode from "qrcode";
import { diyService } from "../lib/rpc";

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface InviteView {
  code: string;
  address: string;
  inviteUrl: string;
  expiresAt: string;
}

interface PendingRow {
  requestId: string;
  nodeId: string;
  displayName: string;
  requestedAt: string;
}

interface MemberRow {
  nodeId: string;
  displayName: string;
  status: string;
  online: number;
  createdAt: string;
}

interface DiscoverRow {
  id: string | null;
  displayName: string | null;
  endpoint: string;
  source: string;
  sources: string[];
  meta?: Record<string, string>;
}

type Tab = "host" | "join";

/**
 * HubPage 可复用（##507）：远程导航页把它当**弹层/详情区**嵌入，不再占整级导航 tab。
 *
 * props 全可选 —— 不传时行为与 ##500 的整页版完全一致（配对五屏不回归）：
 *   · `initialTab` —— 打开哪一屏（「添加为卫星节点」→ host；「申请成为它的卫星」→ join）
 *   · `initialUrl` —— join 屏预填入网基址（从发现行拼，见 shared/remote-nav.joinUrlFor）
 *   · `onClose`    —— 有值则显示关闭按钮（弹层模式）；无值 = 仍可当整页用
 */
export function HubPage(props: {
  initialTab?: Tab;
  initialUrl?: string;
  onClose?: () => void;
}) {
  const [tab, setTab] = createSignal<Tab>(props.initialTab ?? "host");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);

  // 主控状态
  const [identity, setIdentity] = createSignal<{ hubNodeId: string; domainId: string; endpoint?: string } | null>(null);
  const [members, setMembers] = createSignal<MemberRow[]>([]);
  const [invite, setInvite] = createSignal<InviteView | null>(null);
  const [qr, setQr] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal<PendingRow[]>([]);
  const [now, setNow] = createSignal(Date.now());
  const [endpointInput, setEndpointInput] = createSignal("");
  const [tlsCert, setTlsCert] = createSignal("");
  const [tlsKey, setTlsKey] = createSignal("");

  // 卫星状态
  const [urlInput, setUrlInput] = createSignal(props.initialUrl ?? "");
  const [discoverRows, setDiscoverRows] = createSignal<DiscoverRow[]>([]);
  const [discoverNote, setDiscoverNote] = createSignal<string | null>(null);
  const [preview, setPreview] = createSignal<{ address: string; hubNodeId: string; endpoint: string } | null>(null);
  const [code, setCode] = createSignal("");
  /** 人已点过「是，继续」—— 之后才允许出现输码框（判据 21） */
  const [confirmed, setConfirmed] = createSignal(false);
  const [joinState, setJoinState] = createSignal<"idle" | "submitting" | "approved">("idle");
  const [link, setLink] = createSignal<{ hubNodeId: string; hubEndpoint: string } | null>(null);

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    void refreshStatus();
    void refreshLink();
    pollTimer = setInterval(() => {
      setNow(Date.now());
      void refreshPending();
      void refreshStatus();
    }, 2000);
    onCleanup(() => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    });
  });

  async function refreshStatus(): Promise<void> {
    try {
      const r = await diyService.diy.hub.status({});
      setIdentity(
        r.data.identity
          ? { hubNodeId: r.data.identity.hubNodeId, domainId: r.data.identity.domainId, ...(r.data.identity.endpoint ? { endpoint: r.data.identity.endpoint } : {}) }
          : null,
      );
      setMembers(r.data.memberships);
    } catch (e) {
      setError(msgOf(e));
    }
  }

  async function refreshPending(): Promise<void> {
    if (!identity()) return;
    try {
      const r = await diyService.diy.hub.pending({});
      setPending(r.data.requests);
    } catch {
      /* 轮询失败不刷红条：状态轮询本身会报 */
    }
  }

  async function refreshLink(): Promise<void> {
    try {
      const r = await diyService.diy.hub.link({});
      setLink(r.data ? { hubNodeId: r.data.hubNodeId, hubEndpoint: r.data.hubEndpoint } : null);
    } catch (e) {
      setError(msgOf(e));
    }
  }

  async function run<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    setBusy(name);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(msgOf(e));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function doInit(): Promise<void> {
    const r = await run("init", () =>
      diyService.diy.hub.init({
        endpoint: endpointInput().trim() || undefined,
        tlsCert: tlsCert().trim() || undefined,
        tlsKey: tlsKey().trim() || undefined,
      }),
    );
    if (r) await refreshStatus();
  }

  async function doInvite(): Promise<void> {
    const r = await run("invite", () => diyService.diy.hub.invite({}));
    if (!r) return;
    setInvite(r.data);
    setQr(await QRCode.toDataURL(r.data.inviteUrl, { margin: 1, width: 220 }));
  }

  async function doApprove(requestId: string): Promise<void> {
    const r = await run("approve", () => diyService.diy.hub.approve({ requestId }));
    if (r) {
      await refreshPending();
      await refreshStatus();
    }
  }

  async function doReject(requestId: string): Promise<void> {
    const r = await run("reject", () => diyService.diy.hub.reject({ requestId }));
    if (r) await refreshPending();
  }

  async function doRevoke(nodeId: string): Promise<void> {
    const r = await run("revoke", () => diyService.diy.hub.revoke({ nodeId }));
    if (r) await refreshStatus();
  }

  async function doDiscover(): Promise<void> {
    setDiscoverNote(null);
    const r = await run("discover", () =>
      diyService.diy.remote.list({ sources: "mdns,tailscale", manual: undefined, mdnsTimeoutMs: 800 }),
    );
    if (!r) return;
    setDiscoverRows(r.rows);
    if (r.rows.length === 0) setDiscoverNote("没发现可用的 hub（mDNS 可能被拦；可直接粘贴邀请链接）");
  }

  function pickDiscover(row: DiscoverRow): void {
    // 判据 22：mDNS 条目不可直接配对
    if (row.source === "mdns" || row.sources.includes("mdns")) {
      setDiscoverNote(`${row.displayName ?? row.endpoint} 是 mDNS 地址（自签证书、同网段可伪造同名）：请改用 tailscale 地址配对`);
      return;
    }
    setUrlInput(`${row.endpoint.replace(/\/+$/, "")}/hub/pair?inv=`);
    setDiscoverNote("已填入基址：请补上邀请 id（或直接粘贴完整链接）");
  }

  async function doPreview(): Promise<void> {
    const url = urlInput().trim();
    if (!url) return;
    const r = await run("preview", () => diyService.diy.hub.join({ url, code: undefined, waitMs: undefined }));
    if (!r || !r.data.preview) return;
    setPreview({
      address: r.data.address,
      hubNodeId: r.data.hubNodeId,
      endpoint: r.data.endpoint ?? "",
    });
    setConfirmed(false);
    setJoinState("idle");
  }

  async function doJoin(): Promise<void> {
    const url = urlInput().trim();
    if (!url || !code().trim()) return;
    setJoinState("submitting");
    const r = await run("join", () => diyService.diy.hub.join({ url, code: code().trim(), waitMs: 120_000 }));
    if (!r || r.data.preview) {
      setJoinState("idle");
      return;
    }
    setJoinState(r.data.joinStatus === "approved" ? "approved" : "idle");
    await refreshLink();
  }

  const remaining = createMemo(() => {
    const inv = invite();
    if (!inv) return "";
    const ms = Date.parse(inv.expiresAt) - now();
    if (!Number.isFinite(ms) || ms <= 0) return "已过期";
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  });

  createEffect(() => {
    // 邀请过期后把码灰掉（不让用户拿着死码去输）
    if (invite() && remaining() === "已过期") setQr(null);
  });

  return (
    <div class="flex flex-col h-full min-h-0" data-hub-page>
      <div class="border-b px-3 py-2 shrink-0 flex items-center gap-3">
        <div class="tabs tabs-box">
          <button class="tab" classList={{ "tab-active": tab() === "host" }} onClick={() => setTab("host")}>
            本机作为主控
          </button>
          <button class="tab" classList={{ "tab-active": tab() === "join" }} onClick={() => setTab("join")}>
            加入其他主控
          </button>
        </div>
        <Show when={identity()}>
          {(id) => (
            <span class="text-xs opacity-60 font-mono">
              {id().hubNodeId} · domain {id().domainId}
            </span>
          )}
        </Show>
        <Show when={props.onClose}>
          <button class="btn btn-xs btn-ghost ml-auto" data-hub-close onClick={() => props.onClose?.()}>
            关闭
          </button>
        </Show>
      </div>

      <Show when={error()}>
        <div class="alert alert-error mx-3 mt-2 py-2 text-sm">
          <span class="flex-1 whitespace-pre-wrap">{error()}</span>
          <button class="btn btn-xs" onClick={() => setError(null)}>
            知道了
          </button>
        </div>
      </Show>

      <div class="flex-1 min-h-0 overflow-auto p-3">
        <Show when={tab() === "host"} fallback={<JoinPane />}>
          <Show
            when={identity()}
            fallback={
              <section class="max-w-xl space-y-3">
                <h2 class="text-lg font-semibold">初始化主控</h2>
                <p class="text-sm opacity-70">
                  生成 Hub 密钥对（私钥进系统钥匙串；<code>hub.json</code> 只存公钥），并记下本机对外地址。
                </p>
                <label class="form-control w-full">
                  <div class="label py-1">
                    <span class="label-text">对外地址</span>
                  </div>
                  <input
                    class="input input-bordered w-full font-mono text-sm"
                    placeholder="https://c-mac.gute-fish.ts.net/hub"
                    value={endpointInput()}
                    onInput={(e) => setEndpointInput(e.currentTarget.value)}
                  />
                  <div class="label py-1">
                    <span class="label-text-alt opacity-60">
                      卫星屏幕上比对的就是这个 host；必须是 tailscale 地址（受信任 HTTPS）
                    </span>
                  </div>
                </label>
                <div class="grid grid-cols-2 gap-2">
                  <input
                    class="input input-bordered font-mono text-xs"
                    placeholder="TLS 证书路径（tailscale cert）"
                    value={tlsCert()}
                    onInput={(e) => setTlsCert(e.currentTarget.value)}
                  />
                  <input
                    class="input input-bordered font-mono text-xs"
                    placeholder="TLS 私钥路径"
                    value={tlsKey()}
                    onInput={(e) => setTlsKey(e.currentTarget.value)}
                  />
                </div>
                <button class="btn btn-primary" disabled={busy() === "init"} onClick={() => void doInit()}>
                  {busy() === "init" ? "生成中…" : "初始化"}
                </button>
              </section>
            }
          >
            <div class="space-y-4">
              <section class="card bg-base-200/60">
                <div class="card-body py-3 gap-2">
                  <div class="flex items-center justify-between">
                    <h2 class="card-title text-base">建邀请</h2>
                    <button class="btn btn-sm btn-primary" disabled={busy() === "invite"} onClick={() => void doInvite()}>
                      {busy() === "invite" ? "生成中…" : "添加设备"}
                    </button>
                  </div>
                  <Show
                    when={invite()}
                    fallback={<p class="text-sm opacity-60">点「添加设备」生成 6 位码 + 真实地址 + 二维码。</p>}
                  >
                    {(inv) => (
                      <div class="flex flex-wrap gap-6 items-start">
                        <div class="space-y-1">
                          <div class="text-xs opacity-60">6 位码（口述给另一台机器）</div>
                          <div class="text-4xl font-mono font-bold tracking-wider">{inv().code}</div>
                          <div class="text-xs opacity-60">剩余 {remaining()}</div>
                        </div>
                        <div class="space-y-1 min-w-0">
                          <div class="text-xs opacity-60">本机地址（卫星上要比对这一段）</div>
                          {/* 判据：地址要大、要能一眼认 */}
                          <div class="text-[19px] font-mono font-semibold break-all">{inv().address}</div>
                          <div class="text-xs opacity-50 font-mono break-all">{inv().inviteUrl}</div>
                          <button class="btn btn-xs btn-ghost" onClick={() => void navigator.clipboard.writeText(inv().inviteUrl)}>
                            复制链接
                          </button>
                        </div>
                        <Show when={qr()}>
                          <img src={qr()!} alt="邀请二维码（不含 code）" class="rounded bg-white p-1" />
                        </Show>
                      </div>
                    )}
                  </Show>
                </div>
              </section>

              <section class="card bg-base-200/60">
                <div class="card-body py-3 gap-2">
                  <h2 class="card-title text-base">
                    待批准
                    <Show when={pending().length > 0}>
                      <span class="badge badge-warning badge-sm">{pending().length}</span>
                    </Show>
                  </h2>
                  <Show when={pending().length > 0} fallback={<p class="text-sm opacity-60">没有待批准的请求。</p>}>
                    <For each={pending()}>
                      {(row) => (
                        <div class="flex items-center gap-3 rounded-box bg-base-100/70 px-3 py-2">
                          <div class="flex-1 min-w-0">
                            <div class="font-semibold truncate">{row.displayName} 请求连接</div>
                            <div class="text-xs opacity-60 font-mono">
                              {row.nodeId} · {row.requestedAt}
                            </div>
                          </div>
                          <button class="btn btn-xs btn-ghost" onClick={() => void doReject(row.requestId)}>
                            拒绝
                          </button>
                          <button class="btn btn-xs btn-success" onClick={() => void doApprove(row.requestId)}>
                            同意
                          </button>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              </section>

              <section class="card bg-base-200/60">
                <div class="card-body py-3 gap-2">
                  <h2 class="card-title text-base">已配对</h2>
                  <div class="text-xs opacity-60 font-mono">
                    Node {identity()!.hubNodeId} · Domain {identity()!.domainId}
                    <Show when={identity()!.endpoint}>{(ep) => <> · 端点 {ep()}</>}</Show>
                  </div>
                  <Show when={members().length > 0} fallback={<p class="text-sm opacity-60">还没有已配对的节点。</p>}>
                    <table class="table table-sm">
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
                            <tr>
                              <td>
                                <div class="font-semibold">{m.displayName}</div>
                                <div class="text-xs opacity-55 font-mono">{m.nodeId}</div>
                              </td>
                              <td>
                                <span classList={{ "text-success": m.status === "active", "opacity-50": m.status !== "active" }}>
                                  {m.status === "active" ? (m.online > 0 ? "● 在线" : "○ 离线") : "已撤销"}
                                </span>
                              </td>
                              <td class="text-xs opacity-60">{m.createdAt}</td>
                              <td class="text-right">
                                <Show when={m.status === "active"}>
                                  <button class="btn btn-xs btn-ghost text-error" onClick={() => void doRevoke(m.nodeId)}>
                                    移除
                                  </button>
                                </Show>
                              </td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </Show>
                </div>
              </section>
            </div>
          </Show>
        </Show>
      </div>

      {/* 收到请求时的浮层（判据 23：与列表同源，任一处理另一处同步） */}
      <Show when={tab() === "host" && identity() && pending().length > 0}>
        <div class="toast toast-end toast-top z-50">
          <div class="alert alert-warning shadow-lg">
            <div>
              <div class="font-semibold">{pending()[0]!.displayName} 请求连接</div>
              <div class="text-xs opacity-70 font-mono">{pending()[0]!.nodeId}</div>
            </div>
            <div class="flex gap-1">
              <button class="btn btn-xs" onClick={() => void doReject(pending()[0]!.requestId)}>
                拒绝
              </button>
              <button class="btn btn-xs btn-success" onClick={() => void doApprove(pending()[0]!.requestId)}>
                同意
              </button>
            </div>
          </div>
        </div>
      </Show>

    </div>
  );

  function JoinPane() {
    return (
      <section class="max-w-2xl space-y-4">
        <Show when={link()}>
          {(l) => (
            <div class="alert alert-info py-2 text-sm">
              已加入 <span class="font-mono">{l().hubNodeId}</span>（{l().hubEndpoint}）
            </div>
          )}
        </Show>

        <div class="space-y-2">
          <h2 class="text-lg font-semibold">获取邀请</h2>
          <div class="join w-full">
            <input
              class="input input-bordered join-item flex-1 font-mono text-sm"
              placeholder="粘贴邀请链接（https://host/hub/pair?inv=...）"
              value={urlInput()}
              onInput={(e) => setUrlInput(e.currentTarget.value)}
            />
            <button class="btn btn-primary join-item" disabled={busy() === "preview"} onClick={() => void doPreview()}>
              继续
            </button>
          </div>
          <div class="flex items-center gap-2">
            <button class="btn btn-xs btn-ghost" disabled={busy() === "discover"} onClick={() => void doDiscover()}>
              从局域网发现
            </button>
            <span class="text-xs opacity-60">mDNS 只用于发现，不能直接配对</span>
          </div>
          <Show when={discoverRows().length > 0}>
            <ul class="menu menu-sm bg-base-200/60 rounded-box">
              <For each={discoverRows()}>
                {(row) => (
                  <li>
                    <button
                      classList={{ "opacity-50": row.source === "mdns" || row.sources.includes("mdns") }}
                      onClick={() => pickDiscover(row)}
                    >
                      <span class="font-mono">{row.displayName ?? row.endpoint}</span>
                      <span class="text-xs opacity-60 ml-auto">
                        {row.source === "mdns" || row.sources.includes("mdns") ? "mDNS（需改用 tailscale 地址）" : row.source}
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={discoverNote()}>
            <div class="text-sm text-warning">{discoverNote()}</div>
          </Show>
        </div>

        <Show when={preview()}>
          {(p) => (
            <div class="card bg-base-200/60">
              <div class="card-body gap-3">
                <div class="text-sm opacity-70">将连接到</div>
                {/* 判据 21：地址大字号，且先确认才出现输码框 */}
                <div class="text-[26px] font-mono font-bold break-all">{p().address}</div>
                <div class="text-xs opacity-55 font-mono break-all">{urlInput().trim()}</div>
                <div class="text-sm">跟主控屏幕上显示的地址一致吗？</div>
                <div class="flex gap-2">
                  <button
                    class="btn btn-sm"
                    onClick={() => {
                      setPreview(null);
                      setJoinState("idle");
                    }}
                  >
                    不一致，取消
                  </button>
                  <Show when={!confirmed()}>
                    <button class="btn btn-sm btn-primary" onClick={() => setConfirmed(true)}>
                      是，继续
                    </button>
                  </Show>
                </div>

                <Show when={confirmed()}>
                  <div class="divider my-1" />
                  <Show
                    when={joinState() !== "approved"}
                    fallback={
                      <div class="alert alert-success py-2 text-sm">
                        已批准：Token 已进系统钥匙串，连接信息写入 link.json。
                      </div>
                    }
                  >
                    <div class="flex items-end gap-2">
                      <label class="form-control flex-1">
                        <div class="label py-1">
                          <span class="label-text">输入 6 位码</span>
                        </div>
                        <input
                          class="input input-bordered font-mono text-lg tracking-widest"
                          placeholder="7K9M-Q2"
                          maxlength={8}
                          value={code()}
                          onInput={(e) => setCode(e.currentTarget.value)}
                        />
                      </label>
                      <button class="btn btn-primary" disabled={joinState() === "submitting"} onClick={() => void doJoin()}>
                        {joinState() === "submitting" ? "已提交，等待批准…" : "申请加入"}
                      </button>
                    </div>
                  </Show>
                </Show>
              </div>
            </div>
          )}
        </Show>
      </section>
    );
  }
}
