/**
 * ChatPage — 完整聊天页面（对标 DeepSeek Harness Web UI）
 *
 * 布局设计（参考 DeepSeek Harness MessageItem.module.css + AssistantMarkdown.module.css）：
 * - 用户消息：右对齐气泡（max-width: 70%，圆角 22px）
 * - Agent 消息：全宽无气泡（display: flex; flex-direction: column），文本自然流
 * - 工具调用：全宽卡片（左侧色条状态指示）
 * - 思考过程：全宽可折叠行
 * - 代码高亮：shiki（延迟加载）
 * - Markdown：solid-markdown + remark-gfm
 */

import { createSignal, For, Show, createEffect, onMount } from "solid-js";
import { chatStore, type ChatMessage, type ToolCall, type TerminalInfo } from "../store/chatStore";
import { agentStore } from "../store/agentStore";
import { taskStore } from "../store/taskStore";
import { diyService } from "../lib/rpc";

/** 配置选项类型 */
interface ConfigOption {
  id: string;
  name: string;
  category?: string;
  currentValue?: string;
  options?: Array<{ value: string; name: string }>;
}

// ─── Markdown 渲染（延迟加载） ───

let MarkdownComp: any = null;
const [markdownReady, setMarkdownReady] = createSignal(false);

onMount(async () => {
  try {
    const mod = await import("solid-markdown");
    MarkdownComp = mod.SolidMarkdown;
    setMarkdownReady(true);
  } catch (e) {
    console.warn("[ChatPage] solid-markdown 加载失败", e);
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
    console.warn("[ChatPage] shiki 加载失败", e);
  }
});

/** 代码块渲染器（带语法高亮 + 语言标签 + 复制按钮） */
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
    <div class="relative group my-3 rounded-lg overflow-hidden border border-base-300">
      <div class="flex items-center justify-between bg-base-300/50 px-4 py-1.5 text-xs opacity-60">
        <span>{props.language ?? "text"}</span>
        <button
          class="btn btn-ghost btn-xs opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={() => navigator.clipboard?.writeText(props.code)}
        >
          复制
        </button>
      </div>
      <Show
        when={html()}
        fallback={
          <pre class="p-4 overflow-x-auto text-sm leading-relaxed">
            <code>{props.code}</code>
          </pre>
        }
      >
        <div
          class="p-4 overflow-x-auto text-sm leading-relaxed [&_pre]:m-0 [&_pre]:bg-transparent [&_pre]:p-0"
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
      fallback={<div class="whitespace-pre-wrap text-sm leading-relaxed">{props.content}</div>}
    >
      {(() => {
        const Mc = MarkdownComp!;
        return (
          <div class="prose prose-sm max-w-none dark:prose-invert leading-relaxed">
            <Mc
              children={props.content}
              components={{
                code(nodeProps: any) {
                  const { children, ...rest } = nodeProps;
                  const className = rest.class ?? rest.className ?? "";
                  const match = /language-(\w+)/.exec(className);
                  const code = String(children).replace(/\n$/, "");
                  if (match) return <CodeBlock language={match[1]} code={code} />;
                  if (code.includes("\n")) return <CodeBlock code={code} />;
                  return <code class="bg-base-300/60 px-1.5 py-0.5 rounded text-sm">{children}</code>;
                },
                a(nodeProps: any) {
                  return <a href={nodeProps.href} target="_blank" rel="noopener" class="link link-primary">{nodeProps.children}</a>;
                },
                img(nodeProps: any) {
                  return <img src={nodeProps.src} alt={nodeProps.alt ?? ""} class="max-w-full rounded-lg my-2" loading="lazy" />;
                },
                table(nodeProps: any) {
                  return <div class="overflow-x-auto my-3"><table class="table table-xs table-zebra">{nodeProps.children}</table></div>;
                },
                blockquote(nodeProps: any) {
                  return <blockquote class="border-l-4 border-primary pl-4 italic opacity-80 my-3">{nodeProps.children}</blockquote>;
                },
                hr() {
                  return <hr class="my-4 border-base-300" />;
                },
              }}
            />
          </div>
        );
      })()}
    </Show>
  );
}

