// components/MarkdownView.tsx — Markdown 渲染统一入口
//
// 唯一出口：Agent 正文 / 任务详情 / 后续 AGENTS.md 预览都走这里。
// remark-gfm 与 Shiki 只在本文件维护，调用方不判断语言、不碰高亮。
//
// 关键实现选择：
//   1. 交给 solid-markdown 生成 Solid 节点，不产出 HTML 字符串（无注入面）
//   2. 在 pre 层拦截围栏代码块：remark-rehype 产出 <pre><code class="language-x">，
//      若在 code 层替换会产生 <pre><pre> 嵌套（非法 HTML），必须在 pre 层整体替换
//   3. 源码文本从 hast node 取（solid-markdown 的 children 是渲染组件，不是字符串），
//      而且**必须用访问器现读**（理由见 4）
//   4. renderingStrategy="reconcile"：流式下**保住节点身份 → 保住 DOM**
//
// 为什么必须是 reconcile（##348 ②③ 的根因）：
//   solid-markdown 每次 children 变化都重新解析出一棵**全新** hast 树。"memo" 策略把这棵树
//   整体交给 <For each={node.children}>，而 <For> 按**引用**比对 —— 每帧都是新对象 ⇒ 每帧把
//   整棵子树拆了重建。后果不是"闪一下"：
//     · 块内 `overflow` 容器的 scrollLeft 归零 → 用户拖到长行右侧看 JSON，下一个 delta 就被拉回起点
//     · 拖选/双击选中的 DOM 节点被换掉 → selection 清空，流式期间根本选不中、copy 不了
//   reconcile 按**位置**合并 hast 树（hast 节点没有 key 字段，故走 index 分支）：同位置的节点
//   对象身份不变，只有真变了的字段（文本 value 等）被 setProperty 就地更新 ⇒ DOM 复用，Solid 的
//   细粒度更新才有落点。
//
//   ⚠️ 随之而来的硬约束：节点身份不变 ⇒ **组件函数体只跑一次**，函数体里 `props.node.children`
//   读到的是过期快照。凡是"会随内容变"的量（代码正文、语言）都必须写成访问器，让读发生在
//   Solid 的跟踪作用域里（见下面 pre 的 codeNode）。
import { Show } from "solid-js";
import { SolidMarkdown } from "solid-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";

const remarkPlugins = [remarkGfm];

// ─── hast 工具 ───────────────────────────────────────

interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** 取 hast 子树纯文本（代码块的源码正文）。读的都是 store 代理上的字段 ⇒ 在跟踪作用域里现读即可跟随更新 */
function hastText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

/** 从 code 节点的 className 提取语言（hast 中 className 是数组） */
function hastLang(node: HastNode | undefined): string | undefined {
  const cls = node?.properties?.className;
  const first = Array.isArray(cls) ? cls[0] : typeof cls === "string" ? cls : undefined;
  return /language-([\w-]+)/.exec(String(first ?? ""))?.[1];
}

// ─── 组件映射 ────────────────────────────────────────

/** 构建映射。streaming 用 getter 延迟读取，保证 props 变化能追踪、映射对象身份稳定 */
function makeComponents(streaming: () => boolean) {
  return {
    /** 围栏代码块：<pre><code class="language-x">…</code></pre> → Shiki（整体替换 pre） */
    pre(props: { node?: HastNode; children?: unknown }) {
      // 不能 `const codeNode = props.node.children.find(...)`：reconcile 下这个组件只挂载一次，
      // 而 code 节点的**内容**是就地更新的 —— 读一次等于把第一帧的内容钉死（流式里表现为
      // 代码块只显示开头一段）。故取节点、取正文都放进访问器，交给 Solid 的跟踪作用域。
      const codeNode = () => props.node?.children?.find((c) => c.tagName === "code");
      return (
        <Show when={codeNode()} fallback={<pre>{props.children as never}</pre>}>
          {(cn) => <CodeBlock code={hastText(cn())} lang={hastLang(cn())} streaming={streaming()} />}
        </Show>
      );
    },
    /** 行内 code：无语言、不换行、不高亮 */
    code(props: { node?: HastNode; inline?: boolean; children?: unknown }) {
      if (props.inline) {
        return (
          <code class="rounded bg-base-200 px-1 py-0.5 font-mono text-[0.9em]">
            {props.node ? hastText(props.node) : (props.children as never)}
          </code>
        );
      }
      // 兜底：极少数不带 <pre> 的代码块（如裸 code 节点）直接交给 CodeBlock
      return <CodeBlock code={props.node ? hastText(props.node) : ""} />;
    },
  };
}

export function MarkdownView(props: {
  content: string;
  class?: string;
  /** 内容是否仍在流式生成（透传给 CodeBlock 决定是否高亮） */
  streaming?: boolean;
}) {
  const components = makeComponents(() => !!props.streaming);
  return (
    <div class={`markdown-body text-prose leading-relaxed break-words ${props.class ?? ""}`}>
      <SolidMarkdown
        children={props.content}
        remarkPlugins={remarkPlugins}
        components={components as never}
        renderingStrategy="reconcile"
      />
    </div>
  );
}
