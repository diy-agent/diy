// src/main/services/prompt-registry.ts
// 🎯 提示词模版注册表：内置只读 + 项目级同路径覆盖 + 装配渲染 + dry-run 预览
//
//   内置: prompts/defaults.ts（随版本走）
//   覆盖: $DIY_HOME/projects/<id>/template/<relpath>（与 tasks/ 同级，listTasks 只扫 tasks/ 数字目录）
//   元数据: template/.meta.yaml {<relpath>: {baseVersion}}（save 时记内置版本，供 stale 判定）
// 解析 = 覆盖存在 ? 覆盖 : 内置；状态只有 builtin | overridden。
// 装配 = 按 PROMPT_DEFAULTS 的键序拼接（文件名前缀定序），非 identity 节包同名标签，空节不进请求。
// 本模块只做组装与渲染，不发任何 LLM 请求（试验场试跑 = dry-run，看请求长什么样）。

import * as yaml from "js-yaml";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { PROMPT_DEFAULTS } from "../prompts/defaults";
import { diyHome, parseTaskFile } from "../core/state";
import { getProjectPath } from "../core/project";

export interface PromptMeta {
  title: string;
  desc: string;
  version: number;
  overridable: boolean;
  /** 不可覆盖时的禁用按钮 tooltip；可覆盖时为空串 */
  tip: string;
}

export interface PromptEntry extends PromptMeta {
  relpath: string;
  /** builtin | overridden（覆盖文件是否存在） */
  status: "builtin" | "overridden";
  /** 当前生效正文（覆盖 ?? 内置，已渲染变量前） */
  current: string;
  /** 内置正文（对比/diff 用） */
  builtin: string;
  /** 保存覆盖时的内置版本（stale 判定：baseVersion !== builtinVersion） */
  baseVersion: number | null;
  stale: boolean;
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

/** 节标签：文件名 → 包裹标签。identity 不包（整段替换，无需按名引用） */
const SECTION_TAGS: Record<string, string> = {
  "100-diy.md": "diy",
  "200-project.md": "project_context",
  "300-task.md": "task",
  "400-rules.md": "rules",
  "500-skills.md": "skills",
  "_guard.md": "guard",
};

/** 系统上下文预算（字节）。超限即拒绝发送，不做自动截断。
 *  TODO: 与模型上下文窗口挂钩（LOCAL_MODELS 目前只有 maxOutputTokens，需补 limit.context） */
const SYSTEM_BUDGET_BYTES = 64 * 1024;

const FM_SEP = "---";

function parseMd(raw: string): { meta: PromptMeta; body: string } {
  const fallback: PromptMeta = { title: "", desc: "", version: 1, overridable: true, tip: "" };
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
    },
    body: raw.slice(end + 3).trim() + "\n",
  };
}

