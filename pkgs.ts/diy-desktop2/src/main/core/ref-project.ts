// src/main/core/ref-project.ts
// 🎯 项目边界检测 — lock file 驱动，三级降级
//
// 三级优先级（从 cwd 向上遍历，命中即停）：
//   情况 A — 有 py/node 项目：
//     第一个 uv.lock 或 package-lock.json → 项目根
//     diy.yaml 配置附属于项目，不参与边界判定
//   情况 B — 无 py/node 项目（纯 diy 项目）：
//     第一个 diy.yaml → 项目根（.git 硬边界）
//   情况 C — 都没有 → 报错
//
// 子目录的 diy.yaml 永不搜索/聚合（diy.yaml 无 workspace 语义）

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import * as yaml from "js-yaml";

// ═══════════════════════════════════════
// 类型
// ═══════════════════════════════════════

export type ProjectKind = "python" | "node" | "mixed" | "diy";

export interface WorkspaceInfo {
  /** 包名（来自 pyproject.toml name 或 package.json name） */
  name: string;
  /** 绝对路径 */
  path: string;
  /** 相对项目根的路径 */
  relativePath: string;
  /** 技术栈 */
  kind: "python" | "node";
}

export interface ProjectRoot {
  /** 项目根目录绝对路径 */
  rootDir: string;
  /** 项目类型 */
  kind: ProjectKind;
  /** workspace 子项目列表（standalone 项目含自身） */
  workspaces: WorkspaceInfo[];
  /** lock 文件路径（diy 项目为 null） */
  lockFile: string | null;
}

/** ref 配置（来自 diy.yaml） */
export interface RefConfig {
  source: string[];
  python: { include: string[]; exclude: string[] };
  node: { include: string[]; exclude: string[] };
}

// ═══════════════════════════════════════
// 三级边界检测
// ═══════════════════════════════════════

/**
 * 检测项目边界。从 cwd 向上遍历，返回命中的第一个项目根信息。
 */
export function findProjectRoot(cwd?: string): ProjectRoot {
  const start = resolve(cwd ?? process.cwd());
  let diyRoot: string | null = null;

  for (const dir of walkUp(start)) {
    // 情况 A：lock file 驱动
    const uvLock = join(dir, "uv.lock");
    const pkgLock = join(dir, "package-lock.json");

    if (existsSync(uvLock) || existsSync(pkgLock)) {
      return buildProjectRoot(dir);
    }

    // 情况 B 预备：记录第一个 diy.yaml 的位置
    if (diyRoot === null && existsSync(join(dir, "diy.yaml"))) {
      diyRoot = dir;
    }

    // .git 硬边界
    if (existsSync(join(dir, ".git"))) break;
    // 文件系统根
    if (dir === dirname(dir)) break;
  }

  // 情况 B
  if (diyRoot !== null) {
    return { rootDir: diyRoot, kind: "diy", workspaces: [], lockFile: null };
  }

  // 情况 C
  throw new Error(
    "未找到项目根 — 当前目录没有 uv.lock / package-lock.json / diy.yaml。\n" +
      "提示：在 pyproject.toml 或 package.json 所在目录运行，或创建 diy.yaml。",
  );
}

function buildProjectRoot(dir: string): ProjectRoot {
  const hasPython = existsSync(join(dir, "uv.lock"));
  const hasNode = existsSync(join(dir, "package-lock.json"));
  const kind: ProjectKind =
    hasPython && hasNode ? "mixed" : hasPython ? "python" : "node";

  return {
    rootDir: dir,
    kind,
    workspaces: resolveAllWorkspaces(dir, kind),
    lockFile: hasPython ? join(dir, "uv.lock") : join(dir, "package-lock.json"),
  };
}

// ═══════════════════════════════════════
// workspace 解析
// ═══════════════════════════════════════

function resolveAllWorkspaces(
  rootDir: string,
  kind: ProjectKind,
): WorkspaceInfo[] {
  const result: WorkspaceInfo[] = [];

  if (kind === "python" || kind === "mixed") {
    result.push(...resolvePythonWorkspaces(rootDir));
  }
  if (kind === "node" || kind === "mixed") {
    result.push(...resolveNodeWorkspaces(rootDir));
  }

  // standalone: 至少返回自身
  if (result.length === 0) {
    const name = basename(rootDir);
    result.push({ name, path: rootDir, relativePath: ".", kind: "python" });
  }

  return result;
}