// ─── 工具调用卡片（全宽，左侧色条） ───

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

  const borderColor = () => {
    switch (tc().status) {
      case "running": return "border-l-warning";
      case "completed": return "border-l-success";
      case "failed": return "border-l-error";
      default: return "border-l-base-content/20";
    }
  };

  return (
    <div class={`border-l-4 ${borderColor()} bg-base-200/50 rounded-r-lg`}>
      <button
        class="flex items-center gap-2 w-full px-4 py-2.5 text-sm hover:bg-base-300/50 transition-colors"
        onClick={() => setExpanded(!expanded())}
      >
        <span class="text-base">{statusIcon()}</span>
        <span class="font-mono font-medium">{tc().name ?? "tool"}</span>
        <Show when={tc().title}>
          <span class="opacity-50 truncate text-xs">{tc().title}</span>
        </Show>
        <Show when={tc().status === "running"}>
          <span class="loading loading-spinner loading-xs ml-auto"></span>
        </Show>
        <span class="ml-auto text-xs opacity-30">{expanded() ? "▲" : "▼"}</span>
      </button>
      <Show when={expanded()}>
        <div class="px-4 pb-3 space-y-2 border-t border-base-300/50 pt-2">
          <Show when={tc().rawInput}>
            <div>
              <div class="text-xs font-semibold opacity-50 mb-1">输入</div>
              <CodeBlock language="json" code={JSON.stringify(tc().rawInput, null, 2)} />
            </div>
          </Show>
          <Show when={tc().contentBuf}>
            <div>
              <div class="text-xs font-semibold opacity-50 mb-1">输出</div>
              <pre class="bg-base-300 rounded p-3 text-xs max-h-48 overflow-auto whitespace-pre-wrap font-mono">{tc().contentBuf}</pre>
            </div>
          </Show>
          <Show when={tc().rawOutput}>
            <div>
              <div class="text-xs font-semibold opacity-50 mb-1">结果</div>
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
    <div class="border-l-4 border-l-info bg-base-200/50 rounded-r-lg">
      <button
        class="flex items-center gap-2 w-full px-4 py-2.5 text-sm hover:bg-base-300/50 transition-colors"
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
        <span class="ml-auto text-xs opacity-30">{expanded() ? "▲" : "▼"}</span>
      </button>
      <Show when={expanded()}>
        <div class="px-4 pb-3 border-t border-base-300/50 pt-2">
          <pre class="bg-base-300 rounded p-3 text-xs max-h-48 overflow-auto whitespace-pre-wrap font-mono">
            {t().outputBuf || "(无输出)"}
          </pre>
        </div>
      </Show>
    </div>
  );
}

// ─── 思考过程折叠（全宽行） ───

function ThoughtBlock(props: { thought: string; streaming?: boolean }) {
  const [expanded, setExpanded] = createSignal(false);

  return (
    <div class="border-l-4 border-l-accent/40 bg-base-200/30 rounded-r-lg">
      <button
        class="flex items-center gap-2 w-full px-4 py-2 text-sm hover:bg-base-300/30 transition-colors"
        onClick={() => setExpanded(!expanded())}
      >
        <span>💭</span>
        <span class="opacity-50 text-xs">思考过程</span>
        <Show when={props.streaming}>
          <span class="loading loading-dots loading-xs"></span>
        </Show>
        <span class="ml-auto text-xs opacity-30">{expanded() ? "▲" : "▼"}</span>
      </button>
      <Show when={expanded()}>
        <div class="px-4 pb-3 border-t border-base-300/30 pt-2">
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
    <div class="flex gap-3 text-xs opacity-40 mt-3 pt-2 border-t border-base-300/30">
      <Show when={u.input !== undefined}>
        <span>↑ {u.input} tokens</span>
      </Show>
      <Show when={u.output !== undefined}>
        <span>↓ {u.output} tokens</span>
      </Show>
      <Show when={u.total !== undefined}>
        <span>Σ {u.total} tokens</span>
      </Show>
    </div>
  );
}

