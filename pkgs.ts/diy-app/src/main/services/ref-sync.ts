// src/main/services/ref-sync.ts
// 🎯 ref sync 引擎 — 依赖收集 + git clone 并发
//
// 流程：
//   1. 检测项目根 + scope
//   2. 从 pyproject.toml / package.json 收集依赖
//   3. 应用 diy.yaml include/exclude 过滤
//   4. 解析 git URL（内置映射表 + npm/PyPI API 按需查询）
//   5. 并发 git clone → ~/.diy/ref/
//   6. 写 ref.lock.yaml v5

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import * as yaml from "js-yaml";
import { findProjectRoot, detectCurrentScope, loadRefConfig } from "../core/ref-project";
import { diyHome } from "../core/state";
import type { ProjectRoot, WorkspaceInfo, RefConfig } from "../core/ref-project";
import type { RefLockV5 } from "../core/ref";

// ═══════════════════════════════════════
// 类型
// ═══════════════════════════════════════

export interface SyncOptions {
  /** 强制 sync 所有 scope（在子项目内也 sync 全 monorepo） */
  all?: boolean;
  /** 指定 scope 名称 */
  scope?: string;
  /** 并发克隆数 */
  concurrency?: number;
}

export interface DepInfo {
  name: string;
  version: string;
  scope: string;
  eco: "python" | "node";
  category: string; // dependencies | dev-dependencies | dependency-groups:xxx
}

export interface ResolvedDep extends DepInfo {
  gitUrl: string;
  destPath: string;
}

export interface SyncResult {
  total: number;
  cloned: number;
  skipped: number;
  failed: number;
  errors: string[];
}

// ═══════════════════════════════════════
// 内置 git URL 映射（常用包）
// ═══════════════════════════════════════

const KNOWN_REPOS: Record<string, string> = {
  // Python
  "cyclopts": "https://github.com/BrianPugh/cyclopts",
  "rich": "https://github.com/Textualize/rich",
  "typer": "https://github.com/fastapi/typer",
  "pydantic": "https://github.com/pydantic/pydantic",
  "fastapi": "https://github.com/fastapi/fastapi",
  "httpx": "https://github.com/encode/httpx",
  "click": "https://github.com/pallets/click",
  "flask": "https://github.com/pallets/flask",
  "requests": "https://github.com/psf/requests",
  "pytest": "https://github.com/pytest-dev/pytest",
  "numpy": "https://github.com/numpy/numpy",
  "pandas": "https://github.com/pandas-dev/pandas",
  "django": "https://github.com/django/django",
  "sqlalchemy": "https://github.com/sqlalchemy/sqlalchemy",
  "alembic": "https://github.com/sqlalchemy/alembic",
  "celery": "https://github.com/celery/celery",
  "aiohttp": "https://github.com/aio-libs/aiohttp",
  "starlette": "https://github.com/encode/starlette",
  "uvicorn": "https://github.com/encode/uvicorn",
  "watchfiles": "https://github.com/samuelcolvin/watchfiles",
  "ruff": "https://github.com/astral-sh/ruff",
  "mypy": "https://github.com/python/mypy",
  "black": "https://github.com/psf/black",
  "tomli": "https://github.com/hukkin/tomli",
  "tomlkit": "https://github.com/sdispater/tomlkit",
  "pyyaml": "https://github.com/yaml/pyyaml",
  "structlog": "https://github.com/hynek/structlog",
  "trio": "https://github.com/python-trio/trio",
  "anyio": "https://github.com/agronholm/anyio",

  // Node.js
  "react": "https://github.com/facebook/react",
  "zod": "https://github.com/colinhacks/zod",
  "vite": "https://github.com/vitejs/vite",
  "tailwindcss": "https://github.com/tailwindlabs/tailwindcss",
  "vitest": "https://github.com/vitest-dev/vitest",
  "zustand": "https://github.com/pmndrs/zustand",
  "fastify": "https://github.com/fastify/fastify",
  "chokidar": "https://github.com/paulmillr/chokidar",
  "commander": "https://github.com/tj/commander.js",
  "electron": "https://github.com/electron/electron",
  "typescript": "https://github.com/microsoft/TypeScript",
  "express": "https://github.com/expressjs/express",
  "next.js": "https://github.com/vercel/next.js",
  "axios": "https://github.com/axios/axios",
  "lodash": "https://github.com/lodash/lodash",
  "vue": "https://github.com/vuejs/core",
  "angular": "https://github.com/angular/angular",
  "svelte": "https://github.com/sveltejs/svelte",
  "prisma": "https://github.com/prisma/prisma",
  "drizzle-orm": "https://github.com/drizzle-team/drizzle-orm",
  "tanstack": "https://github.com/TanStack/router",
};