function resolvePythonWorkspaces(rootDir: string): WorkspaceInfo[] {
  const pyproject = join(rootDir, "pyproject.toml");
  if (!existsSync(pyproject)) return [];

  try {
    const data = parseTomlLite(readFileSync(pyproject, "utf-8"));
    const members = dig<string[]>(data, "tool", "uv", "workspace", "members");
    const rootName = dig<string>(data, "project", "name");

    if (!members || members.length === 0) {
      return [
        {
          name: rootName ?? basename(rootDir),
          path: rootDir,
          relativePath: ".",
          kind: "python" as const,
        },
      ];
    }

    // monorepo: 展开 glob
    const result: WorkspaceInfo[] = [];
    const seen = new Set<string>();
    for (const pattern of members) {
      for (const p of expandGlob(rootDir, pattern)) {
        if (seen.has(p)) continue;
        seen.add(p);
        const pkgPyproject = join(p, "pyproject.toml");
        let name = basename(p);
        if (existsSync(pkgPyproject)) {
          try {
            const pkgData = parseTomlLite(readFileSync(pkgPyproject, "utf-8"));
            name = dig<string>(pkgData, "project", "name") ?? name;
          } catch {
            // use dir basename
          }
        }
        result.push({
          name,
          path: p,
          relativePath: relative(rootDir, p) || ".",
          kind: "python" as const,
        });
      }
    }
    return result;
  } catch {
    return [];
  }
}

