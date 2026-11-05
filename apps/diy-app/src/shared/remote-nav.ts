// src/shared/remote-nav.ts
// 🎯 远程导航页（##507）的**可判定语义** —— 纯函数，renderer 与单测共用一份。
//
// 为什么单独成模块（同 instance-view 的教训）：这些是能判定的语义——
//   web 访问地址怎么拼（`webAccessUrl`）/ 这一行能不能配对（`pairingAllowed`）/
//   两个方向的动作标签（`PAIR_ACTIONS`）/ 卫星入网 URL 怎么预填（`joinUrlFor`）。
// 埋在组件里就只能起 Electron 靠截图看（那是"验证"，不是"回归"）。
import type { DiscoveredRow } from "./remote";

/** 一台机器上的配对动作（判据 4：两个方向都要存在，且都走已有 HubPage 流程） */
export interface PairAction {
  /** 稳定键（测试与 data 属性用） */
  key: "invite" | "join";
  /** 按钮文案 */
  label: string;
  /** 打开 HubPage 的哪一屏 */
  tab: "host" | "join";
}

/** 两个方向的动作（顺序 = 展示顺序）：我当主控建邀请 / 我当卫星连它 */
export const PAIR_ACTIONS: readonly PairAction[] = [
  { key: "invite", label: "添加为卫星节点", tab: "host" },
  { key: "join", label: "申请成为它的卫星", tab: "join" },
] as const;

/**
 * 「web 远程访问」要打开的 URL：endpoint 归一成 **https 根地址**。
 *
 * 发现器给的是 `http://host:9400` 这类 /ping 基址；浏览器访问走站点的 HTTPS。
 * 规则：只换 scheme 为 https、去掉路径与查询、补尾斜杠；解析不了 → null（调用方禁用按钮）。
 */
export function webAccessUrl(endpoint: string): string | null {
  const text = endpoint.trim();
  if (text === "") return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname === "") return null;
  return `https://${url.host}/`;
}

/**
 * 这一行**能不能配对**（判据与 HubPage 一致）：mDNS 条目不可直接配对
 * （自签证书、同网段可伪造同名 —— HubPage 判据 22）。只有 web 访问可用。
 */
export function pairingAllowed(row: Pick<DiscoveredRow, "source" | "sources">): boolean {
  return row.source !== "mdns" && !row.sources.includes("mdns");
}

/**
 * 「申请成为它的卫星」预填的入网 URL。
 *
 * 与 HubPage.pickDiscover 同款：基址 + `/hub/pair?inv=`（邀请 id 由人补或粘贴完整链接）。
 * mDNS 不该走到这里（pairingAllowed 拦），但仍给基址 —— 让调用方只关心 tab/URL 两件事。
 */
