/**
 * api-domains/facts/impl.ts —— `facts` 域的 handler
 */
import type { ServerBinding } from "@diy-agent/rpc";
import * as factsStore from "../../facts-store";
import { factsApi } from "./api";

export function bindFacts(server: ServerBinding): void {
    server.use({
        prefix: "diy",
        api: factsApi,
        // 模块层由模块自己声明（facts）：与 defineService(name: "diy.facts") 等价
        handlers: {
            facts: {
                status: async ({ input }) =>
                    factsStore.status({
                        ...(input.dir === undefined ? {} : { dir: input.dir }),
                        ...(input.in === undefined ? {} : { in: input.in }),
                    }),
                get: async ({ input }) =>
                    factsStore.get(factsStore.splitList(input.claim), {
                        ...(input.dir === undefined ? {} : { dir: input.dir }),
                        ...(input.in === undefined ? {} : { in: input.in }),
                        ...(input.env === undefined ? {} : { env: input.env }),
                        ...(input.path === undefined ? {} : { paths: factsStore.splitList(input.path) }),
                        ...(input.task === undefined ? {} : { task: input.task }),
                    }),
                brief: async ({ input }) =>
                    factsStore.brief(input.subject, {
                        ...(input.dir === undefined ? {} : { dir: input.dir }),
                        ...(input.in === undefined ? {} : { in: input.in }),
                        ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
                        ...(input.budget === undefined ? {} : { budget: input.budget }),
                    }),
                find: async ({ input }) =>
                    factsStore.find(input.keyword, {
                        ...(input.dir === undefined ? {} : { dir: input.dir }),
                        ...(input.in === undefined ? {} : { in: input.in }),
                        ...(input.limit === undefined ? {} : { limit: input.limit }),
                        ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
                    }),
                submit: async ({ input }) =>
                    factsStore.submitPayload(factsStore.parseSubmitPayload(input.file), {
                        ...(input.dir === undefined ? {} : { dir: input.dir }),
                        ...(input.in === undefined ? {} : { in: input.in }),
                        ...(input.cwd === undefined ? {} : { callerCwd: input.cwd }),
                        dryRun: input.dryRun === true,
                    }),
                raw: async ({ input }) =>
                    factsStore.raw({
                        ...(input.dir === undefined ? {} : { dir: input.dir }),
                        ...(input.in === undefined ? {} : { in: input.in }),
                    }),
                project: async ({ input }) =>
                    factsStore.projectFacts({
                        ...(input.dir === undefined ? {} : { dir: input.dir }),
                        ...(input.in === undefined ? {} : { in: input.in }),
                        ...(input.algorithm === undefined ? {} : { algorithm: input.algorithm }),
                        ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
                        ...(input.env === undefined ? {} : { env: input.env }),
                        ...(input.path === undefined ? {} : { paths: factsStore.splitList(input.path) }),
                        ...(input.task === undefined ? {} : { task: input.task }),
                        ...(input.includeProposed === undefined ? {} : { includeProposed: input.includeProposed }),
                    }),
                affected: async ({ input }) =>
                    factsStore.affectedByFiles(factsStore.splitList(input.files), {
                        ...(input.dir === undefined ? {} : { dir: input.dir }),
                        ...(input.in === undefined ? {} : { in: input.in }),
                    }),
            },
        },
    });
}
