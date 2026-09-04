/**
 * ChatPage — 完整聊天页面
 *
 * 支持：
 * - Markdown 渲染（标题、列表、表格、代码块、链接、图片）
 * - 代码高亮（shiki，100+ 语言）
 * - 思考过程折叠展示
 * - 工具调用卡片（状态指示、输入/输出折叠）
 * - 终端输出展示
 * - 流式 token 增量
 * - 上下文压缩摘要
 * - token 用量统计
 */

import { createSignal, For, Show, createEffect, onMount, onCleanup, Suspense } from "solid-js";
import { chatStore, type ChatMessage, type ToolCall, type TerminalInfo } from "../store/chatStore";
import { taskStore } from "../store/taskStore";

// ─── Markdown 渲染（延迟加载） ───

let MarkdownComp: any = null;
const [markdownReady, setMarkdownReady] = createSignal(false);

onMount(async () => {
  try {
    const mod = await import("solid-markdown");
    MarkdownComp = mod.SolidMarkdown;
    setMarkdownReady(true);
  } catch (e) {
    console.warn("[ChatPage] solid-markdown 加载失败，回退纯文本", e);
  }
});

// ─── 代码高亮（延迟加载 shiki） ───

let highlighter: any = null;
const [highlighterReady, setHighlighterReady] = createSignal(false);

onMount(async () => {
  try {
    const { createHighlighter } = await import("shiki");
    highlighter = await createHighlighter({
      themes: ["github-dark"],
      langs: ["javascript", "typescript", "python", "rust", "go", "bash", "json", "yaml", "html", "css", "sql", "markdown", "toml", "shell", "tsx", "jsx"],
    });
    setHighlighterReady(true);
  } catch (e) {
    console.warn("[ChatPage] shiki 加载失败，代码块无高亮", e);
  }
});

/** 代码块渲染器（带语法高亮） */
function CodeBlock(props: { language?: string; code: string }) {
  const html = () => {
    if (!highlighterReady() || !highlighter) return null;
    try {
      const lang = props.language || "text";
      const loaded = highlighter.getLoadedLanguages();
      const useLang = loaded.includes(lang) ? lang : "text";
      return highlighter.codeToHtml(props.code, { lang: useLang, theme: "github-dark" });
    } catch {
      return null;
    }
  };

  return (
    <div class="relative group my-2">
      <div class="flex items-center justify-between bg-base-300 rounded-t-lg px-3 py-1 text-xs opacity-60">
        <span>{props.language ?? "text"}</span>
        <button
          class="btn btn-ghost btn-xs opacity-0 group-hover:opacity-100"
          onClick={() => navigator.clipboard?.writeText(props.code)}
        >
          复制
        </button>
      </div>
      <Show
        when={html()}
        fallback={
          <pre class="bg-base-300 rounded-b-lg p-3 overflow-x-auto text-sm">
            <code>{props.code}</code>
          </pre>
        }
      >
        <div
          class="bg-base-300 rounded-b-lg p-3 overflow-x-auto text-sm [&_pre]:m-0 [&_pre]:bg-transparent"
          innerHTML={html()!}
        />
      </Show>
    </div>
  );
}

// ─── Markdown 渲染组件 ───

