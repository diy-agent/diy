/**
 * api-domains/kb/impl.ts — `kb` 域的 handler 绑定
 *
 * 与 `api.ts` 成对（同域两半放一起，将来整个目录搬进 `@diy-agent/kb` 时不用到处找 handler）。
 *
 * **库根解析**在这里（不分进 `@diy-agent/kb`）：从 `cwd` 推 `.diy/knowledge` 是宿主概念，
 * 纯 IO 包不该知道 diy 的目录约定，它只认「给我一个 root」。
 */
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ServerBinding } from "@diy-agent/rpc";
import { moveEntry, scanKb, writeEntry, writeIndex } from "@diy-agent/kb";
import { kbService } from "./api";

/**
 * 把 `dir` 选项解析成绝对路径。
 *
 * 三种值：
 *   · `global`    → `$DIY_HOME/knowledge`（缺省 `~/.diy/knowledge`）
 *   · 其它字符串   → 原样 resolve
 *   · 不给        → 从 `cwd` 向上找 `.diy/knowledge`；找不到就用 cwd 下的 `.diy/knowledge`
 *                   （**不抛**：第一次用本来就还没有这个目录，`write` 会自己建）
 */
async function resolveRoot(dir: string | undefined, cwd: string): Promise<string> {
    if (dir === "global") {
        const home = process.env["DIY_HOME"] ?? join(homedir(), ".diy");
        return join(home, "knowledge");
    }
    if (dir !== undefined && dir !== "") return resolve(cwd, dir);

    // 向上找最近的 `.diy/knowledge`（与 AGENTS.md 链同方向：近的优先）
    let at = resolve(cwd);
    for (;;) {
        const candidate = join(at, ".diy", "knowledge");
        try {
            await access(candidate);
            return candidate;
        } catch {
            /* 不存在 = 继续向上 */
        }
        const parent = resolve(at, "..");
        if (parent === at) break;
        at = parent;
    }
    return join(resolve(cwd), ".diy", "knowledge");
}

/** 正文来源：`-` = stdin，或文件路径 */
async function readBody(bodyFile: string | undefined, cwd: string): Promise<string> {
    if (bodyFile === undefined || bodyFile === "") {
        throw new Error("kb: 缺少正文（用 --body-file - 从 stdin 读，或给文件路径）", { cause: { code: "kb/no-body" } });
    }
    if (bodyFile === "-") {
        // 异步 readFile 不接 fd，stdin 只能这样读（同步 readFileSync(0) 会被 check-sync-io 拦）
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks).toString("utf-8");
    }
    const abs = resolve(cwd, bodyFile);
    try {
        return await readFile(abs, "utf-8");
    } catch {
        throw new Error(`kb: 正文文件不存在（${bodyFile}）`, { cause: { code: "kb/body-not-found" } });
    }
}

/** 补 yaml 头：调用方给了 desc 就补一条；已有头就原样用（只补 updated） */
function ensureFrontmatter(body: string, desc: string | undefined, today: string): string {
    if (body.startsWith("---")) {
        // 已有头：只在缺 updated 时补一条（不重排、不改写别的字段）
        const end = body.indexOf("\n---", 3);
        if (end < 0) return body;
        const head = body.slice(0, end);
        if (/^updated:/m.test(head)) return body;
        return `${head}\nupdated: ${today}${body.slice(end)}`;
    }
    const parts = [`---`];
    if (desc !== undefined && desc !== "") parts.push(`desc: ${desc}`);
    parts.push(`updated: ${today}`, `---`, "");
    return `${parts.join("\n")}\n${body}`;
}

export function bindKb(server: ServerBinding): void {
    server.on("diy.kb.write", kbService.api.write, async ({ input }) => {
        const root = await resolveRoot(input.dir, input.cwd ?? process.cwd());
        const body = await readBody(input.bodyFile, input.cwd ?? process.cwd());
        const content = ensureFrontmatter(body, input.desc, new Date().toISOString().slice(0, 10));
        const r = writeEntry(root, input.path, content);
        // INDEX 跟着写 —— 用户 2026-11-07：「index 是自动生成的吧？每次写入更新？」
        // 让每条写操作都带着索引一起落地，就不存在「写了但索引里没有」的中间态
        await writeIndex(root, "");
        return { path: r.path, bytes: r.bytes };
    });

    server.on("diy.kb.check", kbService.api.check, async ({ input }) => {
        const root = await resolveRoot(input.dir, input.cwd ?? process.cwd());
        const scan = scanKb(root);
        return { root: scan.root, entries: [...scan.entries], problems: [...scan.problems] };
    });

    server.on("diy.kb.index", kbService.api.index, async ({ input }) => {
        const root = await resolveRoot(input.dir, input.cwd ?? process.cwd());
        const r = writeIndex(root, input.label ?? "");
        return { path: r.path, entries: r.entries, problems: [...r.problems] };
    });

    server.on("diy.kb.move", kbService.api.move, async ({ input }) => {
        const root = await resolveRoot(input.dir, input.cwd ?? process.cwd());
        const r = moveEntry(root, input.from, input.to);
        await writeIndex(root, "");
        return { from: r.from, to: r.to };
    });
}

/** 给 `check` 用的「有没有问题」判据（CLI 退出码） */
export function kbHasProblems(problems: readonly { code: string }[]): boolean {
    return problems.length > 0;
}

/** 导出给测试（纯函数，不依赖 binding） */
export { resolveRoot, ensureFrontmatter, readBody };
export { sep };
