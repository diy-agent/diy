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
import { chatStore, sendingAccessor, type ChatMessage, type ToolCall, type TerminalInfo, type ConfigOptionSnapshot } from "../store/chatStore";
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
      {/* 会话上下文窗口占用（usage_update 推送的 used/size/cost） */}
      <Show when={u.used !== undefined && u.size !== undefined}>
        <span
          title={
            u.cost?.amount !== undefined
              ? `成本 ${u.cost.amount} ${u.cost.currency ?? ""}`.trim()
              : undefined
          }
        >
          🧠 {u.used}/{u.size} ctx
        </span>
      </Show>
    </div>
  );
}

// ─── 用户消息（右对齐气泡，带排队状态） ───

function UserMessageView(props: { message: ChatMessage }) {
  const msg = () => props.message;

  // 排队/取消的可见状态（DeepSeek Web 式）：排队中显示徽标 + 可单独撤回
  return (
    <div class="flex flex-col items-end gap-1">
      <div class="text-xs opacity-40">你</div>
      <div
        class={`max-w-[70%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
          msg().queueStatus === "queued"
            ? "bg-base-300 opacity-60"
            : msg().queueStatus === "cancelled"
              ? "bg-base-300 opacity-50 line-through decoration-1"
              : "bg-primary/10"
        }`}
      >
        {props.message.content}
      </div>
      <Show when={msg().queueStatus === "queued"}>
        <div class="flex items-center gap-2 text-xs opacity-60">
          <span class="loading loading-spinner loading-xs"></span>
          <span>排队中…</span>
          <button
            class="btn btn-ghost btn-xs text-error"
            onClick={() => chatStore.cancelMessage(msg().id)}
            title="撤回这条排队消息"
          >
            ✕ 撤回
          </button>
        </div>
      </Show>
      <Show when={msg().queueStatus === "cancelled"}>
        <div class="text-xs text-error/70">已撤回 / 已停止</div>
      </Show>
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
        <div class="text-center text-sm opacity-40 py-3">请先在任务树中选择一个任务开始对话</div>
      </Show>
      <Show when={props.taskUri}>
        <div class="flex gap-3 max-w-3xl mx-auto">
          <textarea
            ref={inputRef}
            class="textarea textarea-bordered flex-1 resize-none text-sm"
            rows={2}
            placeholder={
              sendingAccessor()
                ? "工作中…继续输入将排队（消息会立即上屏）"
                : "输入消息…（Enter 发送，Shift+Enter 换行）"
            }
            onKeyDown={handleKey}
          />
          {/* 发送/停止 合并为一个状态按钮：idle → 发送，running → 停止 */}
          <button
            class={`btn self-end ${sendingAccessor() ? "btn-error" : "btn-primary"}`}
            onClick={sendingAccessor()
              ? () => chatStore.cancel()
              : handleSend}
          >
            {sendingAccessor()
              ? `■ 停止${chatStore.pendingCount > 0 ? `（${chatStore.pendingCount}）` : ""}`
              : "发送"}
          </button>
        </div>
      </Show>
      <div ref={bottomRef} />
    </div>
  );
}

// ─── 主页面 ───

