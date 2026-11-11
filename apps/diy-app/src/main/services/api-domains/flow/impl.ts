/**
 * api-domains/flow/impl.ts —— `flow` 域的 handler（15 个）
 *
 * 从 api-impl.ts 手工拆出。带点的 path（`artifact.put` / `thread.list` / `thread.post`
 * / `params.get` / `params.set`）展开为嵌套对象 —— `bind` 的 handlers 形状必须与 api 树同构。
 */
import type { ServerBinding } from "@diy-agent/rpc";
import * as flow from "../../../core/flow";
import { requirePostText } from "../../../core/flow-store";
import * as flowThread from "../../../core/flow-thread";
import { flowPrompt } from "../../flow-prompt";
import { AsyncQueue } from "../../async-queue";
import { flowApi } from "./api";

/**
 * 「多个 k=v」型入参的归一：schema 里是「JSON 数组或单个裸值」（api.ts 的 kvList 工厂），
 * parser 只对 `z.array` 自动 JSON.parse，联合类型到这就还是字符串 → 在这里归一（唯一一处）。
 */
function kvList(v: string | string[] | undefined): string[] {
    if (v === undefined) return [];
    if (Array.isArray(v)) return v;
    const raw = v.trim();
    if (raw.startsWith("[")) {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) {
            throw new Error(`应为字符串数组或单个 "k=v"，实得 ${JSON.stringify(v)}`);
        }
        return parsed as string[];
    }
    return [raw];
}

export function bindFlow(server: ServerBinding): void {
    server.use({
        prefix: "diy",
        api: flowApi,
        // 模块层由模块自己声明（flow）：与 defineService(name: "diy.flow") 等价
        handlers: {
            flow: {
                list: async ({ input }) => ({
                    workflows: flow.listFlowDefinitions(),
                    ...(input.instances ? { instances: flow.listFlowInstances() } : {}),
                }),
                show: async ({ input }) => flow.showFlow(input.uri),
                view: async ({ input }) => flow.viewArtifact(input.uri, input.node, input.seq),
                artifact: {
                    put: async ({ input }) => flow.putArtifact(input.uri, input.node, input.file, input.seq),
                },
                start: async ({ input }) => {
                    if (!input.workflow) {
                        throw new Error(
                            `缺 --workflow <id>（可用：${flow
                                .listFlowDefinitions()
                                .map((w) => w.id)
                                .join(" / ")}）`,
                        );
                    }
                    return flow.startFlow(input.uri, input.workflow, kvList(input.param));
                },
                advance: async ({ input }) => {
                    if (!input.to) throw new Error("缺 --to <节点 id>");
                    return flow.advanceFlow(input.uri, input.to, kvList(input.ref), input.note);
                },
                bounce: async ({ input }) => {
                    if (!input.to) throw new Error("缺 --to <节点 id>");
                    const author = input.author ?? "cli";
                    if (input.opinion !== undefined) requirePostText(input.opinion);
                    const view = flow.bounceFlow(input.uri, input.to, kvList(input.ref), input.note, author);
                    if (input.opinion !== undefined) {
                        try {
                            flow.appendBounceOpinion(input.uri, view, input.opinion, author);
                        } catch (e) {
                            throw new Error(
                                `打回已落盘（位置 ${view.position}），但意见没写进讨论流：${e instanceof Error ? e.message : String(e)}` +
                                    ` —— 可用 \`diy flow thread post\` 补发；删掉 ${view.files.threads} 不影响推进（讨论是旁注）`,
                            );
                        }
                    }
                    return view;
                },
                thread: {
                    list: async ({ input }) => flowThread.listThreads(input.uri, input.thread),
                    post: async ({ input }) =>
                        flowThread.postThread(
                            input.uri,
                            input.thread,
                            input.text,
                            input.type ?? "note",
                            input.author ?? "cli",
                        ),
                },
                finish: async ({ input }) => flow.finishFlow(input.uri, input.note),
                params: {
                    get: async ({ input }) => flow.paramsGet(input.uri),
                    set: async ({ input }) => flow.paramsSet(input.uri, kvList(input.param)),
                },
                prompt: async ({ input }) => flowPrompt(input.uri),
                step: async ({ input }) => {
                    const { status, to, kind, reason, view } = await flow.stepFlow(
                        input.uri,
                        input.cwd === undefined ? {} : { cwd: input.cwd },
                    );
                    return { status, to, kind, reason, view };
                },
                run: async function* ({ input, signal }) {
                    const { runFlow } = await import("../../flow-runner");
                    const queue = new AsyncQueue<unknown>();
                    void runFlow(input.uri, {
                        ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
                        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
                        signal,
                        onFrame: (frame) => queue.push(frame),
                    })
                        .catch((e: unknown) =>
                            queue.push({
                                kind: "stop",
                                reason: "turn-error",
                                message: e instanceof Error ? e.message : String(e),
                            }),
                        )
                        .finally(() => queue.close());
                    for await (const frame of queue) yield JSON.stringify(frame);
                },
            },
        },
    });
}
