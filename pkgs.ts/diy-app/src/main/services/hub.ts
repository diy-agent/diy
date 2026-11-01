// hub.ts — diy hub 配对的主进程编排（##500）。
//
// 职责分三层：
//   ① 身份 / 密钥：`@diy-agent/hub` 的 `initHubIdentity` / 钥匙串（**本文件不碰私钥明文**）
//   ② 服务端：懒启动 `createHubServer`（只有第一次用到才起；没证书就**明确报错**，判据 9）
//   ③ 卫星侧：`preparePairing`（只显示地址）→ `completePairing`（人确认后才交码）
//
// 本文件只做编排与形态转换；可单测的分支都在包内（`pkgs.ts/diy-hub/tests`）。

import {
  buildInviteUrl,
  completePairing,
  createHubServer,
  createSystemSecretStore,
  displayAddress,
  listMemberships,
  listPendingRequests,
  formatInviteCode,
  initHubIdentity,
  loadHubIdentity,
  loadHubPrivateKey,
  normalizeHubEndpoint,
  persistPairing,
  preparePairing,
  readLink,
  resolveTlsMaterial,
  writeFileAtomic,
  FileHubStore,
  HubError,
  LINK_FILE,
  PEERS_FILE,
  hubDir,
  type HubIdentity,
  type HubLink,
  type HubServer,
  type Membership,
  type PairingRequest,
} from "@diy-agent/hub";
import { ensureIdentity } from "@diy-agent/remote/node";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { diyHome } from "../core/state";

export interface HubInitResult {
  hubNodeId: string;
  domainId: string;
  publicKey: string;
  endpoint: string | null;
}

export interface HubInviteResult {
  code: string;
  /** 屏幕上三样之一：真实地址（人比对） */
  address: string;
  /** 屏幕上三样之三：二维码内容 = 邀请 URL（不含 code） */
  inviteUrl: string;
  expiresAt: string;
}

export interface HubPendingRow {
  requestId: string;
  nodeId: string;
  displayName: string;
  requestedAt: string;
}

export interface HubStatusRow {
  nodeId: string;
  displayName: string;
  status: string;
  online: number;
  createdAt: string;
}

export interface HubJoinPreview {
  preview: true;
  /** 要连接到哪（host）—— 人跟主控屏幕比对的就是这一行 */
  address: string;
  endpoint: string;
  hubNodeId: string;
}

export interface HubJoinResult {
  preview: false;
  address: string;
  hubNodeId: string;
  domainId: string;
  /** pending = 已提交等批准；approved = 已拿到 Token 并落盘 */
  status: "pending" | "approved";
  membershipId?: string;
}

export class HubService {
  private server: HubServer | null = null;
  private starting: Promise<HubServer> | null = null;
  private readonly secrets = createSystemSecretStore();

  private get home(): string {
    return diyHome();
  }

  /** `diy hub init`：生成 / 复用身份（私钥进钥匙串），记下对外地址与证书路径 */
  async init(input: { endpoint?: string; tlsCert?: string; tlsKey?: string } = {}): Promise<HubInitResult> {
    const resolved = ensureIdentity(this.home, { hostname: hostname(), appName: "diy" });
    const existing = await this.readIdentity();
    const endpoint = input.endpoint ?? existing?.endpoint;
    const identity = await initHubIdentity({
      home: this.home,
      secrets: this.secrets,
      hubNodeId: resolved.identity.id,
      endpoint: endpoint ? normalizeHubEndpoint(endpoint) : undefined,
    });
    if (input.tlsCert && input.tlsKey) {
      // 证书**路径**记在这里（内容不进 JSON；私钥文件本身由系统权限保护）
      writeFileAtomic(
        join(hubDir(this.home), "tls.json"),
        JSON.stringify({ cert: input.tlsCert, key: input.tlsKey }, null, 2),
      );
    }
    return {
      hubNodeId: identity.hubNodeId,
      domainId: identity.domainId,
      publicKey: identity.publicKey,
      endpoint: identity.endpoint ?? null,
    };
  }

  /** `diy hub invite`：建邀请，返回三样（码 / 地址 / 邀请 URL） */
  async invite(): Promise<HubInviteResult> {
    const server = await this.ensureServer();
    const identity = await this.requireIdentity();
    if (!identity.endpoint) {
      throw new HubError("hub/bad-input", "还没有对外地址：先跑 diy hub init --endpoint https://<host>/hub");
    }
    const invite = await server.invite();
    return {
      code: formatInviteCode(invite.code),
      address: displayAddress(identity.endpoint),
      inviteUrl: buildInviteUrl({ endpoint: identity.endpoint, inviteId: invite.inviteId }),
      expiresAt: invite.expiresAt,
    };
  }

  async pending(): Promise<HubPendingRow[]> {
    // 只读 peers.json：不需要起服务（没证书也能看队列）
    return (await listPendingRequests(await this.store())).map(toPendingRow);
  }

  /** 批准（**不返回 token**：Token 经长轮询回到卫星，Hub 侧只留哈希） */
  async approve(requestId: string): Promise<{ nodeId: string; displayName: string; status: string }> {
    const server = await this.ensureServer();
    const result = await server.approve(requestId);
    return {
      nodeId: result.request.nodeId,
      displayName: result.request.displayName,
      status: result.request.status,
    };
  }

  async reject(requestId: string): Promise<{ status: string }> {
    const server = await this.ensureServer();
    const request = await server.reject(requestId);
    return { status: request.status };
  }

  async revoke(nodeId: string): Promise<{ nodeId: string; status: string }> {
    const server = await this.ensureServer();
    await server.revoke(nodeId);
    return { nodeId, status: "revoked" };
  }

