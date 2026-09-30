// src/ref/store.ts — diy.yaml / ref.lock.yaml 读写 + URL 解析
//
// 纯数据层：只做文件读写与字符串解析，不调 git、不含业务编排（编排在 impl.ts）。
// diy.yaml:    js-yaml dump（源 source 列表，版本含在字符串里）
// ref.lock.yaml: js-yaml 结构化 {version, generated, source:{key:{url,version,dir,lastSync}}}
//
// 路径语义：LockEntry.dir 存「相对 $DIY_HOME」的镜像路径（如 ref/github.com/org/repo/main），
// 跨 worktree 复用时需拼当前 home（join(runtime.home, dir)）。对齐旧 Python ref 的 ~/... 惯例。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

// ═══════════════════════════════════════
// URL 解析
// ═══════════════════════════════════════

export interface RepoInfo {
    host: string;
    owner: string;
    repo: string;
}

/** 解析 git 仓库 URL 为 host/owner/repo；不支持的形式返回 null。 */
export function parseRepoUrl(url: string): RepoInfo | null {
    let s = url.trim();
    // 先剥尾部斜杠，再剥 .git（两者都可带结尾）
    s = s.replace(/\/+$/, "").replace(/\.git$/, "");
    let m = s.match(/^(?:https?:\/\/|git@|ssh:\/\/git@)([^/:\s]+)[:/]([^/:\s]+)\/([^/:\s]+)$/);
    if (!m) {
        // 宽松兜底：host/owner/repo 三段（不带协议）
        m = s.match(/^([^/:\s]+)\/([^/:\s]+)\/([^/:\s]+)$/);
    }
    if (!m) return null;
    return { host: m[1]!, owner: m[2]!, repo: m[3]! };
}

/** tag 判定：@ 后段形如 v1.0.0 / 纯数字 → tag（不可变，sync 不 pull）。 */
export function isTagVersion(version: string): boolean {
    return /^v?\d+(\.\d+)*$/.test(version);
}

/** commit SHA 判定：40 位 hex（/commit/ 页复制而来，与 tag 同按不可变处理）。 */
export function isShaVersion(version: string): boolean {
    return /^[0-9a-f]{40}$/i.test(version);
}

/**
 * 不可变版本判定：tag 或 SHA → detached 检出，sync 不 pull。
 * 非 semver tag（如 nightly）正则认不出，以 clone 到的本地 refs/tags/ 为准（见 git.ts 消歧），
 * 此处只做纯字符串初判。
 */
export function isPinnedVersion(version: string): boolean {
    return isTagVersion(version) || isShaVersion(version);
}

/** 版本段兜底：null / 空 → "main"（默认分支）。 */
export function normalizeVersion(version: string | null): string {
    return version && version.trim() ? version.trim() : "main";
}

/** host/owner/repo 去重键（也用作 lock.source 的 map key）。 */
export function sourceKey(info: RepoInfo): string {
    return `${info.host}/${info.owner}/${info.repo}`;
}

/** 镜像目录相对 $DIY_HOME 的路径：ref/<host>/<owner>/<repo>/<version>。 */
export function mirrorRelDir(info: RepoInfo, version: string): string {
    return join("ref", info.host, info.owner, info.repo, version);
}

/**
 * 把 source 串拆成纯 URL + 版本段（不校验仓库存在，供 parseSpec / stripVersion 共用）。
 *
 * 接受形状（浏览器地址栏直接复制）：
 *   - https://host/owner/repo                     → 无版本
 *   - https://host/owner/repo@<branch|tag>        → @ 版本（SSH 也用此形）
 *   - https://host/owner/repo/tree/<ref>          → /tree/ 后段整体即 ref（斜杠分支保持完整）
 *   - https://host/owner/repo/releases/tag/<t>    → tag
 *   - https://host/owner/repo/commit/<sha>        → SHA
 * query/fragment（?#）先剥离；/blob/ 等文件页与功能页明确拒绝（离线无法定位 ref）。
 */
