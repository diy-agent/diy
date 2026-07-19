// src/main/core/ref.ts
// 🎯 ref.lock.yaml 解析 + scope 过滤 + 路径查询
//
// 格式：ref → ecosystem → scope → category → pkg → path
// 与 diy.yaml 的 ref: 键名统一。
//
// 所有函数返回结构化数据。格式化由 presentation 层负责。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { diyHome } from "./state";
import type { ProjectRoot } from "./ref-project";
import { findProjectRoot, detectCurrentScope } from "./ref-project";

// ═══════════════════════════════════════
// 类型
// ═══════════════════════════════════════

export interface CategoryRefs {
  dependencies?: Record<string, string>;
  "dev-dependencies"?: Record<string, string>;
  [key: string]: Record<string, string> | undefined;
}

export interface RefLockV5 {
  version: number;
  generated?: string;
  ref: {
    python?: Record<string, CategoryRefs>;
    node?: Record<string, CategoryRefs>;
    source?: Record<string, Record<string, string>>;
  };
}

export interface RefStatus {
  pkg: string;
  expectedPath: string;
  exists: boolean;
}

// ═══════════════════════════════════════
// 加载
// ═══════════════════════════════════════

export function loadRefLock(rootDir?: string): RefLockV5 | null {
  if (rootDir) {
    const localLock = join(rootDir, ".diy", "ref.lock.yaml");
    if (existsSync(localLock)) {
      try {
        const data = yaml.load(readFileSync(localLock, "utf-8")) as any;
        return normalizeLockData(data);
      } catch {
        // fall through to global
      }
    }
  }

  const globalLock = join(diyHome(), "ref.lock.yaml");
  if (existsSync(globalLock)) {
    try {
      const data = yaml.load(readFileSync(globalLock, "utf-8")) as any;
      return normalizeLockData(data);
    } catch {
      return null;
    }
  }

  return null;
}

function normalizeLockData(data: any): RefLockV5 {
  // read ref (new) or refs (old Python format) for backward compat
  const ref = data?.ref ?? data?.refs ?? {};
  return {
    version: data?.version ?? 5,
    generated: data?.generated,
    ref: {
      python: ref.python ?? {},
      node: ref.node ?? {},
      source: ref.source ?? {},
    },
  };
}

// ═══════════════════════════════════════
// Scope 过滤
// ═══════════════════════════════════════

/** scope=null → 返回全部。source 不过滤 scope，永远展示。 */
export function filterByScope(
  lock: RefLockV5,
  scope: string | null,
): RefLockV5 {
  if (!scope) return lock;

  const pickScope = <T extends Record<string, any>>(
    src: Record<string, T> | undefined,
  ): Record<string, T> => {
    if (!src) return {};
    return src[scope] ? { [scope]: src[scope] } : {};
  };

  return {
    version: lock.version,
    generated: lock.generated,
    ref: {
      python: pickScope(lock.ref.python),
      node: pickScope(lock.ref.node),
      source: lock.ref.source ?? {},
    },
  };
}

// ═══════════════════════════════════════
// 状态检查
// ═══════════════════════════════════════

export function checkRefPaths(rootDir?: string): RefStatus[] {
  const lock = loadRefLock(rootDir);
  if (!lock) return [];

  const results: RefStatus[] = [];
  const home = process.env.HOME ?? "/home";

  for (const eco of ["python", "node", "source"] as const) {
    const scopes = lock.ref[eco];
    if (!scopes) continue;

    for (const categories of Object.values(scopes)) {
      for (const [catKey, deps] of Object.entries(categories)) {
        if (!deps) continue;
        for (const [pkg, path] of Object.entries(deps)) {
          results.push({
            pkg: `${eco}/${pkg}`,
            expectedPath: path,
            exists: existsSync(path.replace(/^~/, home)),
          });
        }
      }
    }
  }

  return results;
}

// ═══════════════════════════════════════
// 便捷入口
// ═══════════════════════════════════════

/** 从 cwd 检测项目 + scope，返回过滤后的结构化数据。 */
export function refList(all: boolean = false): RefLockV5 | { error: string } {
  let root: ProjectRoot;
  try {
    root = findProjectRoot();
  } catch (e: any) {
    return { error: e.message };
  }

  const lock = loadRefLock(root.rootDir);
  if (!lock) return { error: "未找到 ref.lock.yaml。运行 'diy2 ref sync' 生成。" };

  const scope = all ? null : detectCurrentScope(process.cwd(), root);
  return filterByScope(lock, scope);
}
