// src/main/services/prompt-registry.ts
// 🎯 提示词模版注册表：内置只读 + 项目级同路径覆盖 + 装配渲染 + dry-run 预览
//
//   内置: prompts/defaults.ts（随版本走）
//   覆盖: $DIY_HOME/projects/<id>/template/<relpath>（与 tasks/ 同级，listTasks 只扫 tasks/ 数字目录）
//   元数据: template/.meta.yaml {<relpath>: {baseVersion}}（save 时记内置版本，供 stale 判定）
// 解析 = 覆盖存在 ? 覆盖 : 内置（覆盖文件只取 body，frontmatter 不算）；状态只有 builtin | overridden。
// 装配 = 按 PROMPT_DEFAULTS 的对象键序拼接（声明顺序即装配顺序），非 identity 节包同名标签，空节不进请求。
// 本模块只做组装与渲染，不发任何 LLM 请求（试验场试跑 = dry-run，看请求长什么样）。

import * as yaml from "js-yaml";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";
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
  overridable: boolean;
  /** 不可覆盖时的禁用按钮 tooltip；可覆盖时为空串 */
  tip: string;
  /** 包裹标签名（空串 = 裸文本节，不包 <...>）：由模版 frontmatter 声明，代码里不再维护 map */
  tag: string;
  /** 片段模版：不参与节拼接，只供引用它的变量渲染（如 _chain.md 供 {{project_instructions}}） */
  fragment: boolean;
}

/** 装配变量（全部来自运行时事实，模板只做白名单替换） */
export interface AssembleVars {
  diy_cli: string;
  diy_home: string;
  project_path: string;
  task_uri: string;
  task_title: string;
  task_state: string;
  task_body: string;
  task_dir: string;
  cwd: string;
  /** 工作目录与项目目录不一致时的提示；一致时为空 */
  cwd_note: string;
  /** AGENTS.md 链渲染结果（见 projectInstructions） */
  project_instructions: string;
  skills: string;
}

/** 变量白名单：只允许这些占位符；未知变量原样保留 + 回报（不阻断） */
const KNOWN_VARS = [
  "diy_cli",
  "diy_home",
  "project_path",
  "task_uri",
  "task_title",
  "task_state",
  "task_body",
  "task_dir",
  "cwd",
  "cwd_note",
  "project_instructions",
  "skills",
] as const;

/**
 * 系统上下文预算（字节）。
 *
 * 与模型上下文窗口挂钩（原来是一个 64KB 魔法数）：预算 = min(硬上限, 上下文窗口 × 份额)，
 * 份额取 5% —— 系统提示词只是上下文里的一部分，还要留出会话历史、工具结果与输出。
 * 小窗口模型（如 256k）因此拿到更小的预算，大窗口模型封顶在 64KB。
 */
export const SYSTEM_BUDGET_CAP_BYTES = 64 * 1024;
/** 系统提示词占上下文窗口的比例（5%） */
export const SYSTEM_BUDGET_CONTEXT_SHARE = 0.05;
/** 模型上下文窗口未知时的预算（等于硬上限，保持旧行为） */
export const DEFAULT_SYSTEM_BUDGET_BYTES = SYSTEM_BUDGET_CAP_BYTES;

/** 由模型上下文窗口（tokens）推导系统上下文预算（字节）；未知则用默认值 */
export function systemBudgetForContext(contextLimitTokens?: number): number {
  if (!contextLimitTokens || !Number.isFinite(contextLimitTokens) || contextLimitTokens <= 0) {
    return DEFAULT_SYSTEM_BUDGET_BYTES;
  }
  const bytes = Math.floor(contextLimitTokens * 4 * SYSTEM_BUDGET_CONTEXT_SHARE); // 粗估 1 token ≈ 4 字节
  return Math.max(16 * 1024, Math.min(SYSTEM_BUDGET_CAP_BYTES, bytes));
}

const FM_SEP = "---";

