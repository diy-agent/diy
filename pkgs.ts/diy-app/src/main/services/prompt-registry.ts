// src/main/services/prompt-registry.ts
// 🎯 提示词模版注册表：内置只读 + 项目级同路径覆盖 + 装配渲染 + dry-run 预览
//
//   内置: prompts/defaults.ts（随版本走）
//   覆盖: $DIY_HOME/projects/<id>/template/<relpath>（与 tasks/ 同级，listTasks 只扫 tasks/ 数字目录）
//   元数据: template/.meta.yaml {<relpath>: {baseVersion}}（save 时记内置版本，供 stale 判定）
// 解析 = 覆盖存在 ? 覆盖 : 内置（覆盖文件只取 body，frontmatter 不算）；状态只有 builtin | overridden。
// 装配 = 以内置 system.md 为入口，交给 @diy/template 渲染：
//   节顺序与节间分隔写在 system.md 里，节标签内联在各节模版里，include 经本模块的 resolver
//   （项目覆盖 > 内置 + locked 标记 + 草稿）。
// 本模块只做组装与渲染，不发任何 LLM 请求（试验场试跑 = dry-run，看请求长什么样）。

import * as yaml from "js-yaml";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { analyze, renderWithTrace, type IncludeResolver, type TraceNode, type VarSpec } from "@diy/template";
import { AssembleGlobalsSchema, type AssembleGlobals } from "../../shared/prompt-schema";

// 契约类型从 schema 推导（单一真源）；装配方按它注入，漂移由 safeParse 兜住
export type { AssembleGlobals };
import { flattenVars } from "../../shared/var-tree";
import { PROMPT_DEFAULTS } from "../prompts/defaults";
import {
  renderSummaryFallback,
  summaryHasContent,
  SUMMARY_TEMPLATE_RELPATH,
  type SummaryData,
} from "../../shared/context/summary";
import { parseTaskFile } from "../core/state";
import { resolveCwd } from "../core/cwd";
import { personaForTask } from "../core/persona";
import { getProjectPath } from "../core/project";
import { readRuntimeConfig } from "../../runtime";
import { llmLogRelPath } from "../core/local-paths";
import { historyIndexValue } from "../../shared/context/history-index";
// 契约类型唯一源（shared/prompt-schema.ts，纯 zod）——renderer 也用它，避免手抄第二份
import type { AssembledSystem, PromptEntry } from "../../shared/prompt-schema";

export type { AssembledSystem, PromptEntry };

export interface PromptMeta {
  title: string;
  desc: string;
  version: number;
  /** 锁定 = 不可覆盖（命名约定：`_` 前缀 = 锁定，由 lint 保证一致） */
  locked: boolean;
  /** 锁定时展示给用户的理由 */
  lockTip: string;
}

/** 变量契约：由 shared/prompt-schema 的 AssembleGlobalsSchema 派生（单一真源在那里） */
export const SYSTEM_VARS: VarSpec[] = flattenVars(AssembleGlobalsSchema);

/**
 * 「历史摘要」节的变量契约（summary.md 专用）。
 * 为什么单独一份、不并进 SYSTEM_VARS：摘要是**动态内容**、不进 _system.md 装配，
 * 它的变量不属于 AssembleGlobals（配置真源）——并进去会让 lint 以为它是 system 的一部分。
 */
const SUMMARY_VARS: VarSpec[] = [
  { path: "summary", type: "object" },
  { path: "summary.turns", type: "number" },
  { path: "summary.conclusions", type: "array" },
  { path: "summary.changes", type: "array" },
  { path: "summary.todos", type: "array" },
  { path: "summary.open", type: "array" },
];

/** 装配入口固定名（顺序与分隔的唯一真源） */
export const ENTRY_RELPATH = "_system.md";

const FM_SEP = "---";

/**
 * 解析模版：frontmatter + body。
 * **模版源逐字节进引擎**：body 只去掉 frontmatter 后那一个换行，不 trim、不补 \n
 * （末尾换行与节间分隔由模版自己负责）。
 */
