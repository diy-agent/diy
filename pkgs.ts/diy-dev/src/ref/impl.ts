// src/ref/impl.ts — ref 域 handler 绑定（业务编排）
//
// schema 定义在 api.ts，文件/URL 数据层在 store.ts，git 子进程在 git.ts；
// 本文件把三者缝成命令语义：add 注册写 diy.yaml、sync 批量 clone/pull + 写 lock、
// list 读 lock 对齐本地目录、remove 移除注册。
// handler 全部返回结构化数据，由 CLI 宿主负责展示（本文件不做 console）。
// 例外：sync 的 git 子进程进度直接渲染到本地 stderr（ProgressRenderer，190 修正 1）——
// serverStream 帧仍是 cloned/pulled/tagSkipped/error/done，机器消费不受影响。

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerBinding } from "@diy/rpc";
import { refApi, type RefEntry } from "./api";
import * as store from "./store";
import * as git from "./git";
import { getDefaultRenderer } from "./render";

/** ref 域运行时上下文：镜像根 home + 作用域 cwd */
export interface RefRuntime {
    /** 数据根（$DIY_HOME），镜像目录 $HOME/ref 落此 */
    home: string;
    /** 作用域目录（diy.yaml 所在目录；CLI 传 process.cwd()） */
    cwd: string;
}

type SyncError = { spec: string; message: string };

