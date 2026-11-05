// tests/services/hub-client.test.ts
// 🎯 ##511 判据 1/3：卫星侧真的把 WSS 长连建起来（「离线」误报的功能缺口）
//
// 以前 `hub join` 拿完 Token 就结束了 —— 没有任何客户端去连，主控侧
// `connectionCount` 恒 0，于是永远显示「离线」。这里锁两件事：
//   1. 有 link.json + 钥匙串里有 Token → `startClient()` 建长连，主控侧 connectionCount > 0
//   2. 有 link.json 但没 Token → 状态是 `no-token`（UI 显示「未连接」，不是「离线」），且不连
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemorySecretStore,
  buildInviteUrl,
  completePairing,
  createHubServer,
  generateKeyPair,
  hubDir,
  normalizeHubEndpoint,
  persistPairing,
  preparePairing,
  LINK_FILE,
  MemoryHubStore,
  emptyPeerState,
  type HubServer,
} from "@diy-agent/hub";
import { HubService } from "../../src/main/services/hub";

const tempDirs: string[] = [];
const servers: HubServer[] = [];

afterEach(async () => {
  delete process.env["DIY_HOME"];
  for (const s of servers.splice(0)) await s.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "diy-hub-client-test-"));
  tempDirs.push(dir);
  process.env["DIY_HOME"] = dir;
  mkdirSync(hubDir(dir), { recursive: true });
  return dir;
}

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 起一个真主控（明文放行：单测）+ 一次完整配对，产出 Token 与 info */
async function pairedHub(): Promise<{ hub: HubServer; endpoint: string; info: Awaited<ReturnType<typeof preparePairing>>["info"]; token: string }> {
  const pair = generateKeyPair();
  const hub = await createHubServer({
    identity: {
      protocolVersion: 1,
      domainId: "default",
      hubNodeId: "diy-hub01",
      publicKey: pair.publicKey,
      createdAt: "2026-11-01T00:00:00.000+0800",
    },
    store: new MemoryHubStore(emptyPeerState("default", "diy-hub01")),
    serverKey: pair.privateKey,
    host: "127.0.0.1",
    port: 0,
  });
  servers.push(hub);
  const endpoint = normalizeHubEndpoint(hub.url);
  const invite = await hub.invite({ autoApprove: true });
  const invited = await preparePairing(buildInviteUrl({ endpoint, inviteId: invite.inviteId }), {
    allowInsecure: true,
  });
  const { result } = await completePairing(
    invited,
    { code: invite.code, nodeId: "diy-sat01", displayName: "c-vn7", waitMs: 2000 },
    { allowInsecure: true },
  );
  return { hub, endpoint, info: invited.info, token: result.token! };
}

describe("HubService 卫星侧长连（##511 判据 1）", () => {
  it("link.json + Token → startClient 建长连，主控 connectionCount > 0", async () => {
    const home = tempHome();
    const { hub, endpoint, info, token } = await pairedHub();
    const secrets = new MemorySecretStore();
    await persistPairing({ secrets, linkFile: join(hubDir(home), LINK_FILE), endpoint }, info, token);

    const service = new HubService(secrets);
    try {
      await service.startClient();
      await waitFor(async () => (await service.connection()).state === "online");
      expect(hub.connectionCount("diy-sat01")).toBe(1);
      expect((await service.connection()).hubNodeId).toBe("diy-hub01");
    } finally {
      service.stopClient();
    }
    await waitFor(() => hub.connectionCount("diy-sat01") === 0);
  });

  it("没 link.json → idle（不连，也不报错）", async () => {
    tempHome();
    const service = new HubService(new MemorySecretStore());
    await service.startClient();
    expect((await service.connection()).state).toBe("idle");
  });

  it("有 link.json 但钥匙串没 Token → no-token（「未连接」而不是「离线」）", async () => {
    const home = tempHome();
    const { info, endpoint } = await pairedHub();
    // 只写 link.json，不写 Token
    const linkFile = join(hubDir(home), LINK_FILE);
    await persistPairing({ secrets: new MemorySecretStore(), linkFile, endpoint }, info, "");

    const service = new HubService(new MemorySecretStore());
    await service.startClient();
    const row = await service.connection();
    expect(row.state).toBe("no-token");
    expect(row.hubNodeId).toBe("diy-hub01");
    expect(row.reason).toBeTruthy();
  });
});
