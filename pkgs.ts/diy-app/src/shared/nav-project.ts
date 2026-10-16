// src/shared/nav-project.ts
// 🎯 nav「任务管理」分区按**项目**分组（##302）—— 纯函数，可单测。
//
// 为什么单独成文件：
//   · 分组是**显示层**的重排 —— 按「首次出现顺序」稳定分组、组内保持原相对顺序，
//     **不动 tabStore 里存的顺序**（那是用户心智中的位置，见 tabStore 的存储契约）。
//   · 两处真源在这里汇合：项目 id ← `projectFromUri(ctx)`（shared/task-uri.ts，唯一实现）；
//     项目显示名 ← 任务树的 `kind:"project"` 节点 `title`（= project_label，main 回填）。
//   · App 侧只做渲染，判据可被单测覆盖（不必起 Electron）。
//
// 与缩进语义的关系（**正交，别混**）：
//   缩进 = 任务层级（shared/tab-order 的 taskIndentOf），项目归属 = 这个 tab 挂在哪个项目。
//   祖先链必在同一项目内（task.move 强制同项目），子页面与父共享 ctx → 分组不会拆开
//   「父子族」，缩进不会指向组外。

import type { TaskNodeShape } from "../main/services/api-def";
import { projectFromUri } from "./task-uri";
import { partitionByPin } from "./nav-pin";

/** 项目引用（渲染组头 / 色标所需的全部信息） */
export interface ProjectRef {
  /** 项目 id（= URI 第二段） */
  id: string;
  /** 显示名：任务树的 project_label（如 `~/git/diy/diy`）；查不到时退化 id */
  label: string;
  /** 项目路径（title 提示用，可缺） */
  path?: string;
}

/** 从任务树抽「项目 id → 项目引用」索引（项目节点 = kind:"project"） */
export function projectIndexOf(nodes: TaskNodeShape[]): Map<string, ProjectRef> {
  const out = new Map<string, ProjectRef>();
  for (const n of nodes) {
    if (n.kind !== "project" || !n.project) continue;
    out.set(n.project, {
      id: n.project,
      label: n.project_label ?? n.title ?? n.project,
      path: n.project_path,
    });
  }
  return out;
}

/** 任务 URI → 项目 id；非任务 URI / 空 → ""（调用方按「无项目」处理） */
export function projectOfCtx(ctx: string | null | undefined): string {
  return ctx ? projectFromUri(ctx) : "";
}

export interface NavProjectGroup<T> {
  /** null = 该组 tab 没有项目归属（ctx 为空或非任务 URI） */
  project: ProjectRef | null;
  /** 组内 tab（置顶者在前，见 groupByProject 的 pinned 参数） */
  tabs: T[];
  /**
   * 组内置顶项个数（= `tabs` 前缀里置顶的条数）。0 = 本组没有置顶项。
   * 渲染侧用它画「置顶段 / 普通段」之间的分隔线（##356 ②的分隔线在 ##302 分组后按组内计）。
   */
  pinnedCount: number;
}

/**
 * 按项目把 tab 分组（**稳定**：组序 = 项目在**输入顺序**里的首次出现顺序，
 * 组内保持原相对顺序、只把置顶项提到组内最前）。
 *
 * 为什么不用「按项目 id / 名称排序」：nav 的顺序是用户心智中的位置，分组只该
 * 「把同项目的挪到一起」，不该顺手按 id 重排一遍 —— 那会让「刚打开的那个」
 * 莫名跑到中间去。项目排序若确要，是另一个决策（见任务 body 待拍板 ④）。
 *
 * 与置顶（##356 ②）的关系：**组序不由置顶决定**，只由输入顺序决定 ——
 * 调用方（App）喂的是 `navTabs().all`（置顶项已固定在前），故「含置顶项的组」
 * 自然排到最前：整组跟着走，因为**组是整体**（不可能只把组里一行提到别的组前面
 * 而不拆散分组）。本函数只负责「组内把置顶项提到最前」+ 报出 `pinnedCount`。
 *
 * ═══ 结果缓存：内容不变则返回**同一个数组 / 同一批组对象** ═══
 *
 * 为什么必需（不是过早优化）：nav 的 `<For each={groups()}>` 按**引用相等**复用 DOM。
 * 分组把原来的一层 `<For>` 变成两层 —— 组对象每轮换新引用的话，外层 For 会把整组
 * （含组内每一行）推倒重建：任务树每次刷新（fileWatcher 500ms 防抖，agent 干活时很密）
 * 都重建一遍导航，表现为闪、hover 丢。
 * 与 tabStore 的 itemCache 同一手法，但判据取**逐元素引用比较**而不是字符串签名：
 * tab 的 key 可能不变而对象已换（任务改父 → 祖先链变 → tabStore 换新 item），
 * 只比 key 会把**旧的缩进**端上来（##165 的教训）。引用不等 = 真变了。
 */