export function ChatPage() {
  // 会话面向任务：任务由选中态驱动，进入任务详情即建会话开聊（无独立选任务逻辑）
  const taskUri = () => taskStore.selectedUri ?? null;
  const [configOptions, setConfigOptions] = createSignal<ConfigOption[]>([]);
  /** 会话初始化中（ensureSession 进行时锁定配置区，输入框不锁、消息照发） */
  const [initializing, setInitializing] = createSignal(false);
  let chatContainerRef: HTMLDivElement | undefined;
  /** 请求序号，防止并发 load 覆盖 */
  let configLoadSeq = 0;

  /** 配置快照归一化（RPC 已归一化；事件推送的裸数据补 name 回退） */
  const normalizeOptions = (opts: ConfigOptionSnapshot[]): ConfigOption[] =>
    opts.map((o) => ({
      id: o.id,
      name: o.name ?? o.id,
      category: o.category,
      currentValue: o.currentValue,
      options: o.options?.map((p) => ({ value: p.value, name: p.name ?? p.value })),
    }));

  /** 加载配置选项（带请求序号防竞态；纯 main 内存读） */
  const loadConfigOptions = async (uri: string) => {
    const seq = ++configLoadSeq;
    try {
      const opts = await diyService.diy.agent.getConfigOptions({ taskUri: uri });
      if (seq === configLoadSeq) setConfigOptions(normalizeOptions(opts));
    } catch {
      if (seq === configLoadSeq) setConfigOptions([]);
    }
  };

  /**
   * 进入任务详情：确保会话存在（无则新建/恢复），一次性装配
   * 模型（默认选中快照默认模型）+ effort/mode，下拉立即可见。
   */
  const ensureSessionAndLoad = async (uri: string) => {
    const seq = ++configLoadSeq;
    setInitializing(true);
    try {
      const r = await diyService.diy.agent.ensureSession({ taskUri: uri });
      if (seq !== configLoadSeq) return;
      setConfigOptions(normalizeOptions(r.configOptions));
      chatStore.setModel(r.model ?? "");
      await agentStore.loadModels(uri);
    } catch (e) {
      console.warn("[ChatPage] 会话初始化失败:", e);
      if (seq === configLoadSeq) setConfigOptions([]);
    } finally {
      if (seq === configLoadSeq) setInitializing(false);
    }
  };

  // ─── debounce：防止快速连续切换同一配置项时发送多次 RPC ───
  const configTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** 设置配置选项（乐观更新 + 300ms debounce，失败回滚） */
  const setConfig = (configId: string, value: string) => {
    const uri = taskUri();
    if (!uri) return;
    // 记住旧值用于回滚（首次切换时快照）
    if (!configTimers.has(configId)) {
      (setConfig as any)[`_old_${configId}`] = getConfig(configId)?.currentValue;
    }
    const oldValue = (setConfig as any)[`_old_${configId}`];
    // 乐观更新：立即改本地 signal
    setConfigOptions((prev) =>
      prev.map((o) => (o.id === configId ? { ...o, currentValue: value } : o)),
    );
    // debounce：清除前一个定时器，300ms 后发送 RPC
    const prev = configTimers.get(configId);
    if (prev) clearTimeout(prev);
    configTimers.set(configId, setTimeout(async () => {
      configTimers.delete(configId);
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
      } finally {
        delete (setConfig as any)[`_old_${configId}`];
      }
    }, 300));
  };

  /** 获取指定配置项的当前值 */
  const getConfig = (id: string) => configOptions().find((o) => o.id === id);

  /** 切换模型：chatStore 乐观更新 + 协议切换，成功后重读一次配置（本地读，对齐可能推送） */
  const handleModelChange = async (modelId: string) => {
    const uri = taskUri();
    await chatStore.switchModel(uri ?? "", modelId);
    if (uri) void loadConfigOptions(uri);
  };

  onMount(() => {
    // 事件源：首轮流结束（session 落定）重读；对话中收到推送就地刷新
    chatStore.onSessionCreated(() => {
      const uri = taskUri();
      if (uri) void loadConfigOptions(uri);
    });
    chatStore.onConfigOptions(() => {
      // 推送只当触发器：按当前任务重读（main 常驻泵已更新内存，本地读零成本）。
      // 不直接用推送数据——切任务时旧流残留推送会污染新任务的 UI。
      const uri = taskUri();
      if (uri) void loadConfigOptions(uri);
    });
    void agentStore.loadAutoApprove();
  });

  // 选中任务 = 进入详情：先清空上个任务的界面状态（消息按任务隔离），
  // 再建会话 + 一次性装配（模型/配置/列表）
  createEffect(() => {
    const uri = taskUri();
    // worker 串行执行：clear 先排入邮箱，在途轮次中止、旧消息清空，
    // 之后该任务的新发送才会执行，不会串台
    void chatStore.clearChat();
    if (uri) {
      void ensureSessionAndLoad(uri);
    } else {
      configLoadSeq++;
      setConfigOptions([]);
      setInitializing(false);
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
        <Show when={initializing()}>
          <span class="text-xs opacity-50">会话连接中…</span>
        </Show>
        {/* 模型选择（单一真相源：chatStore.activeModel，sendMessage 读的就是它） */}
        <select
          value={chatStore.activeModel ?? ""}
          disabled={initializing()}
          onChange={(e) => void handleModelChange(e.currentTarget.value)}
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
          disabled={initializing()}
          onClick={() => { const uri = taskUri(); if (uri) void agentStore.loadModels(uri); }}
        >
          ⟳
        </button>
        {/* 思考深度 (effort) */}
        <Show when={getConfig("effort")}>
          <div class="flex items-center gap-1">
            <span class="text-xs opacity-50">🧠</span>
            <select
              value={getConfig("effort")!.currentValue ?? "default"}
              disabled={initializing()}
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
              disabled={initializing()}
              onChange={(e) => setConfig("mode", e.currentTarget.value)}
              class="select select-bordered select-xs"
            >
              <For each={getConfig("mode")!.options ?? []}>
                {(o) => <option value={o.value}>{o.name}</option>}
              </For>
            </select>
          </div>
        </Show>
        {/* 自动审批 (autoApprove) */}
        <div class="flex items-center gap-1">
          <span class="text-xs opacity-50">🔐</span>
          <label class="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              class="checkbox checkbox-xs"
              checked={agentStore.autoApprove}
              onChange={(e) => void agentStore.setAutoApprove(e.currentTarget.checked)}
            />
            <span class="text-xs">自动审批</span>
          </label>
        </div>
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
          {/* Assistant 侧：工作中… 指示器（DeepSeek/OpenCode 风格） */}
          {sendingAccessor() && (
            <div class="w-full">
              <div class="flex flex-col gap-2">
                <div class="flex items-center gap-2 text-xs opacity-40">
                  <span>Agent</span>
                  <span class="loading loading-dots loading-xs"></span>
                </div>
                <div class="text-sm opacity-50">工作中…</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 输入区 */}
      <InputArea taskUri={taskUri()} />
    </div>
  );
}