export function joinUrlFor(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, "")}/hub/pair?inv=`;
}

/** 机器行的显示名（displayName → endpoint host → endpoint） */
export function machineLabel(row: Pick<DiscoveredRow, "displayName" | "endpoint">): string {
  const named = row.displayName?.trim();
  if (named) return named;
  try {
    return new URL(row.endpoint).host || row.endpoint;
  } catch {
    return row.endpoint;
  }
}

/** 来源一行为人读标签（mDNS 要显式标出「不能直接配对」的原因） */
export function sourceLabel(row: Pick<DiscoveredRow, "source" | "sources">): string {
  if (!pairingAllowed(row)) return "mDNS（局域网）";
  return row.source;
}

// ─────────────────────────────────────────────────────────────────────────────
// 设备列表合并（##511：蓝牙/WiFi 范式）
//
// 用户原话：「连接状态和候选连接的信息需要整合」「同一台机器只出现一行」。
// 以前是两张表 —— 「其他机器」（发现到的）+「已配对」（hub.status.memberships），
// 同一台机器会在两处各出现一次，状态还两套说法。这里把它们合成一份：
//
//   已连接（connected）── 我的 WSS 在它那儿是通的 / 它连到我这儿有活连接
//   已配对（paired）   ── 配过对但此刻没连上（离线 / 未连接 / 已撤销）
//   未配对（available）── 只被发现到，还没配对
//
// 同一台机器的判据是**节点身份**（不是地址）：`diy hub init` 的 hubNodeId 与
// `/ping` 的实例 id 是同一个值（`ensureIdentity().identity.id`），所以发现行带 id 时
// 就能与 membership / link 对齐；发现行没 id 时退回按 host 对齐。

/** 已配对成员（`hub status` 的一行） */
export interface HubMemberRow {
  nodeId: string;
  displayName: string;
  status: string;
  online: number;
  createdAt: string;
}

/** 卫星侧 link.json（不含 token） */
export interface HubLinkRow {
  hubNodeId: string;
  hubEndpoint: string;
}

/** 卫星侧长连状态（`hub connection`） */
export type HubConnectionState = "idle" | "no-token" | "connecting" | "online" | "offline" | "revoked";

export type DeviceGroup = "connected" | "paired" | "available";

/**
 * **连接状态**：这一行现在能不能通。
 *
 * 与授权严格分离（2026-11-05 用户裁：「连接状态和授权状态分开，分开 2 列显示」）——
 * 一台机器可以「在线但未配对」（能 ping 通，我管不了它），
 * 也可以「已配对但离线」（我管它，但它现在不在线）。混成一列就丢了这两种情况。
 */
export type ConnectionState = "online" | "offline" | "unknown";

/**
 * **授权状态**：我和它是什么管理关系。
 *
 *   master    我是管理节点（它是我管的成员节点）
 *   satellite 我是成员节点（它管我）
 *   none      未配对
 *   revoked   配对关系已撤销（保留展示，便于重配）
 */
export type TrustRole = "master" | "satellite" | "none" | "revoked";

/** 一台机器（合并后的一行） */
export interface DeviceRow {
  /** 稳定键（合并用；也做 data 属性） */
  key: string;
  name: string;
  group: DeviceGroup;
  /** 行上的补充说明（人与机器都读；不是判据，判据看 connection / trust） */
  status: string;
  /** 连接状态（列 1） */
  connection: ConnectionState;
  /** 授权状态（列 2） */
  trust: TrustRole;
  /** 我是它的卫星（link.json） */
  link?: HubLinkRow;
  /** 它已经和我配对（membership） */
  member?: HubMemberRow;
  /** 发现得到的可达信息（endpoint / 来源 / meta） */
  discovered?: DiscoveredRow;
}

/** 分组顺序与标题（已连接在前，未配对垫底） */
export const DEVICE_GROUPS: readonly { key: DeviceGroup; label: string }[] = [
  { key: "connected", label: "已连接" },
  { key: "paired", label: "已配对" },
  { key: "available", label: "未配对" },
] as const;

function urlOf(endpoint: string | null | undefined): URL | null {
  if (!endpoint) return null;
  const text = endpoint.trim();
  if (text === "") return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
}

function hostOf(endpoint: string | null | undefined): string | null {
  return urlOf(endpoint)?.host || null;
}

/** 不含端口的 hostname（主控的 `/hub` 与实例的 `:9400` 端口不同，身份却是同一台机器） */
function hostnameOf(endpoint: string | null | undefined): string | null {
  return urlOf(endpoint)?.hostname || null;
}

/** 卫星侧连接状态 → 行上那句话（`no-token` 必须是「未连接」，不是「离线」） */
function linkStatus(state: HubConnectionState | null | undefined): string {
  switch (state) {
    case "online":
      return "已连接";
    case "connecting":
      return "连接中…";
    case "offline":
      return "离线";
    case "revoked":
      return "已撤销";
    case "no-token":
    case "idle":
    case null:
    case undefined:
    default:
      return "未连接";
  }
}

export interface MergeDevicesInput {
  members?: HubMemberRow[];
  discovered?: DiscoveredRow[];
  /** 我作为卫星加入的主控（link.json） */
  link?: HubLinkRow | null;
  /** 卫星侧长连状态 */
  connection?: HubConnectionState | null;
}

/**
 * 把「已配对」与「发现到的」合成一份设备清单：**一台机器一行**。
 *
 * 合并不是按字符串名字，而是按节点身份：member.nodeId / link.hubNodeId / discovered.id
 * 三者同源（都是 `$DIY_HOME/instance-id`）。发现行没 id 时按 endpoint 的 host 对齐
 * （link 同理：它的 endpoint host 就是发现行会给出的 host）。
 */
export function mergeDevices(input: MergeDevicesInput = {}): DeviceRow[] {
  const rows = new Map<string, DeviceRow>();
  /** host → 已存在行的 key（给「没有 id 的发现行」兜底对齐） */
  const byHost = new Map<string, string>();
  /** hostname → key（主控 `/hub` 与实例 `:9400` 只差端口，仍算同一台机器） */
  const byHostname = new Map<string, string>();

  const indexEndpoint = (endpoint: string | null | undefined, key: string): void => {
    const host = hostOf(endpoint);
    const name = hostnameOf(endpoint);
    if (host) byHost.set(host, key);
    if (name) byHostname.set(name, key);
  };

  const upsert = (key: string, seed: Omit<DeviceRow, "key">): DeviceRow => {
    const existing = rows.get(key);
    if (existing) return existing;
    const row: DeviceRow = { key, ...seed };
    rows.set(key, row);
    return row;
  };

  // ① 已配对成员
  for (const member of input.members ?? []) {
    const revoked = member.status !== "active";
    upsert(`node:${member.nodeId}`, {
      name: member.displayName || member.nodeId,
      group: "paired",
      status: revoked ? "已撤销" : member.online > 0 ? "在线" : "离线",
      // memberships 是「我管的成员」，所以授权角色 = 我是管理节点（除非已撤销）
      trust: revoked ? "revoked" : "master",
      connection: revoked ? "unknown" : member.online > 0 ? "online" : "offline",
      member,
    });
  }

  // ② 我是它的卫星（link.json）—— 与 membership 同 key 时会合并到同一行
  const link = input.link ?? null;
  if (link) {
    const key = `node:${link.hubNodeId}`;
    const state = input.connection ?? null;
    const row = upsert(key, {
      name: hostOf(link.hubEndpoint) ?? link.hubNodeId,
      group: "paired",
      status: linkStatus(state),
      // link.json 存在 = 我是它的卫星 ⇒ 授权角色是「成员节点」
      trust: state === "revoked" ? "revoked" : "satellite",
      connection: state === "online" ? "online" : state === "revoked" ? "unknown" : "offline",
      link,
    });
    row.link = link;
    indexEndpoint(link.hubEndpoint, key);
  }

  // ③ 发现到的机器
  for (const found of input.discovered ?? []) {
    const host = hostOf(found.endpoint);
    const name = hostnameOf(found.endpoint);
    const matched = (host ? byHost.get(host) : undefined) ?? (name ? byHostname.get(name) : undefined);
    const key = found.id
      ? `node:${found.id}`
      : matched ?? (host ? `ep:${host}` : `ep:${found.endpoint}`);
    const row = upsert(key, {
      name: machineLabel(found),
      group: "available",
      status: "可配对",
      // 能被发现 = 这一轮探测通过 ⇒ 连接是通的；授权：还没配对
      trust: "none",
      connection: "online",
      discovered: found,
    });
    row.discovered = found;
    indexEndpoint(found.endpoint, key);
  }

  // ④ 定组 + 行上那句话 + **两个独立维度**（连接 / 授权）
  for (const row of rows.values()) {
    const member = row.member;
    const linkState = row.link ? input.connection : null;

    // ── 授权：我和它是什么管理关系 ──
    //   有 membership ⇒ 我是主控（它是我管的节点）；有 link ⇒ 我是卫星（它管我）
    row.trust = member
      ? member.status !== "active"
        ? "revoked"
        : "master"
      : row.link
        ? linkState === "revoked"
          ? "revoked"
          : "satellite"
        : "none";

    // ── 连接：这条行现在能不能通（**与授权无关**）──
    //   一个「在线但未配对」的机器应该两列分别显示 online + none，而不是被折叠成「可配对」
    if (member) {
      row.connection = member.status !== "active" ? "unknown" : member.online > 0 ? "online" : "offline";
    } else if (row.link) {
      row.connection = linkState === "online" ? "online" : linkState === "revoked" ? "unknown" : "offline";
    } else {
      // 只有被发现的机器才会进 rows；能发现说明探测通了
      row.connection = row.discovered === undefined ? "unknown" : "online";
    }

    if (member && member.status !== "active") {
      row.group = "paired";
      row.status = "已撤销";
    } else if (member && member.online > 0) {
      row.group = "connected";
      row.status = member.online > 1 ? `${member.online} 条连接` : "已连接";
    } else if (row.link && linkState === "online") {
      row.group = "connected";
      row.status = "已连接";
    } else if (row.link && (member === undefined || member.online === 0)) {
      // 我是它的卫星但长连没通：这里就是「未连接 / 离线」，**不再伪装成在线**
      row.group = "paired";
      row.status = member ? "离线" : linkStatus(linkState);
    } else if (member) {
      row.group = "paired";
      row.status = "离线";
    } else {
      row.group = "available";
      row.status = "可配对";
    }
  }

  // ⑤ 分组排序：已连接 → 已配对 → 未配对；组内按名字
  const order = new Map(DEVICE_GROUPS.map((g, i) => [g.key, i]));
  return [...rows.values()].sort(
    (a, b) => (order.get(a.group) ?? 9) - (order.get(b.group) ?? 9) || a.name.localeCompare(b.name, "zh"),
  );
}

/** 一台机器能不能给两个方向的配对动作（mDNS 不行；已撤销的成员也不行） */
export function devicePairingAllowed(row: DeviceRow): boolean {
  if (!row.discovered) return false;
  if (row.member && row.member.status !== "active") return false;
  return pairingAllowed(row.discovered);
}

/** 详情页要展示的端址：发现行的 endpoint 优先，其次 link 的 hubEndpoint */
export function deviceEndpoint(row: DeviceRow): string | null {
  return row.discovered?.endpoint ?? row.link?.hubEndpoint ?? null;
}
