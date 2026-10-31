// @diy-agent/remote — **纯内核**（不 import node:* / electron）：契约 + 身份判据 + 合并/排版 + 纯解析。
// 需要 IO（fs / http / mDNS / tailscale CLI）的实现在 `@diy-agent/remote/node`。
//
//   import { resolveIdentity, mergeDiscovered, formatDiscoveryList } from '@diy-agent/remote';
//   import { ensureIdentity, startPingServer, discoverAll } from '@diy-agent/remote/node';

export * from './types.js';
export * from './identity.js';
export * from './merge.js';
export * from './format.js';
export * from './discover/manual.js';
export * from './discover/tailscale.js';
