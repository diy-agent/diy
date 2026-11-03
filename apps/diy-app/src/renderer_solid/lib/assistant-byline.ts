/**
 * assistant-byline — 对话署名取哪份数据（纯函数，零依赖，node 环境可单测）
 *
 * 为什么要单独一个模块（任务 196 的根因）：署名原先读的是「当前任务绑定人物 / 缺省」，
 * 于是改一次 `personas.yaml` 的 default，**全部历史回复的署名一起被改写** —— 界面说
 * "这轮是大副答的"，而该轮 ops 首行写着 mimo-v2.6-flash。署名成了当前配置的投影。
 *
 * 事实其实一直都在：main 的 local-agent 在 turn start 的 meta 里记了当轮 model，
 * local-blocks 把 meta 逐键落进块 attrs → `turn.attrs.model`。所以只在渲染层换数据源即可。
 *
 * 两种来源**绝不混用**：
 *   - 该轮记了 model  → 以它为准。名字只在"当前人物模型也等于它"时附上（此时名字与事实无歧义）；
 *                       模型不同则**只显示模型**，不拿当前人物的名字去顶替（那就是原 bug）
 *   - 该轮没记（旧会话）→ 回落当前人物，但 inferred=true，界面必须显式写出"推断"
 */

export interface BylineFacts {
    /** 该轮记录的实际模型（`turn.attrs.model`，源自 ops turn start 的 meta）；旧会话无此记录 */
    turnModel?: unknown;
    /** 当前生效人物的名字（清单未加载时可为 null/undefined） */
    personaName?: string | null;
    /** 当前生效人物的模型（清单未加载时可为 null/undefined） */
    personaModel?: string | null;
}

export interface Byline {
    /** 人物名；null = 无法确定是谁答的，只以模型标识这一轮 */
    name: string | null;
    /** 署名里展示的模型（可能为空串：旧会话且人物清单还没到） */
    model: string;
    /** true = 该轮没有记录，这行字是当前配置的**推断**（界面必须标注，不假装确定） */
    inferred: boolean;
    /** hover 说明：这行字的来源（该轮事实 / 推断） */
    title: string;
}

export function bylineOf(facts: BylineFacts): Byline {
    const recorded = typeof facts.turnModel === "string" ? facts.turnModel.trim() : "";
    if (recorded) {
        // 仅当当前人物的模型与该轮一致时，人物名才与事实自洽（否则名字会指向另一个模型的人）
        const name = facts.personaModel === recorded ? facts.personaName || null : null;
        return {
            name,
            model: recorded,
            inferred: false,
            title: name
                ? `本轮模型 ${recorded}（取自本轮会话记录）；「${name}」按当前人物模型匹配，仅供参考`
                : `本轮模型 ${recorded}（取自本轮会话记录；与当前人物的模型不同，无法确定是谁，故不标人物名）`,
        };
    }
    return {
        name: facts.personaName || null,
        model: facts.personaModel || "",
        inferred: true,
        title: `本轮没有留下模型记录（旧会话），这里按当前人物「${facts.personaName || "未知"}」显示，属于推断，仅供参考`,
    };
}
