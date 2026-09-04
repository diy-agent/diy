import { onMount, createEffect, For, Show } from "solid-js";
import { agentStore } from "../store/agentStore";
import { taskStore, type TreeNode } from "../store/taskStore";

/** 递归展平任务树，只保留有 uri 的 task 节点 */
function flattenTasks(nodes: TreeNode[]): TreeNode[] {
    const result: TreeNode[] = [];
    for (const n of nodes) {
        if (n.kind === "task" && n.uri) result.push(n);
        if (n.children?.length) result.push(...flattenTasks(n.children));
    }
    return result;
}

/**
 * Agent 对话面板。
 * embedded=true 时嵌入任务详情面板（任务已选中，不显示任务选择器）；
 * embedded=false 时独立使用（显示任务选择器）。
 */
export function AgentChatPanel(props: { embedded?: boolean } = {}) {
    let inputRef: HTMLTextAreaElement | undefined;
    let bottomRef: HTMLDivElement | undefined;
    onMount(() => { agentStore.loadModels(); agentStore.loadAutoApprove(); });

    // 切换任务时以主进程的真实会话状态为准刷新模型，避免界面显示伪造默认值
    createEffect(() => {
        const uri = taskStore.selectedUri;
        if (uri) void agentStore.syncStatus(uri);
        else agentStore.setModel("");
    });

    const handleSend = () => {
        if (!inputRef || agentStore.sending) return;
        const t = inputRef.value.trim();
        if (!t) return;
        const uri = taskStore.selectedUri;
        if (!uri) return;
        inputRef.value = "";
        agentStore.sendMessage(uri, t);
        setTimeout(() => bottomRef?.scrollIntoView({ behavior: "smooth" }), 50);
    };

    return (
        <div class="flex flex-col h-full">
            {/* 顶栏：模型选择 + 操作 */}
            <div class="flex items-center gap-2 px-3 py-2 border-b shrink-0 flex-wrap">
                {/* 独立模式才显示任务选择器；嵌入模式任务已由详情面板选中 */}
                <Show when={!props.embedded}>
                    <select
                        value={taskStore.selectedUri ?? ""}
                        onChange={(e) => taskStore.selectTask(e.currentTarget.value || null)}
                        class="select select-bordered select-sm max-w-48"
                    >
                        <option value="">— 选择任务 —</option>
                        <For each={flattenTasks(taskStore.nodes)}>
                            {(t) => <option value={t.uri}>{t.title ?? t.uri}</option>}
                        </For>
                    </select>
                </Show>
                <select
                    value={agentStore.activeModel ?? ""}
                    onChange={(e) => {
                        const id = e.currentTarget.value;
                        agentStore.setModel(id);
                        const uri = taskStore.selectedUri;
                        if (id && uri) agentStore.switchModel(uri, id);
                    }}
                    class="select select-bordered select-sm"
                >
                    <option value="">（未指定 · 用 agent 默认模型）</option>
                    <For each={agentStore.models}>
                        {(m) => <option value={m.id}>{m.name}</option>}
                    </For>
                </select>
                <button class="btn btn-ghost btn-sm" onClick={() => agentStore.clearChat()}>
                    清空
                </button>
                <label class="flex items-center gap-1 text-xs opacity-60 cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={agentStore.autoApprove}
                        onChange={(e) => agentStore.setAutoApprove(e.currentTarget.checked)}
                        class="checkbox checkbox-xs"
                    />
                    自动审批
                </label>
                <button
                    class="btn btn-ghost btn-sm text-error"
                    onClick={() => { const uri = taskStore.selectedUri; if (uri) agentStore.closeSession(uri); }}
                    disabled={!taskStore.selectedUri}
                >
                    关闭会话
                </button>
                <span class="ml-auto text-xs opacity-60">
                    {agentStore.sending ? "思考中…" : `${agentStore.messages.length} 条消息`}
                </span>
            </div>

            {/* 消息列表 - DaisyUI chat */}
            <div class="flex-1 overflow-auto p-4">
                <Show when={agentStore.messages.length === 0}>
                    <div class="flex items-center justify-center h-full opacity-60 text-sm">
                        在下方输入消息开始与 Agent 对话
                    </div>
                </Show>

                <div class="chat-container space-y-3">
                    <For each={agentStore.messages}>
                        {(msg) => (
                            <div class={`chat ${msg.role === "user" ? "chat-end" : "chat-start"}`}>
                                <div
                                    class={`chat-bubble ${
                                        msg.role === "user"
                                            ? "chat-bubble-primary"
                                            : "chat-bubble-secondary"
                                    }`}
                                >
                                    {msg.content}
                                </div>
                            </div>
                        )}
                    </For>
                </div>

                <Show when={!!agentStore.error}>
                    <div class="text-error text-xs mt-2">{agentStore.error}</div>
                </Show>
                <div ref={bottomRef} />
            </div>

            {/* 输入区 */}
            <div class="flex gap-2 border-t p-2 shrink-0">
                <textarea
                    ref={inputRef}
                    placeholder={agentStore.sending ? "等待回复…" : "输入消息…"}
                    disabled={agentStore.sending}
                    rows={2}
                    class="textarea textarea-bordered flex-1 text-xs"
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            handleSend();
                        }
                    }}
                />
                <button
                    class="btn btn-primary btn-sm self-end"
                    onClick={handleSend}
                    disabled={agentStore.sending}
                >
                    发送
                </button>
            </div>
        </div>
    );
}