function MarkdownContent(props: { content: string }) {
  return (
    <Show
      when={markdownReady() && MarkdownComp}
      fallback={<div class="whitespace-pre-wrap text-sm">{props.content}</div>}
    >
      {(() => {
        const Mc = MarkdownComp!;
        return (
          <div class="prose prose-sm max-w-none dark:prose-invert">
            <Mc
              children={props.content}
              components={{
                code(nodeProps: any) {
                  const { children, ...rest } = nodeProps;
                  const className = rest.class ?? rest.className ?? "";
                  const match = /language-(\w+)/.exec(className);
                  const code = String(children).replace(/\n$/, "");
                  if (match) {
                    return <CodeBlock language={match[1]} code={code} />;
                  }
                  if (code.includes("\n")) {
                    return <CodeBlock code={code} />;
                  }
                  return <code class="bg-base-300 px-1 rounded text-sm">{children}</code>;
                },
                a(nodeProps: any) {
                  return <a href={nodeProps.href} target="_blank" rel="noopener" class="link link-primary">{nodeProps.children}</a>;
                },
                img(nodeProps: any) {
                  return <img src={nodeProps.src} alt={nodeProps.alt ?? ""} class="max-w-full rounded-lg my-2" loading="lazy" />;
                },
                table(nodeProps: any) {
                  return <div class="overflow-x-auto my-2"><table class="table table-xs table-zebra">{nodeProps.children}</table></div>;
                },
                blockquote(nodeProps: any) {
                  return <blockquote class="border-l-4 border-primary pl-4 italic opacity-80 my-2">{nodeProps.children}</blockquote>;
                },
              }}
            />
          </div>
        );
      })()}
    </Show>
  );
}

// ─── 工具调用卡片 ───

