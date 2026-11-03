// ns.ts — 命名空间与全局事实标识（gid）—— ##404
//
// 为什么要命名空间：同一份 claim 在**多个库**里各有真源（`knowledge/facts/` 仓库级、
// `~/.diy/projects/<pid>/tasks/<tid>/facts.yaml` 任务级、`~/.diy/facts/` 设备级），
// 而 agent 一轮可能同时引用**父任务 + 子任务**的事实 —— "当前任务"不成立，必须显式。
//
// 三条形状（`--in` 与真源位置都由消费侧解释，内核只认标识）：
//
//   global:app.port#default                         设备级（跨项目）
//   project:app.port#default                        仓库级（位置即归属，**不带 pid**）
//   task:projects/4/tasks/404:dev.check#entry       任务级（**taskUri 全写**，不复用 tid）
//
// 为什么 project 不带 pid：库文件在 git 仓库的 `knowledge/`，worktree / 克隆里是
// 同 gid 不同内容 —— 带 pid 会让"同一个 id 指两份不同真源"。
//
// 为什么 task 写全 `projects/4/tasks/404` 而不是 `4/404`：任务标识在 DIY 里已经有
// 现成形状（`task.uri`），再发明一种短形 = 同一实体两种写法（且 tid 跨项目重复 13 个，
// 实测 `tid=1` 同时存在于 projects 5~10）。

import { fail, ok, type Result } from './types.js';

export type Ns =
    | { readonly kind: 'global' }
    | { readonly kind: 'project' }
    | { readonly kind: 'task'; readonly taskUri: string };

export const NS_KINDS = ['global', 'project', 'task'] as const;

/**
 * 任务 URI 的**形状**判据（`projects/<pid>/tasks/<tid>`）。
 * 存在性不在这里判 —— 内核零 IO，目录在不在由消费侧（`loadRepo` / CLI）负责。
 */
const TASK_URI_SHAPE = /^projects\/[^/:\s]+\/tasks\/[^/:\s]+$/;

/** claim 形状（`subject#aspect`，两侧都不含 `:` `#` 空白 —— 与 validate 的禁字符一致） */
const CLAIM_SHAPE = /^[^#:\s]+#[^#:\s]+$/;

export function formatNs(ns: Ns): string {
    switch (ns.kind) {
        case 'global':
            return 'global';
        case 'project':
            return 'project';
        case 'task':
            return `task:${ns.taskUri}`;
    }
}

export function parseNs(text: string): Result<Ns> {
    const t = text.trim();
    if (t === 'global') return ok({ kind: 'global' });
    if (t === 'project') return ok({ kind: 'project' });
    if (t.startsWith('task:')) {
        const taskUri = t.slice('task:'.length);
        if (!TASK_URI_SHAPE.test(taskUri)) {
            return fail('facts/ns-invalid', `任务命名空间必须形如 task:projects/<pid>/tasks/<tid>：${t}`);
        }
        return ok({ kind: 'task', taskUri });
    }
    return fail('facts/ns-invalid', `未知命名空间：${t}（合法：global / project / task:<projects/N/tasks/M>）`);
}

export function sameNs(a: Ns, b: Ns): boolean {
    return formatNs(a) === formatNs(b);
}

/** 命名空间优先级（投递裁剪用）：任务 > 项目 > 全局，数值小者优先保留 */
export function nsRank(ns: Ns): number {
    return ns.kind === 'task' ? 0 : ns.kind === 'project' ? 1 : 2;
}

export function formatGid(ns: Ns, claim: string): string {
    return `${formatNs(ns)}:${claim}`;
}

/**
 * 解析 gid。`ns` 与 `claim` 的分界是**最后一个** `:` ——
 * 这样 `task:projects/4/tasks/404:dev.check#entry` 能切对（uri 里禁 `:`，claim 里也禁）。
 */
export function parseGid(gid: string): Result<{ readonly ns: Ns; readonly claim: string }> {
    const t = gid.trim();
    const i = t.lastIndexOf(':');
    if (i < 0) {
        return fail('facts/ns-invalid', `gid 必须带命名空间前缀（如 project:app.port#default）：${t}`);
    }
    const ns = parseNs(t.slice(0, i));
    if (!ns.ok) return ns;
    const claim = t.slice(i + 1);
    if (!CLAIM_SHAPE.test(claim)) {
        return fail('facts/ns-invalid', `claim 形状非法（应为 subject#aspect，两侧都不含 : # 空白）：${claim}`);
    }
    return ok({ ns: ns.value, claim });
}

/**
 * 解析一个**可能是短写**的引用：不含 `:` = 本库（`claim`），含 `:` = 全 gid。
 *
 * 边（`refs`）与命令行都用这条规则 —— 同库写短的、跨库写全的，一句话无歧义。
 */
export function resolveRef(claimOrGid: string, self: Ns): Result<{ readonly ns: Ns; readonly claim: string }> {
    const t = claimOrGid.trim();
    return t.includes(':') ? parseGid(t) : ok({ ns: self, claim: t });
}
