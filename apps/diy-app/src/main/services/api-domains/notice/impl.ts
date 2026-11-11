/**
 * api-domains/notice/impl.ts —— `notice` 域的 handler
 *
 * 用 `noticeService.bind`：路径由 service 的 `name`（`diy.notice`）+ 树内路径推，
 * 不依赖 `bindNames`。
 */
import type { ServerBinding } from "@diy-agent/rpc";
import { modelNoticeHub } from "../../model-notice";
import { inboxHub } from "../../inbox";
import { noticeApi } from "./api";

export function bindNotice(server: ServerBinding): void {
    server.use({
        prefix: "diy",
        api: noticeApi,
        // 模块层由模块自己声明（notice）：与 defineService(name: "diy.notice") 等价
        handlers: {
            notice: {
            list: async () => modelNoticeHub.list(),
            dismiss: async ({ input }) => {
                modelNoticeHub.dismiss(input.id);
                return { status: "ok" };
            },
            watch: async function* ({ signal }) {
                for await (const n of modelNoticeHub.subscribe(signal)) yield n;
            },
            inbox: {
                list: async ({ input }) => inboxHub.list({ taskUri: input.taskUri, limit: input.limit }),
                watch: async function* ({ signal }) {
                    for await (const e of inboxHub.subscribe(signal)) yield e;
                },
            },
        } },
    });
}