// ─── 用户消息（右对齐气泡） ───

function UserMessageView(props: { message: ChatMessage }) {
  return (
    <div class="flex flex-col items-end gap-1">
      <div class="text-xs opacity-40">你</div>
      <div class="max-w-[70%] bg-primary/10 rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
        {props.message.content}
      </div>
    </div>
  );
}

// ─── Agent 消息（全宽无气泡） ───

function AssistantMessageView(props: { message: ChatMessage }) {
  const msg = () => props.message;

  return (
    <div class="flex flex-col gap-2 w-full">
      {/* 头部 */}
      <div class="flex items-center gap-2 text-xs opacity-40">
        <span>Agent</span>
        <Show when={msg().streaming}>
          <span class="loading loading-dots loading-xs"></span>
        </Show>
      </div>

      {/* 思考过程 */}
      <Show when={msg().thought}>
        <ThoughtBlock thought={msg().thought!} streaming={msg().streaming} />
      </Show>

      {/* 文本内容（全宽） */}
      <Show when={msg().content}>
        <MarkdownContent content={msg().content} />
      </Show>

      {/* 工具调用 */}
      <Show when={msg().toolCalls && msg().toolCalls!.length > 0}>
        <div class="space-y-2">
          <For each={msg().toolCalls!}>
            {(tc) => <ToolCallCard toolCall={tc} />}
          </For>
        </div>
      </Show>

      {/* 终端输出 */}
      <Show when={msg().terminals && msg().terminals!.length > 0}>
        <div class="space-y-2">
          <For each={msg().terminals!}>
            {(term) => <TerminalCard terminal={term} />}
          </For>
        </div>
      </Show>

      {/* 用量统计 */}
      <UsageBadge usage={msg().usage} />
    </div>
  );
}

// ─── 消息分派 ───

function MessageView(props: { message: ChatMessage }) {
  const msg = () => props.message;

  // 压缩摘要：居中徽章
  if (msg().type === "compaction") {
    return (
      <div class="flex justify-center my-2">
        <div class="badge badge-ghost gap-1 text-xs opacity-60">
          <span>📦</span> 上下文已压缩 — {msg().content.slice(0, 80)}{msg().content.length > 80 ? "…" : ""}
        </div>
      </div>
    );
  }

  // 思考过程（独立的 thought 消息）
  if (msg().type === "thought") {
    return <ThoughtBlock thought={msg().thought ?? msg().content} streaming={msg().streaming} />;
  }

  // 用户消息：右对齐气泡
  if (msg().type === "user") {
    return <UserMessageView message={msg()} />;
  }

  // Agent 消息（assistant/tool-call/terminal）：全宽无气泡
  return <AssistantMessageView message={msg()} />;
}

// ─── 输入区域 ───

function InputArea(props: { taskUri: string | null }) {
  let inputRef: HTMLTextAreaElement | undefined;
  let bottomRef: HTMLDivElement | undefined;

  const handleSend = () => {
    if (!inputRef) return;
    const text = inputRef.value.trim();
    if (!text) return;
    const uri = props.taskUri;
    if (!uri) return;
    inputRef.value = "";
    // sendMessage 内部处理：生成中入队（steer），空闲直接执行
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
    <div class="border-t border-base-300 bg-base-100 p-4 shrink-0">
      <Show when={!props.taskUri}>
        <div class="text-center text-sm opacity-40 py-3">请先选择一个任务开始对话</div>
      </Show>
      <Show when={props.taskUri}>
        <div class="flex gap-3 max-w-3xl mx-auto">
          <textarea
            ref={inputRef}
            class="textarea textarea-bordered flex-1 resize-none text-sm"
            rows={2}
            placeholder={
              chatStore.sending
                ? "生成中…（可发送下一条排队，或点停止）"
                : "输入消息…（Enter 发送，Shift+Enter 换行）"
            }
            onKeyDown={handleKey}
          />
          <Show
            when={chatStore.sending}
            fallback={
              <button class="btn btn-primary self-end" onClick={handleSend} disabled={chatStore.sending}>
                发送
              </button>
            }
          >
            {/* 生成中：停止当前 + 排队计数 */}
            <div class="flex flex-col gap-1 self-end items-center">
              <button
                class="btn btn-error btn-sm"
                onClick={() => {
                  if (chatStore.pendingCount > 0) chatStore.cancelAll();
                  else chatStore.cancel();
                }}
                title="停止生成（有排队时连排队一起取消）"
              >
                ■ 停止{chatStore.pendingCount > 0 ? ` + 取消${chatStore.pendingCount}排队` : ""}
              </button>
              <span class="text-[10px] opacity-50">生成中…</span>
            </div>
          </Show>
        </div>
      </Show>
      <div ref={bottomRef} />
    </div>
  );
}

