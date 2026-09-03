// @ts-nocheck
import { onMount, For, Show } from "solid-js";
import { agentStore } from "../store/agentStore";

export function AgentChatPanel() {
    let inputRef: HTMLTextAreaElement | undefined;
    let bottomRef: HTMLDivElement | undefined;
    onMount(() => agentStore.loadModels());

    const handleSend = () => {
        if (!inputRef || agentStore.sending) return;
        const t = inputRef.value.trim();
        if (!t) return;
        inputRef.value = "";
        agentStore.sendMessage(t);
        setTimeout(() => bottomRef?.scrollIntoView({ behavior: "smooth" }), 50);
    };

    return (
        <div class="flex flex-col h-full">
            {/* 顶栏 */}
            <div class="flex items-center gap-2 px-3 py-2 border-b shrink-0">
                <select
                    value={agentStore.activeModel ?? ""}
                    onChange={(e) => agentStore.setModel(e.currentTarget.value)}
                    class="select select-bordered select-sm"
                >
                    <For each={agentStore.models}>
                        {(m) => <option value={m.id}>{m.name}</option>}
                    </For>
                </select>
                <button class="btn btn-ghost btn-sm" onClick={() => agentStore.clearChat()}>
                    清空
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