function splitSpec(raw: string): { url: string; version: string | null } {
    let t = raw.trim();
    // 浏览器复制常带 ?plain=1 / #readme 等，先剥离（git ref 不含 ?，# 视为 fragment 舍弃）
    const hash = t.indexOf("#");
    if (hash !== -1) t = t.slice(0, hash);
    const q = t.indexOf("?");
    if (q !== -1) t = t.slice(0, q);
    t = t.replace(/\/+$/, "");

    // release 页：…/releases/tag/<t> → tag
    let m = t.match(/^(.*?)\/releases\/tag\/([^/]+)$/);
    if (m && parseRepoUrl(m[1]!)) return { url: m[1]!, version: m[2]!.trim() };

    // commit 页：…/commit/<40 位 sha> → SHA（detached 检出）
    m = t.match(/^(.*?)\/commit\/([0-9a-f]{40})$/i);
    if (m && parseRepoUrl(m[1]!)) return { url: m[1]!, version: m[2]!.toLowerCase() };

    // 文件页 / 功能页：ref 边界离线无法确定，明确拒绝并指路
    const page = t.match(/\/(blob|pull|compare|commits|actions|issues|discussions|wiki|releases)(\/|$)/);
    if (page) {
        throw new Error(
            `不支持的页面 URL（/${page[1]}）：请复制仓库根或 /tree/ 分支页地址，或用 @版本 形式\n  ${raw.trim()}`,
        );
    }

    // 浏览页：…/tree/<ref>（后段整体即 ref 名）；…/tree 结尾视作仓库根
    const ti = t.indexOf("/tree/");
    if (ti !== -1) {
        const url = t.slice(0, ti);
        const v = t.slice(ti + "/tree/".length).trim();
        if (parseRepoUrl(url) && v.length > 0) return { url, version: v };
    } else if (t.endsWith("/tree")) {
        const url = t.slice(0, -"/tree".length);
        if (parseRepoUrl(url)) return { url, version: null };
    }

    // @ 版本：: 不可能出现在 git ref 中，含 : 说明 @ 属于 SSH 前缀（如 git@host:owner/repo 无版本）
    if (t.includes("@")) {
        const sep = t.lastIndexOf("@");
        const v = t.slice(sep + 1);
        if (v.includes(":")) return { url: t, version: null }; // 裸 SSH，整体即 URL
        if (v.trim().length > 0) return { url: t.slice(0, sep), version: v.trim() };
        return { url: t.slice(0, sep), version: null }; // 尾部 @：视作无版本
    }
    return { url: t, version: null };
}

/** 把 source 串拆成 URL 解析结果；spec 保留原样由调用方处理。 */
export function parseSpec(spec: string): {
    info: RepoInfo;
    /** 纯 URL（版本段剥离后，clone 用此） */
    url: string;
    /** 版本段（@ / /tree/ / releases / commit 统归一处）；null = 按 main */
    version: string | null;
    key: string;
} {
    const { url, version } = splitSpec(spec);
    const info = parseRepoUrl(url);
    if (!info) throw new Error(`无法解析 URL: ${url}`);
    return {
        info,
        url,
        version,
        key: sourceKey(info),
    };
}

// ═══════════════════════════════════════
// diy.yaml（source 注册表 —— 只存 source 字符串列表）
// ═══════════════════════════════════════

export const DIY_YAML_TEMPLATE = `# diy-dev — 源码镜像配置
#
# dev ref add <url>  注册人工指定 source（总是下载，镜像到 $DIY_HOME/ref/）
# dev ref remove     移除注册（本地镜像保留）
# dev ref sync       批量 clone 已注册 source
#
# source 格式（二选一，浏览器地址栏复制即可）：
#   https://github.com/org/repo[@branch|@tag]   @ 精确形式（SSH 也用此形，歧义时以此为准）
#   https://github.com/org/repo/tree/<ref>      浏览页形式（/tree/ 后段整体即 ref）
#   https://github.com/org/repo/releases/tag/<t> 发布页形式（按 tag）
#   无版本 / 分支 → clone 后 sync 时 git pull 保持最新
#   tag（v1.0.0、纯数字、nightly 等）/ commit SHA → 检出后固定，不 pull
#
# 示例：
#   https://github.com/Textualize/rich
#   https://github.com/octocat/Hello-World@v1.0.0
#   https://github.com/nodeca/babelfish/tree/2.0.0

ref:
  source: []
`;

/** cwd 有无 diy.yaml；无则创建模板。返回 diy.yaml 路径。 */
export function ensureDiyYaml(dir: string): string {
    const p = join(dir, "diy.yaml");
    if (!existsSync(p)) {
        writeFileSync(p, DIY_YAML_TEMPLATE, "utf-8");
    }
    return p;
}

interface DiyYamlShape {
    ref?: { source?: unknown[] };
}

/** 读 diy.yaml 的 source 字符串列表（js-yaml 解析失败返回 []）。 */
export function listSpecs(dir: string): string[] {
    const p = join(dir, "diy.yaml");
    if (!existsSync(p)) return [];
    try {
        const raw = yaml.load(readFileSync(p, "utf-8")) as DiyYamlShape | null;
        const arr = raw?.ref?.source;
        if (!Array.isArray(arr)) return [];
        return arr.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    } catch {
        return [];
    }
}

