// @diy-agent/remote/node — **Node 侧实现**：落盘身份 / /ping 服务端与客户端 / 四个发现器 / 发现链。
// 只允许 Node 主进程与 CLI 用（renderer 走纯入口 `@diy-agent/remote`）。

export { readStoredIdentity, ensureIdentity, setDisplayName } from './identity.js';
export { fetchPing, parsePingInfo, type PingResult } from './ping-client.js';
export {
    startPingServer,
    bindHint,
    localHostname,
    type PingServerHandle,
    type PingServerOptions,
} from './ping-server.js';
export { localDiscoverer, defaultRegistryDir, parseRegistryRecord, type LocalDiscoverDeps } from './local.js';
export { tailscaleDiscoverer, runTailscaleCli, type TailscaleDiscoverDeps } from './tailscale.js';
export {
    mdnsDiscoverer,
    createBonjourBrowser,
    publishMdns,
    recordToInstance,
    type MdnsBrowser,
    type MdnsServiceRecord,
    type MdnsPublisher,
    type MdnsPublishOptions,
} from './mdns.js';
export {
    discoverAll,
    buildDiscoverers,
    ALL_SOURCES,
    type DiscoverAllOptions,
    type DiscoverAllResult,
    type DiscoverFailure,
} from './discover.js';
export { writeFileAtomic } from './atomic-write.js';
