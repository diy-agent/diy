// src/renderer/components-diy/AgentChatPanel.tsx
import { useEffect, useRef } from "react";
import { useAgentStore } from "./store/agentStore";
import { useTaskStore } from "./store/taskStore";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function AgentChatPanel() {
  const {
    models,
    activeModel,
    messages,
    sending,
    error,
    autoApprove,
    loadModels,
    syncStatus,
    setModel,
    sendMessage,
    clearChat,
    loadAutoApprove,
    setAutoApprove,
    closeSession,
    switchModel,
  } = useAgentStore();
  const selectedUri = useTaskStore((s) => s.selectedUri);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadModels();
    loadAutoApprove();
  }, [loadModels, loadAutoApprove]);
  // 切换任务时以主进程的真实会话状态为准刷新模型，避免界面显示伪造默认值
  useEffect(() => {
    if (selectedUri) void syncStatus(selectedUri);
    else useAgentStore.setState({ activeModel: null });
  }, [selectedUri, syncStatus]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = () => {
    const el = inputRef.current;
    if (!el || sending) return;
    const text = el.value.trim();
    if (!text) return;
    el.value = "";
    if (!selectedUri) return; // 未选中任务时不发送（task 级对话）
    sendMessage(selectedUri, text);
  };

  return (
    <div className="flex flex-col h-full">
      {/* 顶部：模型选择 + 操作 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
        <select
          value={activeModel ?? ""}
          onChange={(e) => {
            const id = e.target.value;
            setModel(id);
            // 空值 = 不指定，交给 agent 自己的默认模型；此时不发 set_model
            if (id && selectedUri) switchModel(selectedUri, id);
          }}
          className="h-8 rounded-md border bg-background px-2 text-xs"
        >
          {/* 占位项：没有真实会话时不能预选任何模型，否则视觉上就是「伪造当前值」 */}
          <option value="">（未指定 · 用 agent 默认模型）</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <Button variant="ghost" size="sm" className="text-xs" onClick={clearChat}>
          清空
        </Button>
        <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoApprove}
            onChange={(e) => setAutoApprove(e.target.checked)}
            className="h-3 w-3"
          />
          自动审批
        </label>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-destructive"
          onClick={() => selectedUri && closeSession(selectedUri)}
          disabled={!selectedUri}
        >
          关闭会话
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {sending ? "思考中…" : `${messages.length} 条消息`}
        </span>
      </div>

      {/* 聊天区 */}
      <ScrollArea className="flex-1 px-3 py-2">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            在下方输入消息开始与 Agent 对话
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={cn(
              "mb-3 max-w-[80%] rounded-lg px-3 py-2 text-sm leading-relaxed",
              msg.role === "user"
                ? "ml-auto bg-primary text-primary-foreground"
                : "mr-auto bg-muted",
            )}
          >
            {msg.content}
          </div>
        ))}
        {error && <div className="mb-3 text-destructive text-xs">{error}</div>}
        <div ref={bottomRef} />
      </ScrollArea>

      {/* 输入区 */}
      <div className="flex gap-2 border-t p-2 shrink-0">
        <textarea
          ref={inputRef}
          placeholder={sending ? "等待回复…" : "输入消息…"}
          disabled={sending}
          rows={2}
          className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <Button size="sm" onClick={handleSend} disabled={sending}>
          发送
        </Button>
      </div>
    </div>
  );
}