/** relpath 白名单校验：只允许 manifest（PROMPT_DEFAULTS key）内条目，防 ../ 穿越 */
export function assertRelpath(relpath: string): void {
  const n = normalize(relpath);
  if (!(n in PROMPT_DEFAULTS) || n.startsWith("..") || n.includes("\0")) {
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

function writeMeta(home: string, projectId: string, meta: Record<string, { baseVersion: number }>): void {
  mkdirSync(templateDir(home, projectId), { recursive: true });
  writeFileSync(metaPath(home, projectId), yaml.dump(meta, { indent: 2, noRefs: true }), "utf-8");
}

function entryOf(home: string, projectId: string, relpath: string): PromptEntry {
  assertRelpath(relpath);
  const { meta, body } = parseMd(PROMPT_DEFAULTS[relpath]!);
  const fp = join(templateDir(home, projectId), relpath);
  const hasOverride = existsSync(fp);
  const current = hasOverride ? readFileSync(fp, "utf-8") : body;
  const metaAll = readMeta(home, projectId);
  const baseVersion = metaAll[relpath]?.baseVersion ?? null;
  return {
    ...meta,
    relpath,
    status: hasOverride ? "overridden" : "builtin",
    current,
    builtin: body,
    baseVersion,
    stale: hasOverride && baseVersion !== null && baseVersion !== meta.version,
  };
}

/** 列出全部模版（含状态/元数据，供树展示） */
export function listPrompts(home: string, projectId: string): PromptEntry[] {
  return Object.keys(PROMPT_DEFAULTS).map((r) => entryOf(home, projectId, r));
}

/** 取单份模版（含内置/当前/stale，供查看与编辑） */
export function getPrompt(home: string, projectId: string, relpath: string): PromptEntry {
  return entryOf(home, projectId, relpath);
}

/** 保存项目级覆盖（存正文 + sidecar 记内置版本）。不可覆盖的直接抛错。 */
export function savePrompt(home: string, projectId: string, relpath: string, content: string): PromptEntry {
  const cur = entryOf(home, projectId, relpath);
  if (!cur.overridable) throw new Error(`模版 ${relpath} 不可覆盖：${cur.tip}`);
  const fp = join(templateDir(home, projectId), relpath);
  mkdirSync(join(fp, ".."), { recursive: true });
  writeFileSync(fp, content, "utf-8");
  const metaAll = readMeta(home, projectId);
  metaAll[relpath] = { baseVersion: cur.version };
  writeMeta(home, projectId, metaAll);
  return entryOf(home, projectId, relpath);
}

/** 一键恢复（删覆盖文件 + 清 sidecar，幂等） */
export function restorePrompt(home: string, projectId: string, relpath: string): PromptEntry {
  assertRelpath(relpath);
  rmSync(join(templateDir(home, projectId), relpath), { force: true });
  const metaAll = readMeta(home, projectId);
  delete metaAll[relpath];
  writeMeta(home, projectId, metaAll);
  return entryOf(home, projectId, relpath);
}

/** 渲染 {{var}}：白名单内替换，未知原样保留并计数（返回 unknown 供 UI 提示） */
export function renderTemplate(body: string, vars: AssembleVars): { text: string; unknown: string[] } {
  const map = vars as unknown as Record<string, string>;
  const unknown = new Set<string>();
  const text = body.replace(/\{\{\s*([\w]+)\s*\}\}/g, (m, k: string) => {
    if ((KNOWN_VARS as readonly string[]).includes(k)) return map[k] ?? "";
    unknown.add(k);
    return m;
  });
  return { text, unknown: [...unknown] };
}

/**
 * 工作目录解析（三级兜底：项目目录 → 任务目录 → 应用目录）。
 * 与 local-agent 的工具 cwd 保持一致；不一致时给出提示 —— 模型按错的目录理解相对路径就读不到文件。
 * TODO: 与 local-agent.resolveCwd 合并为一处实现（现为镜像逻辑，避免模块循环依赖）
 */
function resolveWorkingDir(home: string, projectId: string, taskUri: string): { cwd: string; note: string } {
  const declared = getProjectPath(projectId);
  if (declared) {
    const abs = declared.startsWith("~/") ? join(homedir(), declared.slice(2)) : declared;
    if (existsSync(abs)) return { cwd: abs, note: "" };
  }
  const td = taskUri ? join(home, taskUri) : "";
  if (td && existsSync(td)) {
    return { cwd: td, note: "\n注意：项目目录不存在，工具实际在任务目录下执行" };
  }
  return { cwd: process.cwd(), note: "\n注意：项目目录与任务目录都不存在，工具实际在应用目录下执行" };
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
 * AGENTS.md 链：从工作目录向上收到 home 为止（不进 / 、不进 /Users），外层在前、最深处在后。
 * - 只看标准 AGENTS.md
 * - 排除任务本体（tasks/<tid>/AGENTS.md 是任务正文，已由 300-task 渲染）
 * - 工作目录不在 home 内时只取该目录自身一层（不猜测外部目录树的约定）
 * - 另加 $DIY_HOME/AGENTS.md 作为应用级规范（存在才加）
 */
function projectInstructions(home: string, cwd: string, taskUri: string): string {
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
  return files
    .map((fp) => {
      const content = readFileSync(fp, "utf-8").trim();
      return `<project_instructions path="${fp}" scope="${dirname(fp)}">\n${content}\n</project_instructions>`;
    })
    .join("\n\n");
}

export interface AssembledSystem {
  system: string;
  unknownVars: string[];
  /** 非空即超预算：拒绝发送（本层不做自动截断/剔除） */
  overBudget: { used: number; budget: number } | null;
}

/**
 * 装配系统上下文（真发与预览共用同一入口）。
 * drafts 允许覆盖未存盘草稿（relpath → 正文），做到所见即所得。
 */
export function assembleSystem(
  home: string,
  projectId: string,
  opts: { taskUri?: string; skills?: string; drafts?: Record<string, string> } = {},
): AssembledSystem {
  const taskUri = opts.taskUri ?? "";
  const task = taskOf(home, taskUri);
  const { cwd, note } = resolveWorkingDir(home, projectId, taskUri);
  const vars: AssembleVars = {
    diy_cli: process.env["DIY_CLI"] ?? "diy",
    diy_home: home,
    project_path: getProjectPath(projectId) ?? "",
    task_uri: taskUri,
    task_title: task?.title ?? "",
    task_state: task?.state ?? "",
    task_body: task?.body ?? "",
    task_dir: taskUri ? join(home, taskUri) : "",
    cwd,
    cwd_note: note,
    project_instructions: projectInstructions(home, cwd, taskUri),
    skills: opts.skills ?? "",
  };
  const unknown = new Set<string>();
  const blocks: string[] = [];
  for (const relpath of Object.keys(PROMPT_DEFAULTS)) {
    const body = opts.drafts?.[relpath] ?? entryOf(home, projectId, relpath).current;
    const r = renderTemplate(body, vars);
    r.unknown.forEach((u) => unknown.add(u));
    if (!r.text.trim()) continue; // 空节不进请求
    const tag = SECTION_TAGS[relpath];
    blocks.push(tag ? `<${tag}>\n${r.text.trim()}\n</${tag}>` : r.text.trim());
  }
  const system = blocks.join("\n\n");
  const used = Buffer.byteLength(system, "utf-8");
  return {
    system,
    unknownVars: [...unknown],
    overBudget: used > SYSTEM_BUDGET_BYTES ? { used, budget: SYSTEM_BUDGET_BYTES } : null,
  };
}

/** 默认 home 快捷入口（main 进程用） */
export function promptsFor(projectId: string): PromptEntry[] {
  return listPrompts(diyHome(), projectId);
}
