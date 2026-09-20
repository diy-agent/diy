// src/main/services/prompt-registry.ts
// 🎯 提示词模版注册表：内置只读 + 项目级同路径覆盖 + 装配渲染 + dry-run 预览
//
//   内置: prompts/defaults.ts（随版本走）
//   覆盖: $DIY_HOME/projects/<id>/template/<relpath>（与 tasks/ 同级，listTasks 只扫 tasks/ 数字目录）
//   元数据: template/.meta.yaml {<relpath>: {baseVersion}}（save 时记内置版本，供 stale 判定）
// 解析 = 覆盖存在 ? 覆盖 : 内置（覆盖文件只取 body，frontmatter 不算）；状态只有 builtin | overridden。
// 装配 = 以内置 system.md 为入口，交给 @diy/template 渲染：
//   节顺序与节间分隔写在 system.md 里，节标签内联在各节模版里，include 经本模块的 resolver
//   （项目覆盖 > 内置 + fragment/locked 标记 + 草稿）。
// 本模块只做组装与渲染，不发任何 LLM 请求（试验场试跑 = dry-run，看请求长什么样）。

import * as yaml from "js-yaml";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { analyze, render as renderDsl, type IncludeResolver } from "@diy/template";
import { PROMPT_DEFAULTS } from "../prompts/defaults";
import { parseTaskFile } from "../core/state";
import { resolveCwd } from "../core/cwd";
import { getProjectPath } from "../core/project";
import { readRuntimeConfig } from "../../runtime";
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

/** 该模版的角色：入口 / 节（被入口 include）/ 片段（其余）——单一真源是入口的 include 列表 */
function roleOf(relpath: string): PromptEntry["role"] {
  if (relpath === ENTRY_RELPATH) return "entry";
  const entryBody = parseMd(PROMPT_DEFAULTS[ENTRY_RELPATH] ?? "").body;
  const included = new Set(analyze(entryBody).includes.map((i) => i.relpath.replace(/^\.\//, "")));
  return included.has(relpath) ? "section" : "fragment";
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
 * 内容 trim（这是**数据准备**：链内容是变量值，不是模版源）
 */
function chainOf(home: string, cwd: string, taskUri: string): AssembleGlobals["chain"] {
  const homeDir = homedir();
  const start = resolve(cwd);
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
export interface AssembleGlobals {
  diy: { cli: string; home: string };
  project: { path: string };
  task: { uri: string; title: string; state: string; body: string; dir: string };
  cwd: { path: string; note: string; isFallback: boolean; isTaskDir: boolean; isAppDir: boolean };
  chain: Array<{ path: string; scope: string; content: string }>;
  skills: Array<{ name: string; desc: string }>;
}

/** 从模板常量构建 include resolver（fragment / locked 由 frontmatter 声明） */
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
export function renderSystemDsl(opts: {
  globals: AssembleGlobals | Record<string, unknown>;
  templates?: Record<string, string>;
  overrides?: Record<string, string>;
  resolve?: IncludeResolver["resolve"];
  entry?: string;
}): string {
  const templates = opts.templates ?? PROMPT_DEFAULTS;
  const entry = opts.entry ?? ENTRY_RELPATH;
  const raw = templates[entry];
  if (raw === undefined) throw new Error(`缺少装配入口模版：${entry}`);
  const { meta, body } = parseMd(raw);
  const resolver: IncludeResolver = { resolve: opts.resolve ?? makeTemplatesResolver(templates, opts.overrides).resolve };
  return renderDsl(body, { globals: opts.globals as Record<string, unknown> }, {
    resolver,
    file: entry,
    locked: meta.locked,
  });
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
      for (const issue of analyze(entry.current, { file: relpath }).lint) {
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
  const globals: AssembleGlobals = {
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
    chain: chainOf(home, cwdRes.cwd, taskUri),
    skills: opts.skills ?? [],
  };

  // include 解析：草稿 > 项目覆盖 > 内置；白名单 = 内置清单（assertRelpath 兜底）
  const resolveInclude: IncludeResolver["resolve"] = (relpath) => {
    const key = relpath.replace(/^\.\//, "");
    if (!Object.hasOwn(PROMPT_DEFAULTS, key)) return null;
    const draft = opts.drafts?.[key];
    const entry = entryOf(home, projectId, key);
    const source = draft !== undefined ? parseMd(draft).body : entry.current;
    return { source, locked: entry.locked };
  };
  const system = renderSystemDsl({ globals, resolve: resolveInclude });
  warnings.push(...lintWarnings(home, projectId));
  const used = Buffer.byteLength(system, "utf-8");
  const budget = systemBudgetForContext(opts.contextLimitTokens);
  return {
    system,
    // DSL 引擎对未知路径/参数是**抛错**（响亮），不再用"警告 + 原样保留"那种静默降级
    unknownVars: [],
    overBudget: used > budget ? { used, budget } : null,
    warnings,
  };
}
