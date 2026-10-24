// src/kb-index.ts — 知识库索引的**折叠**（纯函数）—— ##404 / ##5 第 9 轮
//
// 要治的病：索引是每轮固定前缀，主题数会随迁入线性涨（agent 视角 ≈100 B/主题）。
// 41 个主题 ≈ 4 KB/轮，全仓所有任务都付。而**索引是给「知道该查什么」用的，不是给
// 「知道有什么」用的** —— 后者只在需要发现时付一次 `diy facts brief <前缀>.*`。
//
// 判据（为什么不按条数/字节动态决定）：
//   - 动态阈值会让索引内容随库大小漂移 —— 同一句话今天有、明天没，agent 无法建立稳定预期
//   - 前缀是**人写主题时就有的结构**（`app.find` / `app.rule` / `app.history`），折叠它
//     不发明新分组，只是把已有的层级显式化
//   - 同前缀 ≥ `minGroup` 个主题才折；少于则不折（折了反而多一层跳转）
//
// 折叠项的 desc 必须自带**展开方法**：agent 看到 `app.* (11 主题 / 154 条)` 时唯一能做的
// 事就是照 desc 里的命令展开 —— 否则「省了字节、断了去路」。

/** 索引里只出现两种库（任务库不进 kb 索引：它按 ns 缺省 full 走正文） */
export type KbNs = 'project' | 'global';

export interface KbSubjectEntry {
    readonly subject: string;
    readonly desc: string;
    readonly claims: number;
    readonly ns: readonly KbNs[];
}

export interface KbFoldOptions {
    /** 同前缀至少几个主题才折叠（缺省 3：两个主题折起来省不下跳转成本） */
    readonly minGroup?: number;
}

export const KB_FOLD_MIN_GROUP = 3;

/**
 * 按主题前缀折叠：`app.find` / `app.entry` / `app.rule`（≥ minGroup 个）→ 一条 `app.*`。
 * 无前缀（不含 `.`）或同前缀数量不足的保持原样。返回按主题名排序。
 */
export function foldKbIndex(entries: readonly KbSubjectEntry[], opts: KbFoldOptions = {}): KbSubjectEntry[] {
    const min = Math.max(2, opts.minGroup ?? KB_FOLD_MIN_GROUP);
    const groups = new Map<string, KbSubjectEntry[]>();
    const singles: KbSubjectEntry[] = [];
    for (const e of entries) {
        const dot = e.subject.indexOf('.');
        if (dot <= 0) {
            singles.push(e);
            continue;
        }
        const prefix = e.subject.slice(0, dot);
        const list = groups.get(prefix);
        if (list === undefined) groups.set(prefix, [e]);
        else list.push(e);
    }
    const out: KbSubjectEntry[] = [];
    // 裸前缀主题并入同前缀折叠组（`dev` 与 `dev.*` 并存时，两行读起来像两个不相干的主题 ——
    // 而 `dev` 本身就是 `dev.xxx` 的父。实测库里三处：`dev` / `rule` / `model`）
    const bare = new Map(singles.map((e) => [e.subject, e]));
    for (const [prefix, list] of groups) {
        const own = bare.get(prefix);
        if (own !== undefined && list.length >= min - 1) {
            list.push(own);
            bare.delete(prefix);
        }
    }
    out.push(...bare.values());
    for (const [prefix, list] of groups) {
        if (list.length < min) {
            out.push(...list);
            continue;
        }
        const ns: KbNs[] = [];
        let claims = 0;
        for (const e of list) {
            claims += e.claims;
            for (const n of e.ns) if (!ns.includes(n)) ns.push(n);
        }
        // 折叠的唯一代价是「看不见有哪些」⇒ desc 直接**列出主题名**，而不是「怎么展开」。
        // 曾写「`diy facts brief app.*` 展开」—— 实测 43.5 KB（12 个主题全展开），
        // 是索引自己推荐出来的上下文炸弹；`--budget` 救不了（按字符估算，2000 预算仍出 26 KB）。
        // 给名字 ⇒ agent 直接 `brief app.cli`（单主题 2~4 KB），一步到位。
        const names = list.map((e) => e.subject).sort((a, b) => a.localeCompare(b));
        const SHOW = 6;
        const shown = names.length > SHOW ? [...names.slice(0, SHOW), `…共 ${names.length} 个`] : names;
        out.push({
            subject: `${prefix}.*`,
            desc: shown.join(", "),
            claims,
            ns,
        });
    }
    out.sort((a, b) => a.subject.localeCompare(b.subject));
    return out;
}
