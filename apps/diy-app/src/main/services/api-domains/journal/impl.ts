/**
 * api-domains/journal/impl.ts —— `journal` 域的 handler
 */
import type { ServerBinding } from "@diy-agent/rpc";
import * as journalStore from "../../journal-store";
import { journalApi } from "./api";

export function bindJournal(server: ServerBinding): void {
    server.use({
        prefix: "diy",
        api: journalApi,
        // 模块层由模块自己声明（journal）：与 defineService(name: "diy.journal") 等价
        handlers: {
            journal: {
            add: async ({ input }) => {
                const body = journalStore.resolveBody(input.body, input.bodyText, input.bodyFile);
                return journalStore.addEntries(input.task, [
                    {
                        kind: input.kind,
                        title: input.title,
                        ...(body === undefined ? {} : { body }),
                        ...(input.refs === undefined ? {} : { refs: journalStore.splitRefs(input.refs) }),
                        ...(input.round === undefined ? {} : { round: input.round }),
                        ...(input.author === undefined ? {} : { author: journalStore.parseAuthorSpec(input.author) }),
                        ...(input.anchor === undefined ? {} : { anchor: journalStore.parseAnchorSpec(input.anchor) }),
                    },
                ]);
            },
            raw: async ({ input }) => journalStore.rawJournal(input.task),
            find: async ({ input }) =>
                journalStore.findJournal(input.task, {
                    ...(input.kind === undefined ? {} : { kind: journalStore.splitKinds(input.kind) }),
                    ...(input.since === undefined ? {} : { since: input.since }),
                    ...(input.until === undefined ? {} : { until: input.until }),
                    ...(input.grep === undefined ? {} : { grep: input.grep }),
                    ...(input.limit === undefined ? {} : { limit: input.limit }),
                    ...(input.order === undefined ? {} : { order: input.order }),
                }),
            stats: async ({ input }) => journalStore.journalStats(input.task),
            import: async ({ input }) =>
                journalStore.importEntries(input.task, journalStore.parseImportPayload(input.file), input.dryRun === true),
        } },
    });
}