  async status(): Promise<{ identity: HubIdentity | null; memberships: HubStatusRow[] }> {
    const identity = await this.readIdentity();
    if (!identity) return { identity: null, memberships: [] };
    const memberships = await listMemberships(await this.store());
    return {
      identity,
      memberships: memberships.map((m) => toStatusRow(m, this.server?.connectionCount(m.nodeId) ?? 0)),
    };
  }

  /**
   * `diy hub join <url>`（不带 code）：只解析地址并显示，**不发任何秘密**。
   * 人看到 `address` 后，再带 `--code` 重跑。
   */
  async joinPreview(url: string): Promise<HubJoinPreview> {
    const prepared = await preparePairing(url, { allowInsecure: this.allowInsecure() });
    return {
      preview: true,
      address: prepared.address,
      endpoint: prepared.endpoint,
      hubNodeId: prepared.info.hubNodeId,
    };
  }

  /** `diy hub join <url> --code 7K9M-Q2`：提交申请并等待批准，拿到 Token 后进钥匙串 */
  async join(url: string, input: { code?: string; waitMs?: number } = {}): Promise<HubJoinResult | HubJoinPreview> {
    if (!input.code) return this.joinPreview(url);

    const prepared = await preparePairing(url, { allowInsecure: this.allowInsecure() });
    const local = ensureIdentity(this.home, { hostname: hostname(), appName: "diy" });
    const { result, keyPair } = await completePairing(
      prepared,
      {
        code: input.code,
        nodeId: local.identity.id,
        displayName: local.identity.displayName,
        waitMs: input.waitMs ?? 120_000,
      },
      { allowInsecure: this.allowInsecure() },
    );

    if (result.status === "approved" && result.token) {
      // Token 进钥匙串；卫星私钥也进钥匙串（审批回执带 membershipId 时用它做 account 后缀）
      await this.secrets.set(
        `node-private-key:${result.membershipId ?? prepared.info.hubNodeId}`,
        keyPair.privateKey,
      );
      await persistPairing(
        { secrets: this.secrets, linkFile: join(hubDir(this.home), LINK_FILE), endpoint: prepared.endpoint },
        prepared.info,
        result.token,
      );
    }
    return {
      preview: false,
      address: prepared.address,
      hubNodeId: prepared.info.hubNodeId,
      domainId: prepared.info.domainId,
      status: result.status,
      ...(result.membershipId ? { membershipId: result.membershipId } : {}),
    };
  }

  /** 卫星侧本地状态（不含 token） */
  async link(): Promise<HubLink | null> {
    return readLink(join(hubDir(this.home), LINK_FILE));
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.close();
      this.server = null;
    }
    this.starting = null;
  }

  // ── 内部 ──────────────────────────────────────────────

  private async readIdentity(): Promise<HubIdentity | null> {
    try {
      return await loadHubIdentity(this.home);
    } catch (e) {
      if (e instanceof HubError && e.code === "hub/not-initialized") return null;
      throw e;
    }
  }

  /** 直接读写 peers.json 的 store（不需要起服务；server 也用同一个文件） */
  private async store(): Promise<FileHubStore> {
    const identity = (await this.readIdentity()) ?? { domainId: "default", hubNodeId: "diy-unknown" };
    return new FileHubStore({
      file: join(hubDir(this.home), PEERS_FILE),
      domainId: identity.domainId,
      hubNodeId: identity.hubNodeId,
    });
  }

  private async requireIdentity(): Promise<HubIdentity> {
    const identity = await this.readIdentity();
    if (!identity) throw new HubError("hub/not-initialized", "先跑 diy hub init");
    return identity;
  }

  private async ensureServer(): Promise<HubServer> {
    if (this.server) return this.server;
    if (this.starting) return this.starting;
    this.starting = this.start();
    try {
      this.server = await this.starting;
      return this.server;
    } finally {
      this.starting = null;
    }
  }

  private async start(): Promise<HubServer> {
    const identity = await this.requireIdentity();
    const tls = resolveTlsMaterial(await this.tlsSources());
    return createHubServer({
      identity,
      store: new FileHubStore({
        file: join(hubDir(this.home), PEERS_FILE),
        domainId: identity.domainId,
        hubNodeId: identity.hubNodeId,
      }),
      serverKey: await loadHubPrivateKey(this.secrets),
      tls,
      host: process.env.DIY_HUB_HOST || "127.0.0.1",
      port: Number(process.env.DIY_HUB_PORT ?? 0),
      allowInsecureHttp: this.allowInsecure(),
    });
  }

  private async tlsSources(): Promise<{ certPath?: string; keyPath?: string }> {
    try {
      const parsed = JSON.parse(readFileSync(join(hubDir(this.home), "tls.json"), "utf-8")) as {
        cert?: string;
        key?: string;
      };
      return { certPath: parsed.cert, keyPath: parsed.key };
    } catch {
      return {};
    }
  }

  /** 只有显式 `DIY_HUB_ALLOW_INSECURE=1` 才允许明文（单测 / lab；生产必须 TLS） */
  private allowInsecure(): boolean {
    return process.env.DIY_HUB_ALLOW_INSECURE === "1";
  }
}

function toPendingRow(r: PairingRequest): HubPendingRow {
  return {
    requestId: r.requestId,
    nodeId: r.nodeId,
    displayName: r.displayName,
    requestedAt: r.requestedAt,
  };
}

function toStatusRow(m: Membership, online: number): HubStatusRow {
  return {
    nodeId: m.nodeId,
    displayName: m.displayName,
    status: m.status,
    online,
    createdAt: m.createdAt,
  };
}

/** 进程级单例（api-impl 绑定用；main 退出时 stop） */
export const hubService = new HubService();