type AnyGroup = NavProjectGroup<{ ctx: string | null; key?: string }>;
let cacheOut: AnyGroup[] = [];

/** 逐元素比：组序、组头（id/label/path）、组内置顶数、组内 tab 对象引用，全同才算「没变」 */
function sameGroups(a: AnyGroup[], b: AnyGroup[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.project?.id !== y.project?.id || x.project?.label !== y.project?.label || x.project?.path !== y.project?.path)
      return false;
    if (x.pinnedCount !== y.pinnedCount) return false;
    if (x.tabs.length !== y.tabs.length) return false;
    for (let j = 0; j < x.tabs.length; j++) if (x.tabs[j] !== y.tabs[j]) return false;
  }
  return true;
}

export function groupByProject<T extends { ctx: string | null; key?: string }>(
  tabs: T[],
  index: Map<string, ProjectRef>,
  pinnedKeys?: ReadonlySet<string>,
): NavProjectGroup<T>[] {
  const groups: NavProjectGroup<T>[] = [];
  const byId = new Map<string, NavProjectGroup<T>>();
  for (const t of tabs) {
    const pid = projectOfCtx(t.ctx);
    let g = byId.get(pid);
    if (!g) {
      g = { project: pid ? (index.get(pid) ?? { id: pid, label: pid }) : null, tabs: [], pinnedCount: 0 };
      byId.set(pid, g);
      groups.push(g);
    }
    g.tabs.push(t);
  }
  // 置顶分区在**组内**做（复用 ##356 的 partitionByPin：区内保序、只分区不排序 ——
  // 同一份规则只有一个实现）。喂进来的顺序若已分区（App 喂 navTabs().all），这里是恒等变换，
  // 只是顺带报出每组的前缀条数；喂未分区的顺序则真的把组内置顶项提上来。
  if (pinnedKeys) {
    for (const g of groups) {
      const { pinned, rest } = partitionByPin(g.tabs, (t) => t.key ?? "", pinnedKeys);
      g.tabs = [...pinned, ...rest];
      g.pinnedCount = pinned.length;
    }
  }
  // 输入变了而输出逐元素相同 → 复用旧结果（保住外层 For 的 DOM）
  if (cacheOut.length > 0 && sameGroups(groups as AnyGroup[], cacheOut)) return cacheOut as NavProjectGroup<T>[];
  cacheOut = groups as AnyGroup[];
  return groups;
}

/**
 * 项目 id → 稳定色相（0..359）。**由 id 派生，无需任何配置**：同一个项目永远同色，
 * 不同项目大概率不同色。用途：组头色点 / 行左缘色条 —— 让「哪些行属于同一组」
 * 在**收起态（rail，装不下组头文字）**也读得出来。
 */
export function projectHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

/**
 * 项目 id → 色标用的 CSS 颜色（oklch：亮度固定在中段，明暗两主题都看得见）。
 *
 * 用 oklch 而不是 Tailwind 色板 class：class 必须是**静态字面量**才能被 JIT 扫到，
 * 而色相是运行期从 id 算出来的（动态拼 class 名会静默不生成 → 全是透明）。
 */
export function projectColor(id: string): string {
  return `oklch(70% 0.13 ${projectHue(id)})`;
}
