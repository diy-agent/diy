/**
 * api-domains/hub/impl.ts —— `hub` 域的 handler（配对：邀请码 + Owner 审批 + Token 长连）
 */
import type { ServerBinding } from "@diy-agent/rpc";
import { hubService as hubBiz } from "../../hub";
import { hubApi } from "./api";

export function bindHub(server: ServerBinding): void {
    server.use({
        prefix: "diy",
        api: hubApi,
        // 模块层由模块自己声明（hub）：与 defineService(name: "diy.hub") 等价
        handlers: {
            hub: {
                init: async ({ input }) => ({ status: "ok", data: await hubBiz.init(input) }),
                invite: async ({ input }) => ({ status: "ok", data: await hubBiz.invite(input ?? {}) }),
                pending: async () => ({ status: "ok", data: { requests: await hubBiz.pending() } }),
                approve: async ({ input }) => {
                    const r = await hubBiz.approve(input.requestId);
                    return {
                        status: "ok",
                        data: { nodeId: r.nodeId, displayName: r.displayName, requestStatus: r.status },
                    };
                },
                reject: async ({ input }) => {
                    const r = await hubBiz.reject(input.requestId);
                    return { status: "ok", data: { requestStatus: r.status } };
                },
                revoke: async ({ input }) => {
                    const r = await hubBiz.revoke(input.nodeId);
                    return { status: "ok", data: { nodeId: r.nodeId, membershipStatus: r.status } };
                },
                status: async () => {
                    const r = await hubBiz.status();
                    return {
                        status: "ok",
                        data: {
                            identity: r.identity
                                ? {
                                      hubNodeId: r.identity.hubNodeId,
                                      domainId: r.identity.domainId,
                                      publicKey: r.identity.publicKey,
                                      ...(r.identity.endpoint ? { endpoint: r.identity.endpoint } : {}),
                                      createdAt: r.identity.createdAt,
                                  }
                                : null,
                            memberships: r.memberships,
                        },
                    };
                },
                join: async ({ input }) => {
                    const r = await hubBiz.join(input.url, {
                        ...(input.code === undefined ? {} : { code: input.code }),
                        ...(input.waitMs === undefined ? {} : { waitMs: input.waitMs }),
                        ...(input.autoJoin === true ? { autoJoin: true } : {}),
                        ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
                    });
                    return {
                        status: "ok",
                        data: r.preview
                            ? { preview: true, address: r.address, hubNodeId: r.hubNodeId, endpoint: r.endpoint }
                            : {
                                  preview: false,
                                  address: r.address,
                                  hubNodeId: r.hubNodeId,
                                  domainId: r.domainId,
                                  joinStatus: r.status,
                                  ...(r.membershipId ? { membershipId: r.membershipId } : {}),
                              },
                    };
                },
                link: async () => ({ status: "ok", data: await hubBiz.link() }),
                // ##511：卫星侧长连状态（主控侧「在线」看的是它自己的 connectionCount，这里看卫星自己）
                connection: async () => ({ status: "ok", data: await hubBiz.connection() }),
            },
        },
    });
}