function ToolCallCard(props: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = createSignal(false);
  const tc = () => props.toolCall;

  const statusIcon = () => {
    switch (tc().status) {
      case "pending": return "⏳";
      case "running": return "⚡";
      case "completed": return "✅";
      case "failed": return "❌";
      case "cancelled": return "🚫";
      default: return "❓";
    }
  };

  const statusColor = () => {
    switch (tc().status) {
      case "running": return "border-warning";
      case "completed": return "border-success";
      case "failed": return "border-error";
      case "cancelled": return "border-base-300";
      default: return "border-base-300";
    }
  };

  return (
    <div class={`border-l-4 ${statusColor()} bg-base-200 rounded-r-lg my-1`}>
      <button
        class="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-base-300 transition-colors"
        onClick={() => setExpanded(!expanded())}
      >
        <span>{statusIcon()}</span>
        <span class="font-mono font-semibold">{tc().name ?? "tool"}</span>
        <Show when={tc().title}>
          <span class="opacity-60 truncate">{tc().title}</span>
        </Show>
        <Show when={tc().status === "running"}>
          <span class="loading loading-spinner loading-xs ml-auto"></span>
        </Show>
        <span class="ml-auto text-xs opacity-40">{expanded() ? "▲" : "▼"}</span>
      </button>
      <Show when={expanded()}>
        <div class="px-3 pb-3 space-y-2">
          <Show when={tc().rawInput}>
            <div>
              <div class="text-xs font-semibold opacity-60 mb-1">输入</div>
              <CodeBlock language="json" code={JSON.stringify(tc().rawInput, null, 2)} />
            </div>
          </Show>
          <Show when={tc().contentBuf}>
            <div>
              <div class="text-xs font-semibold opacity-60 mb-1">输出</div>
              <div class="bg-base-300 rounded p-2 text-sm max-h-64 overflow-auto whitespace-pre-wrap">{tc().contentBuf}</div>
            </div>
          </Show>
          <Show when={tc().rawOutput}>
            <div>
              <div class="text-xs font-semibold opacity-60 mb-1">结果</div>
              <CodeBlock language="json" code={JSON.stringify(tc().rawOutput, null, 2)} />
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

// ─── 终端输出卡片 ───

function TerminalCard(props: { terminal: TerminalInfo }) {
  const [expanded, setExpanded] = createSignal(false);
  const t = () => props.terminal;

  return (
    <div class="border-l-4 border-info bg-base-200 rounded-r-lg my-1">
      <button
        class="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-base-300 transition-colors"
        onClick={() => setExpanded(!expanded())}
      >
        <span>🖥️</span>
        <span class="font-mono text-xs truncate">{t().command ?? "terminal"}</span>
        <Show when={t().cwd}>
          <span class="text-xs opacity-40 truncate">{t().cwd}</span>
        </Show>
        <Show when={t().exitStatus}>
          <span class={`text-xs ${t().exitStatus!.code === 0 ? "text-success" : "text-error"}`}>
            exit {t().exitStatus!.code}
          </span>
        </Show>
        <span class="ml-auto text-xs opacity-40">{expanded() ? "▲" : "▼"}</span>
      </button>
      <Show when={expanded()}>
        <div class="px-3 pb-3">
          <pre class="bg-base-300 rounded p-2 text-xs max-h-48 overflow-auto whitespace-pre-wrap font-mono">
            {t().outputBuf || "(无输出)"}
          </pre>
        </div>
      </Show>
    </div>
  );
}

// ─── 思考过程折叠 ───

function ThoughtBlock(props: { thought: string }) {
  const [expanded, setExpanded] = createSignal(false);

  return (
    <div class="border-l-4 border-accent bg-base-200/50 rounded-r-lg my-1">
      <button
        class="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-base-300/50 transition-colors"
        onClick={() => setExpanded(!expanded())}
      >
        <span>💭</span>
        <span class="opacity-60">思考过程</span>
        <span class="text-xs opacity-40">({props.thought.length} 字符)</span>
        <span class="ml-auto text-xs opacity-40">{expanded() ? "▲" : "▼"}</span>
      </button>
      <Show when={expanded()}>
        <div class="px-3 pb-3">
          <MarkdownContent content={props.thought} />
        </div>
      </Show>
    </div>
  );
}

// ─── 用量统计 ───

function UsageBadge(props: { usage: ChatMessage["usage"] }) {
  if (!props.usage) return null;
  const u = props.usage;
  return (
    <div class="flex gap-2 text-xs opacity-50 mt-1">
      <Show when={u.input !== undefined}>
        <span>输入: {u.input}</span>
      </Show>
      <Show when={u.output !== undefined}>
        <span>输出: {u.output}</span>
      </Show>
      <Show when={u.total !== undefined}>
        <span>总计: {u.total}</span>
      </Show>
    </div>
  );
}

// ─── 单条消息渲染 ───

function MessageBubble(props: { message: ChatMessage }) {
  const msg = () => props.message;
  const isUser = () => msg().type === "user";
  const isThought = () => msg().type === "thought";
  const isCompaction = () => msg().type === "compaction";

  // 压缩摘要：特殊样式
  if (isCompaction()) {
    return (
      <div class="flex justify-center my-2">
        <div class="badge badge-ghost gap-1 text-xs">
          <span>📦</span> 上下文已压缩 — {msg().content.slice(0, 80)}{msg().content.length > 80 ? "…" : ""}
        </div>
      </div>
    );
  }

  // 思考过程：独立折叠块
  if (isThought()) {
    return <ThoughtBlock thought={msg().thought ?? msg().content} />;
  }

  return (
    <div class={`chat ${isUser() ? "chat-end" : "chat-start"}`}>
      <div class="chat-header text-xs opacity-50">
        {isUser() ? "你" : "Agent"}
        <Show when={msg().streaming}>
          <span class="loading loading-dots loading-xs ml-1"></span>
        </Show>
      </div>
      <div class={`chat-bubble ${isUser() ? "chat-bubble-primary" : ""} max-w-[85%]`}>
        {/* 思考过程（如果有） */}
        <Show when={msg().thought}>
          <ThoughtBlock thought={msg().thought!} />
        </Show>

        {/* 文本内容 */}
        <Show when={msg().content}>
          <MarkdownContent content={msg().content} />
        </Show>

        {/* 工具调用 */}
        <Show when={msg().toolCalls && msg().toolCalls!.length > 0}>
          <div class="space-y-1 mt-2">
            <For each={msg().toolCalls!}>
              {(tc) => <ToolCallCard toolCall={tc} />}
            </For>
          </div>
        </Show>

        {/* 终端输出 */}
        <Show when={msg().terminals && msg().terminals!.length > 0}>
          <div class="space-y-1 mt-2">
            <For each={msg().terminals!}>
              {(term) => <TerminalCard terminal={term} />}
            </For>
          </div>
        </Show>

        {/* 用量统计 */}
        <UsageBadge usage={msg().usage} />
      </div>
    </div>
  );
}

// ─── 输入区域 ───

function InputArea(props: { taskUri: string | null }) {
  let inputRef: HTMLTextAreaElement | undefined;
  let bottomRef: HTMLDivElement | undefined;

  const handleSend = () => {
    if (!inputRef || chatStore.sending) return;
    const text = inputRef.value.trim();
    if (!text) return;
    const uri = props.taskUri;
    if (!uri) return;
    inputRef.value = "";
    chatStore.sendMessage(uri, text);
    setTimeout(() => bottomRef?.scrollIntoView({ behavior: "smooth" }), 100);
  };

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div class="border-t bg-base-100 p-3 shrink-0">
      <Show when={!props.taskUri}>
        <div class="text-center text-sm opacity-50 py-2">请先选择一个任务</div>
      </Show>
      <Show when={props.taskUri}>
        <div class="flex gap-2">
          <textarea
            ref={inputRef}
            class="textarea textarea-bordered flex-1 resize-none"
            rows={2}
            placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
            onKeyDown={handleKey}
            disabled={chatStore.sending}
          />
          <button
            class="btn btn-primary self-end"
            onClick={handleSend}
            disabled={chatStore.sending}
          >
            <Show when={chatStore.sending} fallback="发送">
              <span class="loading loading-spinner loading-sm"></span>
            </Show>
          </button>
        </div>
      </Show>
      <div ref={bottomRef} />
    </div>
  );
}

// ─── 主页面 ───

export function ChatPage() {
  const [taskUri, setTaskUri] = createSignal<string | null>(null);
  let chatContainerRef: HTMLDivElement | undefined;

  // 自动滚动到底部
  createEffect(() => {
    // 访问响应式依赖
    const _ = chatStore.messages.length;
    const last = chatStore.messages[chatStore.messages.length - 1];
    const _2 = last?.content;
    setTimeout(() => {
      chatContainerRef?.scrollTo({ top: chatContainerRef.scrollHeight, behavior: "smooth" });
    }, 50);
  });

  return (
    <div class="flex flex-col h-full">
      {/* 顶栏 */}
      <div class="flex items-center gap-3 px-4 py-2 border-b shrink-0">
        <span class="text-sm font-bold">💬 Agent 聊天</span>
        <select
          value={taskUri() ?? ""}
          onChange={(e) => setTaskUri(e.currentTarget.value || null)}
          class="select select-bordered select-sm max-w-48"
        >
          <option value="">— 选择任务 —</option>
          <For each={flattenTasks(taskStore.nodes)}>
            {(t) => <option value={t.uri}>{t.title ?? t.uri}</option>}
          </For>
        </select>
        <select
          value={chatStore.activeModel ?? ""}
          onChange={(e) => chatStore.setModel(e.currentTarget.value)}
          class="select select-bordered select-sm"
        >
          <option value="">（默认模型）</option>
        </select>
        <button class="btn btn-ghost btn-sm" onClick={() => chatStore.clearChat()}>
          清空
        </button>
        <Show when={chatStore.error}>
          <span class="text-error text-xs">{chatStore.error}</span>
          <button class="btn btn-ghost btn-xs" onClick={() => chatStore.clearError()}>✕</button>
        </Show>
      </div>

      {/* 消息列表 */}
      <div ref={chatContainerRef} class="flex-1 overflow-y-auto p-4 space-y-3">
        <Show when={chatStore.messages.length === 0}>
          <div class="flex items-center justify-center h-full opacity-30">
            <div class="text-center">
              <div class="text-4xl mb-2">💬</div>
              <div>选择任务并输入消息开始对话</div>
            </div>
          </div>
        </Show>
        <For each={chatStore.messages}>
          {(msg) => <MessageBubble message={msg} />}
        </For>
      </div>

      {/* 输入区 */}
      <InputArea taskUri={taskUri()} />
    </div>
  );
}

// ─── 工具函数 ───

import type { TreeNode } from "../store/taskStore";

function flattenTasks(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  for (const n of nodes) {
    if (n.kind === "task" && n.uri) result.push(n);
    if (n.children?.length) result.push(...flattenTasks(n.children));
  }
  return result;
}