/** 把 ref 全部 handler 绑定到给定 ServerBinding（本地 mem transport 场景）。 */
export function bindRefHandlers(binding: ServerBinding, rt: RefRuntime): void {
    const ref = refApi.ref;

    binding.on(ref.add, async ({ input }) => {
        git.requireGit();
        // 解析 URL（含 @版本），失败抛清晰错误
        const p = store.parseSpec(input.url);
        // 预检 URL 可达（git ls-remote），不可达不加注册
        git.verifyRemoteUrl(p.url);
        const spec = store.addSource(rt.cwd, input.url);
        return {
            status: "ok",
            data: {
                name: `${p.info.owner}/${p.info.repo}`,
                spec,
            },
        };
    });

    binding.on(ref.remove, async ({ input }) => {
        git.requireGit();
        const removed = store.removeSource(rt.cwd, input.name);
        if (!removed) {
            const avail = store.listSpecs(rt.cwd);
            const list = avail.length
                ? `  现有 source:\n${avail.map((s) => `    ${s}`).join("\n")}`
                : "  （diy.yaml 无 source 注册）";
            throw new Error(`未找到匹配的 source: ${input.name}\n${list}`);
        }
        return {
            status: "ok",
            data: { removed },
        };
    });

    binding.on(ref.sync, async function* () {
        git.requireGit();
        const specs = store.listSpecs(rt.cwd);
        const now = new Date().toISOString();
        const sourceMap: Record<string, store.LockEntry> = {};
        let cloned = 0;
        let pulled = 0;
        let tagSkipped = 0;
        const errors: SyncError[] = [];

        // 进度渲染到本地 stderr（190 修正 1：不进 RPC 协议，帧结构照旧机器消费）。
        // 用进程级单例（F4）：与 git.ts 短命令 run() 内部取的是同一实例，curText/buf 状态不分裂
        const prog = getDefaultRenderer();

        for (let i = 0; i < specs.length; i++) {
            const spec = specs[i]!;
            // 兜底标签：parseSpec 失败时也能打出行号
            let label = `[${i + 1}/${specs.length}] ${spec}`;
            try {
                const p = store.parseSpec(spec);
                label = `[${i + 1}/${specs.length}] ${p.key}`;
                // 不可变版本（tag / SHA，正则初判；非 semver tag clone 后按本地 refs 消歧，
                // updateMirror 另有 detached HEAD 安全网）
                const isTag = p.version != null && store.isPinnedVersion(p.version);
                const norm = store.normalizeVersion(p.version);
                const rel = store.mirrorRelDir(p.info, norm);
                const dirAbs = join(rt.home, rel);

                // lock 记录先于 done 收尾行：done 之后不再放可抛语句（review §二#3b），
                // 避免「✓ 行已打、catch 又记失败」的理论矛盾
                const lockEntry: store.LockEntry = {
                    key: p.key,
                    url: p.url,
                    version: p.version,
                    dir: rel,
                    lastSync: now,
                };

                if (!existsSync(`${dirAbs}/.git`)) {
                    // 首次 clone（含按 tag/分支检出），进度实时渲染
                    prog.begin(label);
                    await git.cloneMirror({ dir: dirAbs, url: p.url, version: p.version, prog });
                    sourceMap[p.key] = lockEntry;
                    prog.done({ ok: true });
                    cloned++;
                    yield { spec, action: "cloned" as const };
                } else {
                    // 增量：tag 不动、分支 pull
                    prog.begin(label);
                    const u = await git.updateMirror(dirAbs, isTag, prog);
                    sourceMap[p.key] = lockEntry;
                    if (u.updated) {
                        prog.done({ ok: true });
                        pulled++;
                        yield { spec, action: "pulled" as const };
                    } else {
                        // F1：未执行任何 git 命令（tag 跳过）时不显示耗时列，标签头行仍由 begin 打过
                        prog.done({ ok: true, note: u.note, noTiming: u.noTiming });
                        tagSkipped++;
                        yield { spec, action: "tagSkipped" as const, message: u.note };
                    }
                }
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                prog.done({ ok: false, label, fail: message });
                errors.push({ spec, message });
                yield { spec, action: "error" as const, message };
            }
        }

        // 仅保留本次 spec 对应的条目（被 remove 的 source 在此剔除）
        store.saveRefLock(rt.cwd, { version: 1, generated: now, source: sourceMap });

        // 人类可读收尾行（零条目时不打扰；协议帧 summary 不变）
        if (specs.length > 0) {
            const parts = [`更新 ${cloned + pulled}`];
            if (tagSkipped > 0) parts.push(`跳过 ${tagSkipped}`);
            if (errors.length > 0) parts.push(`失败 ${errors.length}`);
            prog.info(`同步完成: ${parts.join(" / ")}（共 ${specs.length} 个 source）`);
        }

        // 汇总尾帧
        yield {
            spec: "",
            action: "done" as const,
            summary: {
                synced: cloned + pulled,
                tagSkipped,
                total: specs.length,
                errors,
            },
        };
    });

    binding.on(ref.list, async () => {
        const lock = store.loadRefLock(rt.cwd);
        const entries: RefEntry[] = [];
        // lock 条目（已 sync 记录）
        if (lock) {
            for (const key of Object.keys(lock.source).sort()) {
                const e = lock.source[key]!;
                const absDir = join(rt.home, e.dir);
                entries.push({
                    key,
                    url: e.url,
                    version: e.version,
                    dir: absDir,
                    exists: existsSync(absDir),
                    lastSync: e.lastSync,
                });
            }
        }
        // lock 为空（未 sync 过或 source 已变更）→ 从 diy.yaml 补「待同步」条目
        const specs = store.listSpecs(rt.cwd);
        if (specs.length > 0) {
            const known = new Set(entries.map((e) => e.key));
            for (const spec of specs) {
                try {
                    const p = store.parseSpec(spec);
                    if (known.has(p.key)) continue; // 已记录
                    const rel = store.mirrorRelDir(p.info, store.normalizeVersion(p.version));
                    entries.push({
                        key: p.key,
                        url: p.url,
                        version: p.version,
                        dir: join(rt.home, rel),
                        exists: false,
                        lastSync: null,
                    });
                } catch {
                    /* 解析失败的 source 跳过 */
                }
            }
            entries.sort((a, b) => a.key.localeCompare(b.key));
        }
        return entries;
    });
}