// ═══════════════════════════════════════
// 主入口
// ═══════════════════════════════════════

export async function syncRefs(opts: SyncOptions = {}): Promise<SyncResult> {
  const cwd = process.cwd();
  const concurrency = opts.concurrency ?? 4;
  const log = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");

  // 1. 检测项目
  let root: ProjectRoot;
  try {
    root = findProjectRoot(cwd);
    log(`项目根: ${root.rootDir} (${root.kind})`);
  } catch (e: any) {
    return { total: 0, cloned: 0, skipped: 0, failed: 1, errors: [e.message] };
  }

  // 2. 确定 scope
  const requestedScope = opts.scope ?? null;
  const all = opts.all ?? false;
  const currentScope = detectCurrentScope(cwd, root);

  let workspaces: WorkspaceInfo[];
  if (requestedScope) {
    const ws = root.workspaces.find((w) => w.name === requestedScope);
    if (!ws) {
      return {
        total: 0, cloned: 0, skipped: 0, failed: 1,
        errors: [`scope '${requestedScope}' 不存在。可用: ${root.workspaces.map((w) => w.name).join(", ")}`],
      };
    }
    workspaces = [ws];
  } else if (all || !currentScope) {
    workspaces = root.workspaces;
  } else {
    const ws = root.workspaces.find((w) => w.name === currentScope);
    workspaces = ws ? [ws] : root.workspaces;
  }
  log(`scope: ${workspaces.map((w) => w.name).join(", ")}`);

  // 3. 加载 ref 配置
  const refConfig = loadRefConfig(root, cwd);
  if (refConfig.source.length > 0) log(`source: ${refConfig.source.length} 个`);
  if (refConfig.python.include.length > 0 || refConfig.python.exclude.length > 0)
    log(`python filter: include=${refConfig.python.include} exclude=${refConfig.python.exclude}`);
  if (refConfig.node.include.length > 0 || refConfig.node.exclude.length > 0)
    log(`node filter: include=${refConfig.node.include} exclude=${refConfig.node.exclude}`);

  // 4. 收集所有依赖
  const allDeps: DepInfo[] = [];
  for (const ws of workspaces) {
    const deps = collectDeps(ws, refConfig);
    if (deps.length > 0) log(`  ${ws.name}: ${deps.length} 个依赖`);
    allDeps.push(...deps);
  }

  // 也收集人工 source
  for (const sourceUrl of refConfig.source) {
    allDeps.push({
      name: sourceUrl,
      version: "latest",
      scope: ".",
      eco: "python" as any,
      category: "source",
    });
  }

  // 5. 解析 git URL + 去重
  log(`解析 git URL...`);
  const resolved: ResolvedDep[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  let skippedNoUrl = 0;

  for (const dep of allDeps) {
    // source URLs already have full git URL
    if (dep.category === "source") {
      const destPath = gitCloneDest(dep.name, "latest");
      const key = destPath;
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push({ ...dep, gitUrl: dep.name, destPath });
      continue;
    }

    const gitUrl = resolveGitUrl(dep.name, dep.eco);
    if (!gitUrl) {
      skippedNoUrl++;
      continue;
    }

    const destPath = gitCloneDest(gitUrl, dep.version || "latest");
    if (seen.has(destPath)) continue;
    seen.add(destPath);

    resolved.push({ ...dep, gitUrl, destPath });
  }

  if (skippedNoUrl > 0) log(`  ${skippedNoUrl} 个无 git URL，跳过`);

  // 6. 并发 clone
  log(`clone ${resolved.length} 个仓库 (并发: ${concurrency})...`);
  const result: SyncResult = {
    total: resolved.length,
    cloned: 0,
    skipped: 0,
    failed: 0,
    errors,
  };

  if (resolved.length === 0) {
    log("无需 clone");
    return result;
  }

  // 分组并发
  const chunks: ResolvedDep[][] = [];
  for (let i = 0; i < resolved.length; i += concurrency) {
    chunks.push(resolved.slice(i, i + concurrency));
  }

  for (const chunk of chunks) {
    const outcomes = await Promise.all(
      chunk.map((dep) => cloneOne(dep, log)),
    );
    for (const [idx, ok] of outcomes.entries()) {
      if (ok === true) result.cloned++;
      else if (ok === "skipped") result.skipped++;
      else {
        result.failed++;
        result.errors.push(`clone failed: ${chunk[idx]!.name}`);
      }
    }
  }

  // 7. 写 ref.lock.yaml
  await writeLockFile(root, resolved);
  log(`完成: cloned=${result.cloned} skipped=${result.skipped} failed=${result.failed}`);

  return result;
}

// ═══════════════════════════════════════
// 依赖收集
// ═══════════════════════════════════════

function collectDeps(ws: WorkspaceInfo, config: RefConfig): DepInfo[] {
  const deps: DepInfo[] = [];

  if (ws.kind === "python") {
    deps.push(...collectPythonDeps(ws, config.python));
  } else {
    deps.push(...collectNodeDeps(ws, config.node));
  }

  return deps;
}

function collectPythonDeps(
  ws: WorkspaceInfo,
  filter: { include: string[]; exclude: string[] },
): DepInfo[] {
  const pyproject = join(ws.path, "pyproject.toml");
  if (!existsSync(pyproject)) return [];

  try {
    const data = parseTomlLite(readFileSync(pyproject, "utf-8"));
    const deps: DepInfo[] = [];

    // [project] dependencies
    const projDeps = dig<string[]>(data, "project", "dependencies");
    if (projDeps) {
      for (const depStr of projDeps) {
        const { name, version } = parseDepString(depStr);
        if (matchFilter(name, filter)) {
          deps.push({
            name,
            version,
            scope: ws.name,
            eco: "python",
            category: "dependencies",
          });
        }
      }
    }

    // [dependency-groups]
    const groups = dig<Record<string, string[]>>(data, "dependency-groups");
    if (groups) {
      for (const [groupName, groupDeps] of Object.entries(groups)) {
        if (!Array.isArray(groupDeps)) continue;
        for (const depStr of groupDeps) {
          const { name, version } = parseDepString(depStr);
          if (matchFilter(name, filter)) {
            deps.push({
              name,
              version,
              scope: ws.name,
              eco: "python",
              category: `dependency-groups:${groupName}`,
            });
          }
        }
      }
    }

    return deps;
  } catch {
    return [];
  }
}

function collectNodeDeps(
  ws: WorkspaceInfo,
  filter: { include: string[]; exclude: string[] },
): DepInfo[] {
  const pkgJson = join(ws.path, "package.json");
  if (!existsSync(pkgJson)) return [];

  try {
    const data = JSON.parse(readFileSync(pkgJson, "utf-8"));
    const deps: DepInfo[] = [];

    // dependencies
    const prodDeps = data.dependencies as Record<string, string> | undefined;
    if (prodDeps) {
      for (const [name, version] of Object.entries(prodDeps)) {
        if (matchFilter(name, filter)) {
          deps.push({
            name,
            version: version.replace(/^[\^~]/, ""),
            scope: ws.name,
            eco: "node",
            category: "dependencies",
          });
        }
      }
    }

    // devDependencies
    const devDeps = data.devDependencies as Record<string, string> | undefined;
    if (devDeps) {
      for (const [name, version] of Object.entries(devDeps)) {
        if (matchFilter(name, filter)) {
          deps.push({
            name,
            version: version.replace(/^[\^~]/, ""),
            scope: ws.name,
            eco: "node",
            category: "dev-dependencies",
          });
        }
      }
    }

    return deps;
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════
// git URL 解析
// ═══════════════════════════════════════

function resolveGitUrl(pkgName: string, eco: "python" | "node"): string | null {
  // 1. 内置映射
  const known = KNOWN_REPOS[pkgName];
  if (known) return known;

  // 2. scoped npm packages (e.g. @diy/rpc, @fastify/cors)
  if (pkgName.startsWith("@") && eco === "node") {
    const parts = pkgName.split("/");
    if (parts.length >= 2) {
      const bareName = parts[1]!;
      // try bare name in known map
      if (KNOWN_REPOS[bareName]) return KNOWN_REPOS[bareName];
    }
  }

  // 3. 按需查询 npm registry
  if (eco === "node") {
    return resolveNpmRepo(pkgName);
  }

  // 4. 按需查询 PyPI
  if (eco === "python") {
    return resolvePypiRepo(pkgName);
  }

  return null;
}

function resolveNpmRepo(pkgName: string): string | null {
  try {
    const result = execFileSync("npm", ["view", pkgName, "repository.url"], {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"], // suppress npm workspace warnings
    }).trim();
    if (result && result !== "undefined") {
      return result.replace(/^git\+/, "").replace(/\.git$/, "");
    }
    return null;
  } catch {
    return null;
  }
}

function resolvePypiRepo(pkgName: string): string | null {
  try {
    // Use curl to query PyPI JSON API
    const result = execFileSync(
      "curl",
      ["-s", "--max-time", "5", `https://pypi.org/pypi/${pkgName}/json`],
      { timeout: 7000, encoding: "utf-8" },
    );
    const data = JSON.parse(result);
    const urls = data?.info?.project_urls;
    if (urls) {
      for (const [label, url] of Object.entries(urls)) {
        const urlStr = url as string;
        if (
          urlStr.includes("github.com") &&
          (label.toLowerCase().includes("source") ||
            label.toLowerCase().includes("repository") ||
            label.toLowerCase().includes("code"))
        ) {
          return urlStr.replace(/\/$/, "");
        }
      }
    }
    // fallback: homepage
    const homepage = data?.info?.home_page;
    if (homepage && homepage.includes("github.com")) {
      return homepage.replace(/\/$/, "");
    }
    return null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════
// git clone
// ═══════════════════════════════════════

function httpsToSsh(url: string): string | null {
  const m = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/@#]+?)(?:\.git)?(?:\/)?$/);
  return m ? `git@${m[1]}:${m[2]}/${m[3]}` : null;
}

async function cloneOne(
  dep: ResolvedDep,
  log: (...args: unknown[]) => void,
): Promise<boolean | "skipped"> {
  const destDir = resolve(dep.destPath.replace(/^~/, process.env.HOME ?? "/home"));

  // 已存在 → skip
  if (existsSync(join(destDir, ".git"))) {
    log(`  ✓ ${dep.name} (已存在)`);
    return "skipped";
  }

  const gitUrl = httpsToSsh(dep.gitUrl) ?? dep.gitUrl;
  log(`  ↓ ${dep.name} → ${gitUrl}`);

  return new Promise<boolean>((resolve) => {
    mkdirSync(destDir, { recursive: true });

    const proc = spawn("git", ["clone", "--depth", "1", gitUrl, destDir], {
      stdio: "pipe",
    });

    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      stderr += text;
      if (text.includes("%") || text.includes("Receiving")) {
        process.stderr.write(`    ${text.trim()}\r`);
      }
    });

    proc.on("close", (code) => {
      if (code === 0) {
        process.stderr.write(`    ✓ ${dep.name}\n`);
        resolve(true);
      } else {
        process.stderr.write(`    ✗ ${dep.name} (exit ${code})\n`);
        try {
          const { rmSync } = require("node:fs") as typeof import("node:fs");
          rmSync(destDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
        resolve(false);
      }
    });

    proc.on("error", () => {
      resolve(false);
    });
  });
}

function gitCloneDest(gitUrl: string, version: string): string {
  const parsed = parseGitUrl(gitUrl);
  const refDir = join(
    diyHome(),
    "ref",
    parsed.host,
    parsed.owner,
    parsed.repo,
    version,
  );
  return refDir;
}

interface GitUrlParts {
  host: string;
  owner: string;
  repo: string;
}

function parseGitUrl(url: string): GitUrlParts {
  // https://github.com/org/repo → host=github.com, owner=org, repo=repo
  // git@github.com:org/repo.git → same
  const httpsMatch = url.match(
    /^https?:\/\/([^/]+)\/([^/]+)\/([^/@#]+?)(?:\.git)?(?:\/)?$/,
  );
  if (httpsMatch) {
    return {
      host: httpsMatch[1]!,
      owner: httpsMatch[2]!,
      repo: httpsMatch[3]!,
    };
  }

  const sshMatch = url.match(/^git@([^:]+):([^/]+)\/([^/@#]+?)(?:\.git)?$/);
  if (sshMatch) {
    return {
      host: sshMatch[1]!,
      owner: sshMatch[2]!,
      repo: sshMatch[3]!,
    };
  }

  // fallback: just use as-is
  return { host: "unknown", owner: "unknown", repo: basename(url) };
}

// ═══════════════════════════════════════
// ref.lock.yaml 写入
// ═══════════════════════════════════════

/** 将所有路径中的 $HOME 替换为 ~，保持可移植性 */
function normalizePaths(ref: RefLockV5["ref"]): RefLockV5["ref"] {
  const home = process.env.HOME ?? "/home";
  const norm = (p: string) => p.startsWith(home) ? "~" + p.slice(home.length) : p;

  function walk(v: unknown): unknown {
    if (typeof v === "string" && v.startsWith(home)) return norm(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  }

  return walk(ref) as RefLockV5["ref"];
}

async function writeLockFile(
  root: ProjectRoot,
  resolved: ResolvedDep[],
): Promise<void> {
  const ref: RefLockV5["ref"] = {};

  for (const dep of resolved) {
    if (dep.category === "source") {
      ref.source ??= {};
      ref.source[dep.scope] ??= {};
      const parsed = parseGitUrl(dep.gitUrl);
      const key = `${parsed.host}/${parsed.owner}/${parsed.repo}`;
      ref.source[dep.scope]![key] = dep.destPath;
      continue;
    }

    const eco = dep.eco as "python" | "node";
    ref[eco] ??= {};
    ref[eco]![dep.scope] ??= {};

    if (
      dep.category === "dependencies" ||
      dep.category === "dev-dependencies"
    ) {
      (ref[eco]![dep.scope] as any)[dep.category] ??= {};
      (ref[eco]![dep.scope] as any)[dep.category][dep.name] = dep.destPath;
    } else {
      // dependency-groups:xxx or optional-dependencies:xxx
      ref[eco]![dep.scope]![dep.category] ??= {};
      ref[eco]![dep.scope]![dep.category]![dep.name] = dep.destPath;
    }
  }

  const lockData: RefLockV5 = {
    version: 5,
    generated: new Date().toISOString(),
    ref: normalizePaths(ref),
  };

  const lockDir = join(root.rootDir, ".diy");
  mkdirSync(lockDir, { recursive: true });
  const lockPath = join(lockDir, "ref.lock.yaml");
  writeFileSync(lockPath, yaml.dump(lockData, { indent: 2, noRefs: true }), "utf-8");
}

// ═══════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════

function parseDepString(raw: string): { name: string; version: string } {
  // "pkg>=1.0.0" → name=pkg, version=1.0.0
  // "pkg" → name=pkg, version=latest
  const match = raw.match(/^([a-zA-Z0-9_.-]+)\s*([><=!~^].+)?$/);
  if (match) {
    return {
      name: match[1]!,
      version: match[2] ? match[2].replace(/^[><=!~^]+\s*/, "") : "latest",
    };
  }
  return { name: raw, version: "latest" };
}

function matchFilter(
  name: string,
  filter: { include: string[]; exclude: string[] },
): boolean {
  // include 为空 = 全部
  // exclude 优先
  if (filter.exclude.length > 0) {
    for (const pattern of filter.exclude) {
      if (globMatch(name, pattern)) return false;
    }
  }
  if (filter.include.length > 0) {
    for (const pattern of filter.include) {
      if (globMatch(name, pattern)) return true;
    }
    return false;
  }
  return true;
}

function globMatch(str: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(str);
}

// ═══════════════════════════════════════
// 内联 TOML 解析（复用 ref-project.ts 的同款）
// ═══════════════════════════════════════

function parseTomlLite(src: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let current: Record<string, unknown> = result;

  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const secMatch = line.match(/^\[([^\]]+)\]$/);
    if (secMatch) {
      const keys = secMatch[1]!.split(".");
      current = result;
      for (const k of keys) {
        const clean = k.trim();
        let next = current[clean];
        if (typeof next !== "object" || next === null) {
          next = {};
          current[clean] = next;
        }
        current = next as Record<string, unknown>;
      }
      continue;
    }

    const kvMatch = line.match(/^([^=]+)=\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1]!.trim();
      const rawVal = kvMatch[2]!.trim();
      if (
        (rawVal.startsWith('"') && rawVal.endsWith('"')) ||
        (rawVal.startsWith("'") && rawVal.endsWith("'"))
      ) {
        current[key] = rawVal.slice(1, -1);
      } else if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
        const inner = rawVal.slice(1, -1).trim();
        if (!inner) {
          current[key] = [];
        } else {
          current[key] = inner.split(",").map((s) => {
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
      } else if (rawVal === "true") {
        current[key] = true;
      } else if (rawVal === "false") {
        current[key] = false;
      } else if (/^-?\d+$/.test(rawVal)) {
        current[key] = parseInt(rawVal, 10);
      } else if (/^-?\d+\.\d+$/.test(rawVal)) {
        current[key] = parseFloat(rawVal);
      } else {
        current[key] = rawVal;
      }
    }
  }

  return result;
}

function dig<T>(obj: unknown, ...keys: string[]): T | undefined {
  let cur: any = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur as T | undefined;
}