/** 追加一个 source spec（原样保留用户输入）；同 host/owner/repo 的旧条目被替换。返回写入 spec。 */
export function addSource(dir: string, spec: string): string {
    ensureDiyYaml(dir);
    const specs = listSpecs(dir);
    const { info } = parseSpec(spec);
    const key = sourceKey(info);
    const trimmed = spec.trim();

    const next = specs.filter((s) => {
        try {
            return sourceKey(parseRepoUrl(stripVersion(s))!) !== key;
        } catch {
            return true; // 解析不了的行保留，不误删
        }
    });
    next.push(trimmed);

    _writeDiyYaml(dir, next);
    return trimmed;
}

/** 按 owner/repo、完整 URL、或 diy.yaml 原字符串移除；找到返回其 spec，未找到返回 null。 */
export function removeSource(dir: string, name: string): string | null {
    // 不 ensureDiyYaml：无 diy.yaml 时直接「未找到」，不先建空文件（190 核对表 #10）
    if (!existsSync(join(dir, "diy.yaml"))) return null;
    const specs = listSpecs(dir);
    const needle = name.trim();
    const hitIdx = specs.findIndex((s) => {
        const stripped = stripVersion(s);
        try {
            const { host, owner, repo } = parseRepoUrl(stripped)!;
            return (
                s === needle ||
                stripped === needle ||
                `${owner}/${repo}` === needle ||
                `${host}/${owner}/${repo}` === needle
            );
        } catch {
            return s === needle;
        }
    });
    if (hitIdx === -1) return null;
    const removed = specs[hitIdx]!;
    specs.splice(hitIdx, 1);
    _writeDiyYaml(dir, specs);
    return removed;
}

/**
 * 剥离版本段返回纯 URL（@ / /tree/ / /releases/tag/ / /commit/ 均处理）。
 * 解析失败回退原样返回（调用方 try/catch，不抛）。
 */
export function stripVersion(spec: string): string {
    try {
        return splitSpec(spec).url;
    } catch {
        return spec;
    }
}

function _writeDiyYaml(dir: string, specs: string[]): void {
    const p = join(dir, "diy.yaml");
    // 用 js-yaml dump 输出稳定结构；保留 comment 由模板文件自然携带（整体重写会丢注释，v1 接受）
    const body = yaml.dump({ ref: { source: specs } }, { indent: 2, noRefs: true, lineWidth: -1 });
    writeFileSync(p, `# diy-dev — 源码镜像配置（source 列表由 dev ref 管理）\n${body}`, "utf-8");
}

// ═══════════════════════════════════════
// ref.lock.yaml
// ═══════════════════════════════════════

export interface LockEntry {
    key: string;
    /** 纯 URL */
    url: string;
    /** @ 后版本段；null = 按 main */
    version: string | null;
    /** 相对 $DIY_HOME 的镜像目录 */
    dir: string;
    /** 最近一次 sync 完成时间（ISO）；tag 固定时 = 创建/检出时间 */
    lastSync: string;
}

export interface RefLock {
    version: number;
    generated: string;
    /** map: key(host/owner/repo) → 条目 */
    source: Record<string, LockEntry>;
}

/** 读 cwd/.diy/ref.lock.yaml；不存在或格式损坏返回 null。 */
export function loadRefLock(dir: string): RefLock | null {
    const p = join(dir, ".diy", "ref.lock.yaml");
    if (!existsSync(p)) return null;
    try {
        const raw = yaml.load(readFileSync(p, "utf-8")) as any;
        const source = raw?.source ?? {};
        const entries: Record<string, LockEntry> = {};
        for (const [k, v] of Object.entries(source ?? {})) {
            const e = v as any;
            if (!e || typeof e !== "object") continue;
            entries[k] = {
                key: e.key ?? k,
                url: String(e.url ?? ""),
                version: e.version == null ? null : String(e.version),
                dir: String(e.dir ?? ""),
                lastSync: String(e.lastSync ?? ""),
            };
        }
        return {
            version: Number(raw?.version ?? 1),
            generated: String(raw?.generated ?? ""),
            source: entries,
        };
    } catch {
        return null;
    }
}

/** 写 cwd/.diy/ref.lock.yaml（目录自动创建）。 */
export function saveRefLock(dir: string, lock: RefLock): void {
    const lockDir = join(dir, ".diy");
    mkdirSync(lockDir, { recursive: true });
    const doc = {
        version: lock.version,
        generated: lock.generated,
        source: lock.source,
    };
    const body = yaml.dump(doc, { indent: 2, noRefs: true, lineWidth: -1 });
    writeFileSync(join(lockDir, "ref.lock.yaml"), body, "utf-8");
}
