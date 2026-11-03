// @diy-agent/hub — diy 主控 / 卫星的配对与信任（##500）
//
//   Hub 侧：initHubIdentity → createHubServer（/hub/info + /hub/pair + WSS）
//   卫星侧：pairWithHub（先核指纹再交码）→ persistPairing → new HubClient
//
// 协议真源：`docs/plans/2026-11-01-hub-pairing.md`。本包**不依赖 app / Electron**，
// 于是 CLI、测试、将来的 serve 模式都能直接用。

export * from './types.js';
export * from './errors.js';
export * from './code.js';
export * from './key.js';
export * from './secret.js';
export * from './store.js';
export * from './store-fs.js';
export * from './invitation.js';
export * from './pairing.js';
export * from './links.js';
export * from './tls.js';
export * from './hub.js';
export * from './server.js';
export * from './client.js';
export * from './keychain.js';
