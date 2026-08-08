// src/main/services/ref-config.ts
// 🎯 diy.yaml ref 配置读写 — ref add/remove source
//
// 注意：diy.yaml 只是 ref 配置，不作为项目边界。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import * as yaml from "js-yaml";
import { findProjectRoot } from "../core/ref-project";
import type { ProjectRoot } from "../core/ref-project";

/** 与 loadRefConfig 同优先级搜索 diy.yaml：cwd → 项目根 → 上层（非 diy 项目） */
function resolveDiyYamlPath(): string {
  const cwd = process.cwd();

  // 1. cwd
  if (existsSync(join(cwd, "diy.yaml"))) return join(cwd, "diy.yaml");

  // 2. 项目根
  let root: ProjectRoot;
  try {
    root = findProjectRoot();
  } catch {
    return join(cwd, "diy.yaml");
  }

  if (existsSync(join(root.rootDir, "diy.yaml"))) return join(root.rootDir, "diy.yaml");

  // 3. 对非 diy 项目，向上搜索
  if (root.kind !== "diy") {
    let dir = dirname(root.rootDir);
    while (true) {
      if (existsSync(join(dir, "diy.yaml"))) return join(dir, "diy.yaml");
      if (existsSync(join(dir, ".git"))) break;
      if (dir === dirname(dir)) break;
      dir = dirname(dir);
    }
  }

  // 没找到 → 用 cwd
  return join(cwd, "diy.yaml");
}

/**
 * 向 diy.yaml 添加一个 source URL。
 * 会先 git ls-remote 验证 URL 可达。
 */
export function addSource(url: string): string {
  const yamlPath = findOrCreateDiyYaml(resolveDiyYamlPath());
  const normalized = normalizeGitUrl(url);

  // 先检查是否已存在（避免不必要的 git ls-remote）
  const existing = readDiyYamlRaw(yamlPath);
  const sources: string[] = (existing?.ref?.source ?? []).map(String);
  const parsed = parseGitUrl(normalized);
  const scopeKey = `${parsed.host}/${parsed.owner}/${parsed.repo}`;

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i]!;
    const ep = parseGitUrl(stripVersion(s));
    const ek = `${ep.host}/${ep.owner}/${ep.repo}`;
    if (ek === scopeKey) {
      if (s === normalized || s === url) return `已存在: ${s}`;
      // 替换
      sources[i] = normalized;
      writeDiyYamlRaw(yamlPath, existing, sources);
      return `已更新: ${normalized} (替换 ${s})`;
    }
  }

  // 只有新 URL 才验证可达性
  verifyGitUrl(url);

  // 新增
  sources.push(normalized);
  writeDiyYamlRaw(yamlPath, existing, sources);
  return `已添加: ${normalized}`;
}

/**
 * 从 diy.yaml 移除一个 source。
 * 匹配方式：URL 或 host/owner/repo 标识。
 */
export function removeSource(name: string): string | null {
  const yamlPath = resolveDiyYamlPath();
  if (!existsSync(yamlPath)) return null;

  const existing = readDiyYamlRaw(yamlPath);
  const sources: string[] = existing?.ref?.source ?? [];
  if (sources.length === 0) return null;

  // 匹配：精确 URL / host:owner/repo / owner/repo
  const findIdx = sources.findIndex((s: string) => {
    const sNorm = normalizeGitUrl(String(s));
    if (s === name || sNorm === normalizeGitUrl(name)) return true;

    const parsed = parseGitUrl(sNorm);
    const keyFull = `${parsed.host}/${parsed.owner}/${parsed.repo}`;
    const keyShort = `${parsed.owner}/${parsed.repo}`;
    return keyFull === name || keyShort === name;
  });

  if (findIdx === -1) return null;

  const removed = String(sources[findIdx]);
  sources.splice(findIdx, 1);
  writeDiyYamlRaw(yamlPath, existing, sources);
  return removed;
}

// ═══════════════════════════════════════
// 内部
// ═══════════════════════════════════════

function verifyGitUrl(url: string): void {
  const gitUrl = httpsToSsh(url) ?? url;
  try {
    execFileSync("git", ["ls-remote", "--heads", gitUrl], {
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    const stderr = e.stderr?.toString().trim() || e.message || String(e);
    throw new Error(`git ls-remote 失败: ${stderr}`);
  }
}

function httpsToSsh(url: string): string | null {
  const m = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/@#]+?)(?:\.git)?(?:\/)?$/);
  return m ? `git@${m[1]}:${m[2]}/${m[3]}` : null;
}

function findOrCreateDiyYaml(yamlPath: string): string {
  if (!existsSync(yamlPath)) {
    mkdirSync(dirname(yamlPath), { recursive: true });
    const template = [
      "# diy ref 配置",
      "# diy ref add <url>  — 注册外部仓库",
      "# diy ref sync      — 下载源码到 ~/.diy/ref/",
      "",
      "ref:",
      "  source: []",
      "",
    ].join("\n");
    writeFileSync(yamlPath, template, "utf-8");
  }
  return yamlPath;
}

function readDiyYamlRaw(yamlPath: string): any {
  try {
    return yaml.load(readFileSync(yamlPath, "utf-8")) ?? {};
  } catch {
    return {};
  }
}

function writeDiyYamlRaw(
  yamlPath: string,
  existing: any,
  sources: string[],
): void {
  existing.ref = existing.ref ?? {};
  existing.ref.source = sources;
  // 清理空节点
  if (Object.keys(existing.ref).length === 1 && existing.ref.source.length === 0) {
    delete existing.ref;
  }
  writeFileSync(yamlPath, yaml.dump(existing, { indent: 2, noRefs: true }), "utf-8");
}

function normalizeGitUrl(url: string): string {
  // strip @version
  let base = url.split("@")[0]!;
  // strip .git suffix
  base = base.replace(/\.git$/, "");
  // strip trailing slash
  base = base.replace(/\/$/, "");
  return base;
}

function stripVersion(url: string): string {
  return url.split("@")[0]!;
}

interface GitUrlParts {
  host: string;
  owner: string;
  repo: string;
}

function parseGitUrl(url: string): GitUrlParts {
  const httpsMatch = url.match(
    /^https?:\/\/([^/]+)\/([^/]+)\/([^/@#]+?)(?:\.git)?(?:\/)?$/,
  );
  if (httpsMatch) {
    return { host: httpsMatch[1]!, owner: httpsMatch[2]!, repo: httpsMatch[3]! };
  }

  const sshMatch = url.match(/^git@([^:]+):([^/]+)\/([^/@#]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { host: sshMatch[1]!, owner: sshMatch[2]!, repo: sshMatch[3]! };
  }

  return { host: "unknown", owner: "unknown", repo: url };
}
