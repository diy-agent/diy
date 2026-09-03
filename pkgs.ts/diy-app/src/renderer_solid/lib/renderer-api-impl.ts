// @ts-nocheck
import type { EnvelopeTransport, ServerBinding } from "@diy/rpc";
import { ChannelServerBinding } from "@diy/rpc";
import { getRendererActions } from "./renderer-actions";
import { apiDef } from "../../main/services/api-def";
import { diyService } from "./rpc";
import { createProjectViaUi } from "./create-project";
import { createTaskViaUi } from "./create-task";

/**
 * renderer-api-impl.ts — Renderer 侧 RPC handler 绑定（handle 分离）
 *
 * 从 api-def.ts 导入纯 meta（diy.ui 子树），通过 binding.on(meta, handler) 绑定实现。
 * 命名体系：diy.ui.*（Renderer 进程域）。
 * 页面交互通过 renderer-actions 回调触发 Solid state 变更；
 * 进程级数据（diy.ui.tree/status）反向调 main 的 diy.* 获取。
 */

export function bindRendererApi(transport: EnvelopeTransport): ServerBinding {
  const binding = new ChannelServerBinding(transport);
  const ui = apiDef.diy.ui;

  binding.on(ui.component.list, async () => {
    // TODO: 动态扫描注册的组件
    return {
      status: "ok",
      data: {
        components: [
          { name: "taskTree", label: "任务树", description: "任务层级树形展示" },
          { name: "logPanel", label: "日志面板", description: "实时日志输出面板" },
          { name: "agentChat", label: "Agent 对话", description: "AI 代理对话面板" },
        ],
      },
    };
  });

  binding.on(ui.component.status, async () => {
    // TODO: 从组件 Store 读取真实状态
    return {
      status: "ok",
      data: { visible: true, state: "ready" },
    };
  });

  binding.on(ui.page.info, async () => ({
    status: "ok",
    data: {
      title: document.title,
      url: window.location.href,
      ready: document.readyState === "complete",
    },
  }));

  binding.on(ui.page.navigate, async ({ input }) => {
    getRendererActions().navigate?.(input.page);
    return { status: "ok" };
  });

  binding.on(ui.page.focus, async ({ input }) => {
    getRendererActions().focus?.(input.uri);
    return { status: "ok" };
  });

  binding.on(ui.page.toast, async ({ input }) => {
    getRendererActions().toast?.(input.message, input.level ?? "info");
    return { status: "ok" };
  });

  // diy.ui.tree — 反向调 main 的 diy.loadTaskTree 取结构化数据
  binding.on(ui.tree, async ({ input }) => {
    const nodes = await diyService.diy.loadTaskTree({ allTasks: input.all ?? false });
    return { status: "ok", data: nodes };
  });

  // diy.ui.status — 进程数据反向调 main 的 diy.getAppStatus
  binding.on(ui.status, async () => {
    const s = await diyService.diy.getAppStatus({});
    return { status: s.status, data: s.data };
  });

  // diy.ui.project.create — 与 UI「创建项目」按钮共用同一入口
  binding.on(ui.project.create, async ({ input }) => {
    const id = await createProjectViaUi(input.path, input.label, input.desc);
    return { status: "ok", data: { id } };
  });

  // diy.ui.task.create — 与 UI「项目行 ＋ 添加任务」按钮共用同一入口
  binding.on(ui.task.create, async ({ input }) => {
    const uri = await createTaskViaUi({
      title: input.title,
      project: input.project,
      parent: input.parent,
      detail: input.detail,
      body: input.body,
    });
    return { status: "ok", data: { uri } };
  });

  // diy.ui.inspect — 遍历 DOM 生成无障碍树（agent 了解 UI 全貌的入口）
  binding.on(ui.inspect, async () => {
    const tree = buildA11yTree(document.body);
    // 剥离内部字段（_count/_visible），保持输出干净
    const clean = stripInternal(tree);
    return {
      status: "ok",
      data: {
        tree: clean,
        stats: { totalNodes: tree?._count || 0, visibleNodes: tree?._visible || 0 },
      },
    };
  });

  return binding;
}

/** 递归移除节点上的内部辅助字段（下划线前缀），仅输出对 agent 有用的字段 */
function stripInternal(node: any): any {
  if (!node) return null;
  const clean: any = {};
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("_")) continue;
    clean[k] = Array.isArray(v) ? v.map(stripInternal) : v;
  }
  return clean;
}

/**
 * DOM → 无障碍树：递归遍历，提取 role / text / 位置 / 可见性。
 * 返回结构化对象供 agent 消费：{ role, text, children[], rect, visible }
 */
function buildA11yTree(el: Element): any {
  const style = getComputedStyle(el);
  const isHidden = style.display === "none" || style.visibility === "hidden" || style.opacity === "0";
  if (isHidden) return null;

  const tag = el.tagName.toLowerCase();
  const role =
    el.getAttribute("role") ||
    (tag === "button" ? "button" : tag === "input" || tag === "textarea" || tag === "select" ? "input" :
     tag === "table" ? "table" : tag === "tr" ? "row" : tag === "td" || tag === "th" ? "cell" :
     tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6" ? "heading" :
     tag === "a" ? "link" : tag === "img" ? "img" : tag === "ul" || tag === "ol" ? "list" :
     tag === "li" ? "listitem" : tag === "nav" ? "navigation" : tag === "main" ? "main" :
     tag === "header" ? "banner" : tag === "footer" ? "contentinfo" : tag === "aside" ? "complementary" :
     tag === "dialog" ? "dialog" : tag);

  // 文本内容：只取直接文本节点
  let text = "";
  for (const child of el.childNodes) {
    if (child.nodeType === 3) {
      const t = child.textContent?.trim() || "";
      if (t) text += (text ? " " : "") + t;
    }
  }
  // aria-label / title / placeholder 也取
  const ariaLabel = el.getAttribute("aria-label") || "";
  const title = el.getAttribute("title") || "";
  const placeholder = (el as HTMLInputElement).placeholder || "";
  if (!text && ariaLabel) text = ariaLabel;
  else if (!text && title) text = title;
  else if (!text && placeholder) text = `[placeholder: ${placeholder}]`;
  text = text.substring(0, 80);

  // 输入框的值
  let value = "";
  if (tag === "input" || tag === "textarea") {
    value = (el as HTMLInputElement).value || "";
    if (value) value = value.substring(0, 50);
  }
  if (tag === "select") {
    const sel = el as HTMLSelectElement;
    value = sel.options[sel.selectedIndex]?.text || "";
  }

  // 位置/尺寸
  const rect = el.getBoundingClientRect();

  // 子节点
  const children: any[] = [];
  let count = 1;
  let visible = 1;
  for (const child of el.children) {
    const childTree = buildA11yTree(child);
    if (childTree) {
      children.push(childTree);
      count += childTree._count || 0;
      visible += childTree._visible || 0;
    }
  }

  // 精简：如果 role 是 generic 且无文本无子节点，跳过
  if (role === "generic" && !text && children.length === 0) return null;
  // 精简：跳过 InlineTextBox / StaticText 等纯文本包装
  if (tag === "span" && children.length === 0 && !text) return null;

  const node: any = { role, text };
  if (value) node.value = value;
  if (rect.width > 0 && rect.height > 0) {
    node.rect = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
  }
  if (children.length > 0) node.children = children;
  node._count = count;
  node._visible = visible;
  return node;
}