export function parseMd(raw: string): { meta: PromptMeta; body: string } {
  const fallback: PromptMeta = { title: "", desc: "", version: 1, locked: false, lockTip: "" };
  if (!raw.startsWith(FM_SEP)) return { meta: fallback, body: raw };
  const end = raw.indexOf(FM_SEP, 3);
  if (end === -1) return { meta: fallback, body: raw };
  let front: Record<string, unknown> = {};
  try {
    front = (yaml.load(raw.slice(3, end).trim() || "{}") as Record<string, unknown>) ?? {};
  } catch {
    return { meta: fallback, body: raw.slice(end + 3).trim() };
  }
  return {
    meta: {
      title: String(front["title"] ?? ""),
      desc: String(front["desc"] ?? ""),
      version: Number(front["version"] ?? 1),
      locked: front["locked"] === true,
      lockTip: String(front["lockTip"] ?? ""),
    },
    body: raw.slice(end + 3).replace(/^\n/, ""),
  };
}

/** relpath 白名单校验：只允许 manifest（PROMPT_DEFAULTS key）内条目，防 ../ 穿越。
 *  必须用 Object.hasOwn：`in` 会命中原型链（"toString"/"constructor"），后续取到函数再 startsWith 就崩成 500。 */
export function assertRelpath(relpath: string): void {
  const n = normalize(relpath);
  if (!Object.hasOwn(PROMPT_DEFAULTS, n) || n.startsWith("..") || n.includes("\0")) {
    throw new Error(`非法模版路径: ${relpath}`);
  }
}

function templateDir(home: string, projectId: string): string {
  return join(home, "projects", projectId, "template");
}

function metaPath(home: string, projectId: string): string {
  return join(templateDir(home, projectId), ".meta.yaml");
}

function readMeta(home: string, projectId: string): Record<string, { baseVersion: number }> {
  const p = metaPath(home, projectId);
  if (!existsSync(p)) return {};
  try {
    return (yaml.load(readFileSync(p, "utf-8")) as Record<string, { baseVersion: number }>) ?? {};
  } catch {
    return {};
  }
}

/** 原子写（tmp + rename）：同一份数据被预览读、被 UI 写，不能出现半截文件。
 *  与 core/drafts.ts 的做法一致。 */
