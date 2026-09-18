// src/main/services/prompt-registry.ts
// 🎯 提示词模版注册表（spike）：内置只读 + 项目级同路径覆盖 + dry-run 预览
//
//   内置: prompts/defaults.ts（随版本走）
//   覆盖: $DIY_HOME/projects/<id>/template/<relpath>（与 tasks/ 同级，listTasks 只扫 tasks/数字目录）
//   元数据: template/.meta.yaml {<relpath>: {baseVersion}}（save 时记内置版本，供 stale 判定）
// 解析 = 覆盖存在 ? 覆盖 : 内置；状态只有 builtin | overridden。
// 本模块只做组装与渲染，不发任何 LLM 请求（试验场试跑 = dry-run，看请求长什么样）。

import * as yaml from "js-yaml";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { PROMPT_DEFAULTS } from "../prompts/defaults";
import { diyHome } from "../core/state";
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

export interface PreviewVars {
  cwd: string;
  project_path: string;
  project_label: string;
  task_uri: string;
  model: string;
  maxSteps: number;
  maxOutputTokens: number;
  skills: string;
}

/** 变量白名单：只允许标量占位，未知变量原样保留 + 计数（不阻断） */
const KNOWN_VARS = [
  "cwd",
  "project_path",
  "project_label",
  "task_uri",
  "model",
  "maxSteps",
  "maxOutputTokens",
  "skills",
] as const;

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
export function renderTemplate(body: string, vars: PreviewVars): { text: string; unknown: string[] } {
  const map: Record<string, string> = {
    cwd: vars.cwd,
    project_path: vars.project_path,
    project_label: vars.project_label,
    task_uri: vars.task_uri,
    model: vars.model,
    maxSteps: String(vars.maxSteps),
    maxOutputTokens: String(vars.maxOutputTokens),
    skills: vars.skills,
  };
  const unknown = new Set<string>();
  const text = body.replace(/\{\{\s*([\w]+)\s*\}\}/g, (m, k: string) => {
    if ((KNOWN_VARS as readonly string[]).includes(k)) return map[k] ?? "";
    unknown.add(k);
    return m;
  });
  return { text, unknown: [...unknown] };
}

export interface RequestPreview {
  system: string;
  unknownVars: string[];
  tools: Array<{ name: string; description: string }>;
  settings: { maxSteps: number; maxOutputTokens: number; maxRetries: number };
  headers: { session: string };
  cwd: string;
  note: string;
}

/**
 * dry-run 请求预览：只组装不发送（试验场核心）。
 * vars 允许调用方覆盖 params（调参即改即看，不写 limits.json）。
 */
export function previewRequest(
  home: string,
  projectId: string,
  opts: {
    taskUri?: string;
    model?: string;
    maxSteps?: number;
    maxOutputTokens?: number;
    skills?: string;
    /** 未存盘草稿（relpath → 正文）：命中则替存盘值，用于所见即所得，加法字段不改模型 */
    drafts?: Record<string, string>;
  } = {},
): RequestPreview {
  const bodyOf = (r: string): string => opts.drafts?.[r] ?? entryOf(home, projectId, r).current;
  const system = bodyOf("system.md");
  const context = bodyOf("context.md");
  const bash = bodyOf("tools/bash.md");
  const read = bodyOf("tools/read.md");
  const rawPath = getProjectPath(projectId);
  const cwd =
    rawPath && existsSync(rawPath.startsWith("~/") ? join(home, "..", rawPath.slice(2)) : rawPath)
      ? rawPath
      : process.cwd();
  const vars: PreviewVars = {
    cwd,
    project_path: rawPath ?? "",
    project_label: projectId,
    task_uri: opts.taskUri ?? "",
    model: opts.model ?? "mimo-v2.5",
    maxSteps: opts.maxSteps ?? 60,
    maxOutputTokens: opts.maxOutputTokens ?? 4000,
    skills: opts.skills ?? "",
  };
  const r1 = renderTemplate(`${system}\n${context}`, vars);
  return {
    system: r1.text,
    unknownVars: r1.unknown,
    tools: [
      { name: "bash", description: bash.trim() },
      { name: "read", description: read.trim() },
    ],
    settings: { maxSteps: vars.maxSteps, maxOutputTokens: vars.maxOutputTokens, maxRetries: 2 },
    headers: { session: `local-preview-${projectId}` },
    cwd,
    note: "dry-run：仅构造，未发送；试跑 agent 暂不执行工具",
  };
}

/** 默认 home 快捷入口（main 进程用） */
export function promptsFor(projectId: string): PromptEntry[] {
  return listPrompts(diyHome(), projectId);
}
