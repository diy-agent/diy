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