function writeFileAtomic(fp: string, content: string): void {
  mkdirSync(dirname(fp), { recursive: true });
  const tmp = `${fp}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, fp);
}

/** 写 sidecar；内容为空则删文件（否则 restore 会留下一个 `{}` 空壳，看着像残留）。 */
function writeMeta(home: string, projectId: string, meta: Record<string, { baseVersion: number }>): void {
  const p = metaPath(home, projectId);
  if (Object.keys(meta).length === 0) {
    rmSync(p, { force: true });
    return;
  }
  writeFileAtomic(p, yaml.dump(meta, { indent: 2, noRefs: true }));
}

/** 覆盖正文按 md 解析只取 body：手写覆盖文件里的 frontmatter 是噪音，不得进请求。
 *  （内置走同一 parseMd，两边语义一致：只有正文生效，meta 一律来自内置） */
function readOverride(fp: string): string {
  return parseMd(readFileSync(fp, "utf-8")).body;
}

/** 孤儿覆盖文件：躺在 template/ 里但 relpath 已不在 manifest（典型：改名/降级后的遗物）。
 *  它们既不生效也不上屏，用户不看磁盘就永远不知道 —— 所以装配时当成告警报出来。 */
function orphanOverrides(home: string, projectId: string): string[] {
  const root = templateDir(home, projectId);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > 2 || out.length > 20) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith(".")) continue; // .meta.yaml 等元数据不算孤儿
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(join(dir, ent.name), rel, depth + 1);
      else if (!Object.hasOwn(PROMPT_DEFAULTS, rel)) out.push(rel);
    }
  };
  try {
    walk(root, "", 0);
  } catch {
    return [];
  }
  return out;
}

/**
 * 该模版的角色（**由入口的 include 列表推导**，不手工维护）：
 *   · 入口本身（`_system.md`）→ "entry"
 *   · 被入口 include 的 → "section"（进 system 装配）
 *   · 两者都不是 → "fragment"（独立模版，不在 system 里；当前唯一实例是 summary.md —
 *     压缩摘要，投递位置是会话首条消息而非 system，故不进 _system.md）
 */
function entryIncludes(): Set<string> {
  const raw = PROMPT_DEFAULTS[ENTRY_RELPATH] ?? "";
  const { body } = parseMd(raw);
  const out = new Set<string>();
  for (const m of body.matchAll(/:include="([^"]+)"/g)) out.add(m[1]!.replace(/^\.\//, ""));
  return out;
}
function roleOf(relpath: string): PromptEntry["role"] {
  if (relpath === ENTRY_RELPATH) return "entry";
  return entryIncludes().has(relpath) ? "section" : "fragment";
}

function entryOf(home: string, projectId: string, relpath: string, metaAll?: Record<string, { baseVersion: number }>): PromptEntry {
  assertRelpath(relpath);
  const { meta, body } = parseMd(PROMPT_DEFAULTS[relpath]!);
  const fp = join(templateDir(home, projectId), relpath);
  const hasOverride = existsSync(fp);
  const current = hasOverride ? readOverride(fp) : body;
  const baseVersion = (metaAll ?? readMeta(home, projectId))[relpath]?.baseVersion ?? null;
  return {
    ...meta,
    relpath,
    role: roleOf(relpath),
    status: hasOverride ? "overridden" : "builtin",
    current,
    builtin: body,
    baseVersion,
    // baseVersion 为 null 但确实有覆盖文件 = 手工放进去的（非 save 写入），来源不可知 → 同样提示可能过期
    stale: hasOverride && (baseVersion === null || baseVersion !== meta.version),
  };
}

/** 列出全部模版（含状态/元数据，供树展示）。sidecar 只读一次，避免 per-entry 重读磁盘。 */
export function listPrompts(home: string, projectId: string): PromptEntry[] {
  const metaAll = readMeta(home, projectId);
  return Object.keys(PROMPT_DEFAULTS).map((r) => entryOf(home, projectId, r, metaAll));
}

/** 取单份模版（含内置/当前/stale，供查看与编辑） */
export function getPrompt(home: string, projectId: string, relpath: string): PromptEntry {
  return entryOf(home, projectId, relpath);
}

/** 保存项目级覆盖（存正文 + sidecar 记内置版本）。不可覆盖的直接抛错。
 *  同时做体积校验：盖一个超大覆盖会让之后每一轮都被拒发（诊断成本很高），在写入前就拦住。 */
export function savePrompt(home: string, projectId: string, relpath: string, content: string): PromptEntry {
  const cur = entryOf(home, projectId, relpath);
  if (cur.locked) throw new Error(`模版 ${relpath} 已锁定：${cur.lockTip}`);
  const probe = assembleSystem(home, projectId, { drafts: { [relpath]: content } });
  if (probe.overBudget) {
    const kb = (n: number) => (n / 1024).toFixed(1);
    throw new Error(
      `覆盖体积超限：装配后 ${kb(probe.overBudget.used)} KB > 上限 ${kb(probe.overBudget.budget)} KB` +
        `（已拒绝写入 —— 否则之后每一轮都会被拒发）。请精简后重试。`,
    );
  }
  writeFileAtomic(join(templateDir(home, projectId), relpath), content);
  const metaAll = readMeta(home, projectId);
  metaAll[relpath] = { baseVersion: cur.version };
  writeMeta(home, projectId, metaAll);
  return entryOf(home, projectId, relpath);
}

/** 一键恢复（删覆盖文件 + 清 sidecar，幂等）。全恢复后连空目录一起收掉，不留 `{}` 残留。 */
export function restorePrompt(home: string, projectId: string, relpath: string): PromptEntry {
  assertRelpath(relpath);
  rmSync(join(templateDir(home, projectId), relpath), { force: true });
  const metaAll = readMeta(home, projectId);
  delete metaAll[relpath];
  writeMeta(home, projectId, metaAll);
  if (Object.keys(metaAll).length === 0) {
    try {
      rmdirSync(templateDir(home, projectId)); // 非空（还有别的覆盖）时会抛，忽略即可
    } catch {
      /* 目录非空或不存在：都不是错误 */
    }
  }
  return entryOf(home, projectId, relpath);
}

/** 系统上下文预算（字节）：与模型上下文窗口挂钩（窗口 × 5%，clamp 16KB~64KB） */
export const SYSTEM_BUDGET_CAP_BYTES = 64 * 1024;
export const SYSTEM_BUDGET_CONTEXT_SHARE = 0.05;
export const DEFAULT_SYSTEM_BUDGET_BYTES = SYSTEM_BUDGET_CAP_BYTES;

/** 由模型上下文窗口（tokens）推导系统上下文预算（字节）；未知则用默认值 */
export function systemBudgetForContext(contextLimitTokens?: number): number {
  if (!contextLimitTokens || !Number.isFinite(contextLimitTokens) || contextLimitTokens <= 0) {
    return DEFAULT_SYSTEM_BUDGET_BYTES;
  }
  const bytes = Math.floor(contextLimitTokens * 4 * SYSTEM_BUDGET_CONTEXT_SHARE); // 粗估 1 token ≈ 4 字节
  return Math.max(16 * 1024, Math.min(SYSTEM_BUDGET_CAP_BYTES, bytes));
}

/** 任务文件路径（home 参数权威：不用 state.taskFilePath，那走全局 diyHome，隔离失效） */
function taskFileAt(home: string, taskUri: string): string {
  return taskUri ? join(home, taskUri, "AGENTS.md") : "";
}

/** 读任务元信息与正文（不存在/缺 frontmatter 时返回 null） */
function taskOf(home: string, taskUri: string): { title: string; state: string; body: string } | null {
  const fp = taskFileAt(home, taskUri);
  if (!fp || !existsSync(fp)) return null;
  const meta = parseTaskFile(readFileSync(fp, "utf-8"));
  if (!meta) return null;
  return { title: meta.title ?? "", state: meta.state ?? "", body: meta.body ?? "" };
}

/**
 * AGENTS.md 链：从工作目录逐层向上，外层在前、最深处在后。
 * - 只看标准 AGENTS.md；排除任务本体（tasks/<tid>/AGENTS.md 是任务正文，已由 300-task 渲染）
 * - **上界 = $HOME**（不进 /、不进 /Users）：家里那几层（~/AGENTS.md、~/git/AGENTS.md …）
 *   是用户指定的全局规则与信息，就是要逐层生效到每个任务
 * - 工作目录不在 $HOME 内时才只取该目录自身一层；另加 $DIY_HOME/AGENTS.md 作为应用级规范
 * - ⚠️ **isAppDir 回退（项目目录与任务目录都不存在）时整条链为空**：那时的 cwd 是
 *   `process.cwd()`，即「应用进程恰好被启动在哪个目录」—— 它既不是任务的项目、也不是
 *   应用自己的规范，注入它等于把"启动 shell 的偶然位置"当成任务规范；而且该目录若正好
 *   是个大仓库（如本仓库的 `pkgs.ts/diy-app/AGENTS.md` 有 70 KB），还会把 system 预算吃光
 *   → 连"保存一条模版覆盖"都会被体积校验拒绝（savePrompt 的探针同样走这里）。
 *   项目/任务目录任一存在时行为不变。
 * 内容 trim（这是**数据准备**：链内容是变量值，不是模版源）
 */
function chainOf(home: string, cwd: string, taskUri: string, isAppDir = false): AssembleGlobals["chain"] {
  const homeDir = homedir();
  const start = resolve(cwd);
  if (isAppDir) {
    // 只保留应用级规范（$DIY_HOME/AGENTS.md），不爬 process.cwd() 的链
    const only = join(home, "AGENTS.md");
    return existsSync(only)
      ? [{ path: only, scope: dirname(only), content: readFileSync(only, "utf-8").trim() }]
      : [];
  }
  const underHome = start === homeDir || start.startsWith(homeDir + sep);
  const stop = underHome ? homeDir : start;
  const ownTaskFile = taskFileAt(home, taskUri);
  const skip = ownTaskFile ? resolve(ownTaskFile) : "";
  const seen = new Set<string>();
  const files: string[] = [];
  for (let dir = start; ; dir = dirname(dir)) {
    const fp = join(dir, "AGENTS.md");
    if (fp !== skip && !seen.has(fp) && existsSync(fp)) {
      seen.add(fp);
      files.push(fp);
    }
    if (dir === stop || dir === dirname(dir)) break;
  }
  files.reverse();
  const appLevel = join(home, "AGENTS.md");
  if (!seen.has(appLevel) && existsSync(appLevel)) files.unshift(appLevel);
  return files.map((fp) => ({ path: fp, scope: dirname(fp), content: readFileSync(fp, "utf-8").trim() }));
}

// ═══════════════════════════════════════════════════════════════
// DSL 装配（M4 默认路径）：节标签内联在模版里、顺序与分隔写在 system.md 里
// ═══════════════════════════════════════════════════════════════

/** DSL 装配变量（命名空间版）：模版里写 {{diy.cli}} / {{task.title}} / {{.path}} */

/** 从模板常量构建 include resolver（locked 由 frontmatter 声明） */
export function makeTemplatesResolver(
  templates: Record<string, string>,
  overrides?: Record<string, string>,
): IncludeResolver {
  return {
    resolve(relpath) {
      // 模版内写的是 "./xxx.md"；注册表的键是不带 "./" 的 relpath
      const key = relpath.replace(/^\.\//, "");
      const raw = overrides?.[key] ?? templates[key];
      if (raw === undefined) return null;
      const { meta, body } = parseMd(raw);
      return { source: body, locked: meta.locked };
    },
  };
}

/**
 * 用 DSL 引擎渲染 system.md（真发与预览共用）。
 * @param resolve 自定义 include 解析（真环境用它接入项目覆盖与草稿）；缺省从 templates 取
 */
/** 装配渲染（带结构 trace）：试验场「模版结构树」用它，真发只用 text */
export function renderSystemDslTraced(opts: {
  globals: AssembleGlobals | Record<string, unknown>;
  templates?: Record<string, string>;
  overrides?: Record<string, string>;
  resolve?: IncludeResolver["resolve"];
  entry?: string;
}): { text: string; trace: TraceNode[] } {
  const templates = opts.templates ?? PROMPT_DEFAULTS;
  const entry = opts.entry ?? ENTRY_RELPATH;
  const raw = templates[entry];
  if (raw === undefined) throw new Error(`缺少装配入口模版：${entry}`);
  const { meta, body } = parseMd(raw);
  const resolver: IncludeResolver = { resolve: opts.resolve ?? makeTemplatesResolver(templates, opts.overrides).resolve };
  const res = renderWithTrace(body, { globals: opts.globals as Record<string, unknown> }, {
    resolver,
    file: entry,
    locked: meta.locked,
  });
  return { text: res.text, trace: res.trace };
}

/**
 * 渲染「历史摘要」节（压缩承接用）。
 * 与 system 装配**共用同一个引擎与 include 解析**（项目覆盖/草稿都生效），但**不进 _system.md**：
 * 摘要是动态内容，投递位置是「新会话首条上下文消息」，放 system 会砸前缀缓存。
 * 模版缺失/损坏 → 回退纯文本渲染（renderSummaryFallback），不让承接能力整个哑掉。
 */
export function renderSummarySection(
  home: string,
  projectId: string,
  data: SummaryData,
): string {
  if (!summaryHasContent(data)) return "";
  try {
    const resolve = projectIncludeResolver(home, projectId);
    const text = renderSystemDsl({ globals: { summary: data }, resolve, entry: SUMMARY_TEMPLATE_RELPATH });
    return text.trim() ? text.trim() : renderSummaryFallback(data);
  } catch (e) {
    console.warn("[prompt-registry] 摘要模版渲染失败，回退纯文本:", e);
    return renderSummaryFallback(data);
  }
}

/** 只取文本（真发路径；不分配 trace） */
export function renderSystemDsl(opts: {
  globals: AssembleGlobals | Record<string, unknown>;
  templates?: Record<string, string>;
  overrides?: Record<string, string>;
  resolve?: IncludeResolver["resolve"];
  entry?: string;
}): string {
  return renderSystemDslTraced(opts).text;
}

/**
 * 项目级 include 解析（草稿 > 项目覆盖 > 内置；白名单 = 内置清单，`assertRelpath` 兜底）。
 * 装配（`assembleSystem`）与「模版节 → 投递节点」（`assembleGlobals`）**共用同一份**，
 * 否则"页面上改的 identity.md"与"真发投出去的身份节"会各读各的（界面说谎的老毛病）。
 */
export function projectIncludeResolver(
  home: string,
  projectId: string,
  drafts?: Record<string, string>,
): IncludeResolver["resolve"] {
  return (relpath) => {
    const key = relpath.replace(/^\.\//, "");
    if (!Object.hasOwn(PROMPT_DEFAULTS, key)) return null;
    const draft = drafts?.[key];
    const entry = entryOf(home, projectId, key);
    const source = draft !== undefined ? parseMd(draft).body : entry.current;
    return { source, locked: entry.locked };
  };
}

/**
 * 投递 system 是否超预算（真发与模版线预览**同一判据**：超了就整轮不发请求）。
 * 抽出来是为了能单测这条边界（209 review P1-3：预算分支无覆盖）——
 * "等于预算"必须放行，只有**严格大于**才拒发。
 */
export function systemOverBudget(
  usedBytes: number,
  contextLimitTokens?: number,
): { used: number; budget: number } | null {
  const used = Math.floor(usedBytes);
  const budget = systemBudgetForContext(contextLimitTokens);
  return used > budget ? { used, budget } : null;
}

/** 静态体检：把模版里的 lint（如控制属性误用）汇总成告警，不阻断装配 */
function lintWarnings(home: string, projectId: string): string[] {
  const out: string[] = [];
  // 命名约定：`_` 前缀 = 锁定，双向一致（否则名字会骗人）
  for (const [relpath, raw] of Object.entries(PROMPT_DEFAULTS)) {
    const { meta } = parseMd(raw);
    const underscored = relpath.startsWith("_");
    if (underscored !== meta.locked) {
      out.push(
        `命名与锁定不一致：${relpath} ${underscored ? "带 _ 前缀" : "不带 _ 前缀"}，但 locked=${meta.locked}` +
          `（规则：_ 前缀 = 锁定）`,
      );
    }
  }
  if (!parseMd(PROMPT_DEFAULTS[ENTRY_RELPATH] ?? "").meta.locked) {
    out.push(`装配入口 ${ENTRY_RELPATH} 必须锁定（改它会改节顺序与分隔）`);
  }
  for (const relpath of Object.keys(PROMPT_DEFAULTS)) {
    const entry = entryOf(home, projectId, relpath);
    try {
      const vars = relpath === SUMMARY_TEMPLATE_RELPATH ? SUMMARY_VARS : SYSTEM_VARS;
      for (const issue of analyze(entry.current, { file: relpath, vars }).lint) {
        out.push(`${relpath}:${issue.loc.line}:${issue.loc.col} ${issue.message}`);
      }
    } catch (e) {
      out.push(`${relpath} 语法检查失败：${(e as Error).message}`);
    }
  }
  return out;
}

/**
 * 装配系统上下文（真发与预览共用同一入口）。
 * drafts 允许覆盖未存盘草稿（relpath → 正文），做到所见即所得。
 * contextLimitTokens：当前模型的上下文窗口（tokens），决定预算；缺省用硬上限。
 */
export function assembleSystem(
  home: string,
  projectId: string,
  opts: {
    taskUri?: string;
    skills?: Array<{ name: string; desc: string }>;
    drafts?: Record<string, string>;
    diyCli?: string;
    contextLimitTokens?: number;
    /** 附带结构 trace（试验场「模版结构树」用；真发不传，省一次 trace 分配） */
    trace?: boolean;
  } = {},
): AssembledSystem {
  const taskUri = opts.taskUri ?? "";
  const task = taskOf(home, taskUri);
  const cwdRes = resolveCwd(home, taskUri);
  const warnings: string[] = [];
  const orphans = orphanOverrides(home, projectId);
  if (orphans.length > 0) {
    warnings.push(
      `检测到 ${orphans.length} 个不再生效的覆盖文件（relpath 不在内置清单，已改名/降级遗留）：` +
        `${orphans.join(", ")}。它们既不生效也不上屏，请手工删除或改用当前 relpath 重新保存。`,
    );
  }
  const diyCli = opts.diyCli ?? readRuntimeConfig().cli ?? "";
  if (!diyCli) {
    // 兜底不能让提示词说谎：dev（electron-dev 未注入）/ 非 CLI 启动时会出现
    warnings.push(
      "未注入 DIY_CLI（当前进程环境没有该变量）：提示词里的「命令行入口」会退化成裸 diy，在 worktree 里会打到生产数据根。检查启动脚本是否注入 DIY_CLI。",
    );
  }
  const globals = assembleGlobals(home, projectId, {
    taskUri,
    skills: opts.skills,
    diyCli,
    // 草稿也要进"节渲染"：模版编辑器里没保存的 identity.md 改动，预览与投递都该立刻反映
    drafts: opts.drafts,
  });

  const resolveInclude = projectIncludeResolver(home, projectId, opts.drafts);
  // 注入与变量契约漂移要响亮（schema 是单一真源，类型层面已保证；这里兜住运行时手改）
  const check = AssembleGlobalsSchema.safeParse(globals);
  if (!check.success) {
    warnings.push(
      `注入 globals 与变量契约（AssembleGlobalsSchema）不符：` +
        check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；"),
    );
  }
  const rendered = renderSystemDslTraced({ globals, resolve: resolveInclude });
  const system = rendered.text;
  warnings.push(...lintWarnings(home, projectId));
  const used = Buffer.byteLength(system, "utf-8");
  const overBudget = systemOverBudget(used, opts.contextLimitTokens ? opts.contextLimitTokens : undefined);
  return {
    system,
    overBudget,
    warnings,
    trace: opts.trace ? rendered.trace : null,
    // 实际注入值原样回传：「变量值」view 与模版结构树的「值」列共用同一份事实
    values: globals as unknown as Record<string, unknown>,
  };
}

/** 投递出去的模版节：`globals` 的键名 → 模版 relpath（键名就是它在投递里的节点名） */
export const DELIVERED_SECTIONS = {
  identity: "identity.md",
  rules: "rules.md",
  guard: "_guard.md",
} as const;

/** 构造注入 globals（单一真源；与 SYSTEM_VARS 的一致性由测试守护） */
export function assembleGlobals(
  home: string,
  projectId: string,
  opts: {
    taskUri?: string;
    skills?: Array<{ name: string; desc: string }>;
    diyCli?: string;
    /** 未存盘草稿（relpath → 正文）：模版编辑器里没保存的改动也即时反映到投递 */
    drafts?: Record<string, string>;
  } = {},
): AssembleGlobals {
  const taskUri = opts.taskUri ?? "";
  const task = taskOf(home, taskUri);
  const cwdRes = resolveCwd(home, taskUri);
  const diyCli = opts.diyCli ?? readRuntimeConfig().cli ?? "";
  // 当前人物（模型/参数/行为指令的真源是 personas.yaml；任务只持有引用）——预览与真发同一入口，
  // 故试验场看到的身份节与实际请求一致，不会出现"预览里有行为指令、真发没有"的漂移
  const persona = personaForTask(home, taskUri);
  const core = {
    persona: { name: persona.name, instructions: persona.instructions },
    diy: { cli: diyCli || "diy（未注入 DIY_CLI，勿照抄）", home },
    project: { path: getProjectPath(projectId) ?? "" },
    task: {
      uri: taskUri,
      title: task?.title ?? "",
      state: task?.state ?? "",
      body: task?.body ?? "",
      dir: taskUri ? join(home, taskUri) : "",
    },
    cwd: {
      path: cwdRes.cwd,
      note: cwdRes.note,
      isFallback: cwdRes.isFallback,
      isTaskDir: cwdRes.isTaskDir,
      isAppDir: cwdRes.isAppDir,
    },
    chain: chainOf(home, cwdRes.cwd, taskUri, cwdRes.isAppDir),
    skills: opts.skills ?? [],
  };
  // ── 模版节 → 投递节点（144「模版即节点」方向的第一步）──
  // 真发要的不只是 `persona` 的**值**，而是模版渲染出来的**整节**：identity.md 是
  // 「你是 … 人物是「X」」+ 人物行为指令，rules.md 是行为规范，_guard.md 是保命契约。
  // 不在这里渲染，真发就一样不投（209 review P0-1 实测：真发 system 里 persona/身份/
  // <rules>/<guard> 全 false → 合并后模型收不到人物指令，保命契约也没了）。
  //
  // 用 `core`（不含本节）当渲染变量：identity.md 只引用 persona，不引用自己。
  const resolve = projectIncludeResolver(home, projectId, opts.drafts);
  // 渲染时**必须走 resolver 取本节正文**（草稿 > 项目覆盖 > 内置），不能直接用 PROMPT_DEFAULTS：
  // renderSystemDsl 的 entry 本体是 `templates[entry]`，把内置当默认值传进去就等于
  // "项目里改过的 identity/rules 不进真发"（正是划分规则当年踩过的"页面改了真发不理"）。
  const section = (relpath: string): string => {
    const hit = resolve(`./${relpath}`);
    if (!hit) throw new Error(`缺少模版节：${relpath}`);
    return renderSystemDsl({ globals: core, templates: { [relpath]: hit.source }, entry: relpath, resolve });
  };
  return {
    ...core,
    identity: section(DELIVERED_SECTIONS.identity),
    rules: section(DELIVERED_SECTIONS.rules),
    guard: section(DELIVERED_SECTIONS.guard),
    // 压缩历史索引的**格式说明**（稳定项 → 进 system；易变的注记数据留在 messages）。
    // 路径算法与 local-agent 共用 ../core/local-paths —— 两处各写一份 key 会让"模型照注释
    // 取不到原文"（比不给索引更坏）。
    historyIndex: historyIndexValue(llmLogRelPath(taskUri)),
  };
}