// ─── 主页面 ───

export function ChatPage(props: { embedded?: boolean } = {}) {
  // 嵌入模式（TaskDetailPanel）：任务由选中态驱动；独立模式：本地下拉选择
  const [localUri, setLocalUri] = createSignal<string | null>(null);
  const taskUri = () =>
    props.embedded ? (taskStore.selectedUri ?? null) : localUri();
  const [configOptions, setConfigOptions] = createSignal<ConfigOption[]>([]);
  let chatContainerRef: HTMLDivElement | undefined;
  /** 请求序号，防止并发 load 覆盖 */
  let configLoadSeq = 0;

  /** 加载配置选项（带请求序号防竞态） */
  const loadConfigOptions = async (uri: string) => {
    const seq = ++configLoadSeq;
    try {
      const opts = await diyService.diy.agent.getConfigOptions({ taskUri: uri });
      if (seq === configLoadSeq) setConfigOptions(opts);
    } catch {
      if (seq === configLoadSeq) setConfigOptions([]);
    }
  };

  /** 设置配置选项（乐观更新，失败回滚） */
  const setConfig = async (configId: string, value: string) => {
    const uri = taskUri();
    if (!uri) return;
    // 记住旧值用于回滚
    const oldValue = getConfig(configId)?.currentValue;
    // 乐观更新：立即改本地 signal
    setConfigOptions((prev) =>
      prev.map((o) => (o.id === configId ? { ...o, currentValue: value } : o)),
    );
    try {
      await diyService.diy.agent.setConfigOption({ taskUri: uri, configId, value });
      // opencode 不推 config_option_update，setConfigOption 响应也不含更新后值，
      // 所以不做「服务端确认」——乐观值即终态。
    } catch (e) {
      console.warn(`[ChatPage] 设置 ${configId} 失败:`, e);
      // 回滚到旧值
      if (oldValue !== undefined) {
        setConfigOptions((prev) =>
          prev.map((o) => (o.id === configId ? { ...o, currentValue: oldValue } : o)),
        );
      }
    }
  };

  /** 获取指定配置项的当前值 */
  const getConfig = (id: string) => configOptions().find((o) => o.id === id);

  // session 创建后刷新配置选项
  onMount(() => {
    chatStore.onSessionCreated(() => {
      const uri = taskUri();
      if (uri) loadConfigOptions(uri);
    });
    // 加载模型列表 + 同步当前会话真实模型
    agentStore.loadModels().catch(() => {});
    const uri = taskUri();
    if (uri) chatStore.syncStatus(uri);
    void agentStore.loadAutoApprove();
  });

  // 选中任务时加载配置选项 + 同步会话状态（嵌入模式切换任务也走这里）
  createEffect(() => {
    const uri = taskUri();
    if (uri) {
      loadConfigOptions(uri);
      chatStore.syncStatus(uri);
    } else {
      setConfigOptions([]);
    }
  });

  // 自动滚动到底部（流式更新时持续触发）
  createEffect(() => {
    // 访问响应式依赖触发重跑
    const msgs = chatStore.messages;
    const last = msgs[msgs.length - 1];
    const _ = last?.content;
    const _2 = last?.thought;
    const _3 = last?.toolCalls?.length;
    // 用 requestAnimationFrame 确保 DOM 已更新
    requestAnimationFrame(() => {
      chatContainerRef?.scrollTo({ top: chatContainerRef.scrollHeight });
    });
  });

  return (
    <div class="flex flex-col h-full bg-base-100">
      {/* 顶栏 */}
      <div class="flex items-center gap-3 px-6 py-3 border-b border-base-300 shrink-0 flex-wrap">
        <span class="text-sm font-semibold">💬 Agent 聊天</span>
        {/* 任务选择（嵌入模式由详情面板选中，隐藏选择器） */}
        <Show when={!props.embedded}>
          <select
            value={localUri() ?? ""}
            onChange={(e) => setLocalUri(e.currentTarget.value || null)}
            class="select select-bordered select-sm max-w-48"
          >
            <option value="">— 选择任务 —</option>
            <For each={flattenTasks(taskStore.nodes)}>
              {(t) => <option value={t.uri}>{t.title ?? t.uri}</option>}
            </For>
          </select>
        </Show>
        {/* 模型选择（单一真相源：chatStore.activeModel，sendMessage 读的就是它） */}
        <select
          value={chatStore.activeModel ?? ""}
          onChange={(e) => chatStore.switchModel(taskUri() ?? "", e.currentTarget.value)}
          class="select select-bordered select-sm max-w-64"
        >
          <option value="">（默认模型）</option>
          <For each={agentStore.models}>
            {(m) => <option value={m.id}>{m.name}</option>}
          </For>
        </select>
        <button
          class="btn btn-ghost btn-sm"
          title="刷新模型列表"
          onClick={() => agentStore.loadModels(true)}
        >
          ⟳
        </button>
        {/* 思考深度 (effort) */}
        <Show when={getConfig("effort")}>
          <div class="flex items-center gap-1">
            <span class="text-xs opacity-50">🧠</span>
            <select
              value={getConfig("effort")!.currentValue ?? "default"}
              onChange={(e) => setConfig("effort", e.currentTarget.value)}
              class="select select-bordered select-xs"
            >
              <For each={getConfig("effort")!.options ?? []}>
                {(o) => <option value={o.value}>{o.name}</option>}
              </For>
            </select>
          </div>
        </Show>
        {/* 会话模式 (mode) */}
        <Show when={getConfig("mode")}>
          <div class="flex items-center gap-1">
            <span class="text-xs opacity-50">⚙️</span>
            <select
              value={getConfig("mode")!.currentValue ?? "build"}
              onChange={(e) => setConfig("mode", e.currentTarget.value)}
              class="select select-bordered select-xs"
            >
              <For each={getConfig("mode")!.options ?? []}>
                {(o) => <option value={o.value}>{o.name}</option>}
              </For>
            </select>
          </div>
        </Show>
        <button class="btn btn-ghost btn-sm" onClick={() => chatStore.clearChat()}>
          清空
        </button>
        <Show when={chatStore.error}>
          <span class="text-error text-xs ml-auto">{chatStore.error}</span>
          <button class="btn btn-ghost btn-xs" onClick={() => chatStore.clearError()}>✕</button>
        </Show>
      </div>

      {/* 消息列表 */}
      <div ref={chatContainerRef} class="flex-1 overflow-y-auto">
        <Show when={chatStore.messages.length === 0}>
          <div class="flex items-center justify-center h-full opacity-20">
            <div class="text-center">
              <div class="text-5xl mb-3">💬</div>
              <div class="text-sm">选择任务并输入消息开始对话</div>
            </div>
          </div>
        </Show>
        <div class="max-w-3xl mx-auto px-6 py-4 space-y-4">
          <For each={chatStore.messages}>
            {(msg) => (
              <div class={msg.type === "user" ? "" : "w-full"}>
                <MessageView message={msg} />
              </div>
            )}
          </For>
        </div>
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
