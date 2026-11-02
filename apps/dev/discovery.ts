// discovery.ts — **静态清单**：本机有哪些 worktree、每个 worktree 的 apps/ 下有哪些 app.yaml。
//
// ##502 第二轮的判据：清单不能从注册表推导（那样必须先启动一次才知道，本末倒置）。
//   `git worktree list` × `glob <wt>/apps/*/app.yaml`
//
// 解析一律宽松 + 记问题：坏一个 app.yaml 只影响它自己，不拖垮整张表（问题进 snapshot.problems）。

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { load as parseYaml } from "js-yaml";
import type { AppSpec, EntrySpec, LaunchSpec, WorktreeInfo } from "./shared.js";

/** 解析 `git worktree list --porcelain` 的输出（纯函数，单测不启 git） */
export function parseWorktrees(out: string): WorktreeInfo[] {
    const list: WorktreeInfo[] = [];
    let path: string | null = null;
    let branch: string | null = null;
    let bare = false;
    const flush = (): void => {
        if (path !== null && !bare) list.push({ path, branch });
        path = null;
        branch = null;
        bare = false;
    };
    for (const line of out.split(/\r?\n/)) {
        if (line === "") {
            flush();
            continue;
        }
        if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
        else if (line.startsWith("branch ")) branch = line.slice("branch ".length).replace(/^refs\/heads\//, "").trim();
        else if (line === "bare") bare = true;
    }
    flush();
    return list;
}

/** `git worktree list --porcelain`：只读仓库元数据，不扫进程、不看注册表 */
export function listWorktrees(repoRoot: string, gitCommand: string = "git"): WorktreeInfo[] {
    let out: string;
    try {
        out = execFileSync(gitCommand, ["-C", repoRoot, "worktree", "list", "--porcelain"], {
            encoding: "utf-8",
            timeout: 5000,
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch {
        // 不是 git 仓 / 没有 git：至少把 repoRoot 当唯一 worktree，界面不至于空
        return [{ path: repoRoot, branch: null }];
    }
    return parseWorktrees(out);
}

/** 一个目录下的 app.yaml 路径列表；没有 apps/ 就是空（正常态：一个 worktree 可能还没搬） */
export function findAppYamlFiles(worktree: string, readdir: (dir: string) => string[] = readdirSync): string[] {
    const appsDir = join(worktree, "apps");
    let entries: string[];
    try {
        entries = readdir(appsDir);
    } catch {
        return [];
    }
    const out: string[] = [];
    for (const name of entries.sort()) {
        const file = join(appsDir, name, "app.yaml");
        if (existsSync(file)) out.push(file);
    }
    return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** 解析一份 app.yaml 文本（纯函数；坏输入抛 Error，由调用方记 problem） */
export function parseAppYaml(text: string, opts: { dir: string; dirName: string; file: string }): AppSpec {
    const raw: unknown = parseYaml(text);
    if (!isRecord(raw)) throw new Error(`${opts.file}：顶层不是映射`);
    const name = str(raw["name"]) ?? opts.dirName;
    const title = str(raw["title"]) ?? name;
    const launchesRaw = raw["launches"];
    if (!Array.isArray(launchesRaw) || launchesRaw.length === 0) {
        throw new Error(`${opts.file}：launches 必须是非空数组`);
    }
    const launches: LaunchSpec[] = launchesRaw.map((item, index) => {
        if (!isRecord(item)) throw new Error(`${opts.file}：launches[${index}] 不是映射`);
        const id = str(item["id"]);
        const command = str(item["command"]);
        if (id === null) throw new Error(`${opts.file}：launches[${index}] 缺 id`);
        if (command === null) throw new Error(`${opts.file}：launch ${id} 缺 command`);
        const entriesRaw = item["entries"];
        if (!Array.isArray(entriesRaw) || entriesRaw.length === 0) {
            throw new Error(`${opts.file}：launch ${id} 的 entries 必须是非空数组`);
        }
        const entries: EntrySpec[] = entriesRaw.map((entry, entryIndex) => {
            if (!isRecord(entry)) throw new Error(`${opts.file}：launch ${id} entries[${entryIndex}] 不是映射`);
            const kind = entry["kind"];
            if (kind !== "app" && kind !== "web") {
                throw new Error(`${opts.file}：launch ${id} entries[${entryIndex}].kind 只能是 app / web`);
            }
            const url = str(entry["url"]);
            if (kind === "web" && url === null) {
                throw new Error(`${opts.file}：launch ${id} 的 web entry 缺 url`);
            }
            const entryTitle = str(entry["title"]);
            return {
                kind,
                ...(entryTitle === null ? {} : { title: entryTitle }),
                ...(url === null ? {} : { url }),
            };
        });
        const envRaw = item["env"];
        if (envRaw !== undefined && !isRecord(envRaw)) {
            throw new Error(`${opts.file}：launch ${id} 的 env 必须是映射`);
        }
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(isRecord(envRaw) ? envRaw : {})) {
            if (typeof value === "string" || typeof value === "number") env[key] = String(value);
        }
        const home = str(item["home"]);
        const launchTitle = str(item["title"]);
        return {
            id,
            ...(launchTitle === null ? {} : { title: launchTitle }),
            command,
            ...(Object.keys(env).length === 0 ? {} : { env }),
            ...(home === null ? {} : { home }),
            entries,
        };
    });
    const ids = new Set<string>();
    for (const launch of launches) {
        if (ids.has(launch.id)) throw new Error(`${opts.file}：launch id 重复：${launch.id}`);
        ids.add(launch.id);
    }
    return { name, title, dir: opts.dir, launches };
}

export interface DiscoveredApps {
    readonly apps: readonly AppSpec[];
    readonly problems: readonly string[];
}

/** 扫一个 worktree 的 `apps/<name>/app.yaml`；每个坏文件单独记一条 problem */
export function discoverAppsIn(
    worktree: string,
    readFile: (file: string) => string = (file) => readFileSync(file, "utf-8"),
): DiscoveredApps {
    const apps: AppSpec[] = [];
    const problems: string[] = [];
    for (const file of findAppYamlFiles(worktree)) {
        const dir = dirname(file);
        const dirName = basename(dir);
        try {
            apps.push(parseAppYaml(readFile(file), { dir, dirName, file }));
        } catch (error) {
            problems.push(error instanceof Error ? error.message : String(error));
        }
    }
    return { apps, problems };
}