function resolveNodeWorkspaces(rootDir: string): WorkspaceInfo[] {
  const pkgJson = join(rootDir, "package.json");
  if (!existsSync(pkgJson)) return [];

  try {
    const data = JSON.parse(readFileSync(pkgJson, "utf-8"));
    const workspaces = data.workspaces as string[] | undefined;
    const rootName = data.name as string | undefined;

    if (!workspaces || workspaces.length === 0) {
      return [
        {
          name: rootName ?? basename(rootDir),
          path: rootDir,
          relativePath: ".",
          kind: "node" as const,
        },
      ];
    }

    const result: WorkspaceInfo[] = [];
    const seen = new Set<string>();
    for (const pattern of workspaces) {
      for (const p of expandGlob(rootDir, pattern)) {
        if (seen.has(p)) continue;
        seen.add(p);
        const childPkg = join(p, "package.json");
        let name = basename(p);
        if (existsSync(childPkg)) {
          try {
            const childData = JSON.parse(readFileSync(childPkg, "utf-8"));
            name = childData.name ?? name;
          } catch {
            // use dir basename
          }
        }
        result.push({
          name,
          path: p,
          relativePath: relative(rootDir, p) || ".",
          kind: "node" as const,
        });
      }
    }
    return result;
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════
// Scope 判定
// ═══════════════════════════════════════

/**
 * 从当前工作目录判定所属 scope。
 * 返回 workspace 的 name（即 package.json 或 pyproject.toml 的 name 字段）。
 * 如果 cwd 是 monorepo 根目录，返回根项目的 name。
 * standalone 项目返回其 name。
 */
export function detectCurrentScope(
  cwd: string,
  root: ProjectRoot,
): string | null {
  if (root.workspaces.length === 0) return null;

  const absCwd = resolve(cwd);

  let best: WorkspaceInfo | null = null;
  for (const ws of root.workspaces) {
    if (absCwd === ws.path || absCwd.startsWith(ws.path + "/")) {
      if (!best || ws.path.length > best.path.length) {
        best = ws;
      }
    }
  }

  return best?.name ?? null;
}

// ═══════════════════════════════════════
// diy.yaml ref 配置读取
// ═══════════════════════════════════════

const EMPTY_REF_CONFIG: RefConfig = {
  source: [],
  python: { include: [], exclude: [] },
  node: { include: [], exclude: [] },
};

/**
 * 读取 diy.yaml 的 ref 配置。
 * 情况 A（有 lock file）：从项目根 + cwd 子项目目录查找
 * 情况 B（纯 diy）：diy.yaml 本身就是项目边界
 * 子目录的 diy.yaml 不搜索。
 */
export function loadRefConfig(root: ProjectRoot, cwd?: string): RefConfig {
  const candidates: string[] = [];

  // 先试 cwd（子项目可能有自己的 diy.yaml）
  if (cwd) {
    const absCwd = resolve(cwd);
    if (absCwd !== root.rootDir) candidates.push(absCwd);
  }

  // 再试项目根
  candidates.push(root.rootDir);

  // 对情况 A，也查根的上层目录（配置可能在 monorepo 外层）
  if (root.kind !== "diy") {
    for (const dir of walkUp(root.rootDir)) {
      if (dir === root.rootDir) continue;
      if (existsSync(join(dir, ".git"))) break;
      candidates.push(dir);
      if (dir === dirname(dir)) break;
    }
  }

  for (const dir of candidates) {
    const config = readDiyYaml(dir);
    if (config) return config;
  }

  return EMPTY_REF_CONFIG;
}

function readDiyYaml(dir: string): RefConfig | null {
  const yamlPath = join(dir, "diy.yaml");
  if (!existsSync(yamlPath)) return null;

  try {
    const data = yaml.load(readFileSync(yamlPath, "utf-8")) as any;
    const ref = data?.ref;
    if (!ref) return null;

    return {
      source: Array.isArray(ref.source) ? ref.source : [],
      python: {
        include: Array.isArray(ref.python?.include) ? ref.python.include : [],
        exclude: Array.isArray(ref.python?.exclude) ? ref.python.exclude : [],
      },
      node: {
        include: Array.isArray(ref.node?.include) ? ref.node.include : [],
        exclude: Array.isArray(ref.node?.exclude) ? ref.node.exclude : [],
      },
    };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════
// 极简 TOML 解析（仅 [project] name + [tool.uv.workspace] members）
// ═══════════════════════════════════════

function parseTomlLite(src: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let current: Record<string, unknown> = result;
  const path: string[] = [];

  for (const raw of src.split("\n")) {
    const line = raw.trim();
    // skip comments and blanks
    if (!line || line.startsWith("#")) continue;

    // section header: [section] or [section.sub]
    const secMatch = line.match(/^\[([^\]]+)\]$/);
    if (secMatch) {
      const keys = secMatch[1]!.split(".");
      current = result;
      path.length = 0;
      for (const k of keys) {
        const clean = k.trim();
        path.push(clean);
        let next = current[clean];
        if (typeof next !== "object" || next === null) {
          next = {};
          current[clean] = next;
        }
        current = next as Record<string, unknown>;
      }
      continue;
    }

    // key = value
    const kvMatch = line.match(/^([^=]+)=\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1]!.trim();
      const rawVal = kvMatch[2]!.trim();
      current[key] = parseTomlValue(rawVal);
    }
  }

  return result;
}

function parseTomlValue(raw: string): unknown {
  // string: "..." or '...'
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  // bool
  if (raw === "true") return true;
  if (raw === "false") return false;
  // integer
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  // float
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
  // array: ["a", "b"]
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((s) => {
        const t = s.trim();
        if (
          (t.startsWith('"') && t.endsWith('"')) ||
          (t.startsWith("'") && t.endsWith("'"))
        ) {
          return t.slice(1, -1);
        }
        return t;
      });
  }
  return raw;
}

/** 深度访问嵌套对象 */
function dig<T>(obj: unknown, ...keys: string[]): T | undefined {
  let cur: any = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur as T | undefined;
}

// ═══════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════

function* walkUp(start: string): Generator<string> {
  let dir = resolve(start);
  while (true) {
    yield dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

/** 极简 glob 展开：支持 `pkgs/*` 和 `pkgs.py/*` 模式 */
function expandGlob(root: string, pattern: string): string[] {
  const starIdx = pattern.indexOf("*");
  if (starIdx === -1) {
    const full = join(root, pattern);
    return existsSync(full) ? [full] : [];
  }

  const prefix = pattern.slice(0, starIdx);
  const suffix = pattern.slice(starIdx + 1);
  const base = join(root, prefix);

  if (!existsSync(base)) return [];

  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => !suffix || d.name.endsWith(suffix))
      .map((d) => join(base, d.name))
      .filter(
        (p) =>
          existsSync(join(p, "pyproject.toml")) ||
          existsSync(join(p, "package.json")),
      );
  } catch {
    return [];
  }
}
