// components/MarkdownView.tsx — Markdown 渲染统一入口
//
// 唯一出口：Agent 正文 / 任务详情 / 后续 AGENTS.md 预览都走这里。
// remark-gfm 与 Shiki 只在本文件维护，调用方不判断语言、不碰高亮。
//
// 关键实现选择：
//   1. 交给 solid-markdown 生成 Solid 节点，不产出 HTML 字符串（无注入面）
//   2. 在 pre 层拦截围栏代码块：remark-rehype 产出 <pre><code class="language-x">，
//      若在 code 层替换会产生 <pre><pre> 嵌套（非法 HTML），必须在 pre 层整体替换
//   3. 源码文本从 hast node 取（solid-markdown 的 children 是渲染组件，不是字符串）
//   4. renderingStrategy="memo"：流式下复用节点，避免整棵重建（库默认即 memo，显式写明意图）
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

/** 取 hast 子树纯文本（代码块的源码正文） */
function hastText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

/** 从 code 节点的 className 提取语言（hast 中 className 是数组） */
function hastLang(node: HastNode): string | undefined {
  const cls = node.properties?.className;
  const first = Array.isArray(cls) ? cls[0] : typeof cls === "string" ? cls : undefined;
  return /language-([\w-]+)/.exec(String(first ?? ""))?.[1];
}

// ─── 组件映射 ────────────────────────────────────────

/** 构建映射。streaming 用 getter 延迟读取，保证 props 变化能追踪、映射对象身份稳定 */
function makeComponents(streaming: () => boolean) {
  return {
    /** 围栏代码块：<pre><code class="language-x">…</code></pre> → Shiki（整体替换 pre） */
    pre(props: { node?: HastNode; children?: unknown }) {
      const codeNode = props.node?.children?.find((c) => c.tagName === "code");
      if (!codeNode) return <pre>{props.children as never}</pre>;
      return <CodeBlock code={hastText(codeNode)} lang={hastLang(codeNode)} streaming={streaming()} />;
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
    <div class={`markdown-body text-sm leading-relaxed break-words ${props.class ?? ""}`}>
      <SolidMarkdown
        children={props.content}
        remarkPlugins={remarkPlugins}
        components={components as never}
        renderingStrategy="memo"
      />
    </div>
  );
}