function parseMd(raw: string): { meta: PromptMeta; body: string } {
  const fallback: PromptMeta = {
    title: "",
    desc: "",
    version: 1,
    overridable: true,
    tip: "",
    tag: "",
    fragment: false,
  };
  if (!raw.startsWith(FM_SEP)) return { meta: fallback, body: raw };
  const end = raw.indexOf(FM_SEP, 3);
  if (end === -1) return { meta: fallback, body: raw };
  let front: Record<string, unknown> = {};
  try {
    front = (yaml.load(raw.slice(3, end).trim() || "{}") as Record<string, unknown>) ?? {};
  } catch {
    return { meta: fallback, body: raw.slice(end + 3).trim() };
  }
  const ov = front["overridable"] as { value?: unknown; tip?: unknown } | undefined;
  return {
    meta: {
      title: String(front["title"] ?? ""),
      desc: String(front["desc"] ?? ""),
      version: Number(front["version"] ?? 1),
      overridable: ov?.value !== false,
      tip: String(ov?.tip ?? ""),
      tag: String(front["tag"] ?? ""),
      fragment: front["fragment"] === true,
    },
    body: raw.slice(end + 3).trim() + "\n",
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
  if (!cur.overridable) throw new Error(`模版 ${relpath} 不可覆盖：${cur.tip}`);
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

/** 模版内的 {{var}} 渲染：白名单内替换，未知原样保留并计数（返回 unknown 供 UI 提示）。
 *  extra / known：片段模版自己的变量（如 _chain.md 的 path/scope/content）不许污染节模版的白名单。 */
export function renderTemplate(
  body: string,
  vars: AssembleVars,
  opts: { extra?: Record<string, string>; known?: readonly string[] } = {},
): { text: string; unknown: string[] } {
  const map = { ...(vars as unknown as Record<string, string>), ...(opts.extra ?? {}) };
  const allowed = new Set<string>([...(KNOWN_VARS as readonly string[]), ...(opts.known ?? [])]);
  const unknown = new Set<string>();
  const text = body.replace(/\{\{\s*([\w]+)\s*\}\}/g, (m, k: string) => {
    if (allowed.has(k)) return map[k] ?? "";
    unknown.add(k);
    return m;
  });
  return { text, unknown: [...unknown] };
}

/**
 * 工作目录解析：唯一实现在 core/cwd.ts（工具 cwd 与提示词里的「工作目录」必须同源，
 * 否则模型按提示词的相对路径操作就会操作错地方）。本文件只消费它的 note。
 */

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

/** AGENTS.md 链片段模版（frontmatter fragment: true）；可覆盖 → 改模版即改链的呈现 */
export const CHAIN_FRAGMENT = "_chain.md";
/** 片段模版缺失/为空的兜底包裹（与历史行为一致） */
const DEFAULT_CHAIN_WRAPPER = `<project_instructions path="{{path}}" scope="{{scope}}">\n{{content}}\n</project_instructions>`;

/**
 * AGENTS.md 链：从工作目录逐层向上，外层在前、最深处在后。
 * - 只看标准 AGENTS.md
 * - 排除任务本体（tasks/<tid>/AGENTS.md 是任务正文，已由 300-task 渲染）
 * - **上界 = $HOME**（不进 /、不进 /Users）：家里那几层（~/AGENTS.md、~/git/AGENTS.md …）
 *   是用户指定的全局规则与信息，就是要逐层生效到每个任务；缺了它们反而要靠模型猜。
 *   代价是体积（实测一条链 ~10KB），靠 64KB 预算与「链上有哪些文件」的可观测性兜底。
 * - 工作目录不在 $HOME 内时才只取该目录自身一层（不猜外部目录树的约定）
 * - 另加 $DIY_HOME/AGENTS.md 作为应用级规范（存在才加）
 */
function projectInstructions(home: string, projectId: string, cwd: string, taskUri: string): string {
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
  // 每层的包裹格式也来自模版（_chain.md 片段，变量 path/scope/content）：
  // 改模版即改链的呈现（以前这段 markup 硬编码在代码里，用户在模版里找不到）。
  const tpl = entryOf(home, projectId, CHAIN_FRAGMENT).current || DEFAULT_CHAIN_WRAPPER;
  return files
    .map((fp) => {
      const content = readFileSync(fp, "utf-8").trim();
      const r = renderTemplate(tpl, {} as AssembleVars, { known: ["path", "scope", "content"], extra: { path: fp, scope: dirname(fp), content } });
      return r.text.trim();
    })
    .join("\n\n");
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
    skills?: string;
    drafts?: Record<string, string>;
    diyCli?: string;
    contextLimitTokens?: number;
  } = {},
): AssembledSystem {
  const taskUri = opts.taskUri ?? "";
  const task = taskOf(home, taskUri);
  const { cwd, note } = resolveCwd(home, taskUri);
  // CLI 入口走 runtime 契约（不做裸 process.env 读）——prompt-registry 是 main 侧模块，可直接读
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
  const vars: AssembleVars = {
    diy_cli: diyCli || "diy（未注入 DIY_CLI，勿照抄）",
    diy_home: home,
    project_path: getProjectPath(projectId) ?? "",
    task_uri: taskUri,
    task_title: task?.title ?? "",
    task_state: task?.state ?? "",
    task_body: task?.body ?? "",
    task_dir: taskUri ? join(home, taskUri) : "",
    cwd,
    cwd_note: note,
    project_instructions: projectInstructions(home, projectId, cwd, taskUri),
    skills: opts.skills ?? "",
  };
  const unknown = new Set<string>();
  const blocks: string[] = [];
  for (const relpath of Object.keys(PROMPT_DEFAULTS)) {
    const entry = entryOf(home, projectId, relpath);
    if (entry.fragment) continue; // 片段模版不进节拼接（由引用它的变量渲染）
    const body = opts.drafts?.[relpath] ?? entry.current;
    const r = renderTemplate(body, vars);
    r.unknown.forEach((u) => unknown.add(u));
    if (!r.text.trim()) continue; // 空节不进请求
    // 包裹标签由模版 frontmatter 的 tag 声明（空串 = 裸文本节）
    const tag = entry.tag;
    blocks.push(tag ? `<${tag}>\n${r.text.trim()}\n</${tag}>` : r.text.trim());
  }
  const system = blocks.join("\n\n");
  const used = Buffer.byteLength(system, "utf-8");
  const budget = systemBudgetForContext(opts.contextLimitTokens);
  return {
    system,
    unknownVars: [...unknown],
    overBudget: used > budget ? { used, budget } : null,
    warnings,
  };
}
