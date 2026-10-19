/**
 * `@` 成员寻址补全（##377 第 11 刀 / ##166 §37.2 B·C）。
 *
 * **触发判据 = 与投递同一份**：`addressQueryAt`（`shared/room.ts`）就是 `parseAddress` 的
 * 「光标版本」—— 剥掉前面所有已完整的地址，剩下的正好是「`@` + 未输完的名字」才命中。
 *
 * ⇒ **句中不弹**（`请 @dev 看下`）：服务端只认开头，句中弹会让用户以为投递了、实际没有，
 *   **比没有补全更坏**（§28.7 A「UI 提示 = 服务端真会投给谁」）。
 *
 * **插入形态**：`@<成员名> `（**尾随一个空格**，便于接着连写第二个收件人或打正文）。
 * 面板里直接显示可插入的名字 —— 顺带缓解 §377 踩坑 25 的「`@main` 反直觉」
 * （成员名 = 人物名，不是 id 后缀；用户看到什么名字就打什么名字）。
 *
 * 数据源由调用方注入（`() => 成员表`）：**只有 room 场景有成员概念**，
 * 任务对话页 / prompt lab 不传 ⇒ 不接这个源（§37.2 A「不传 = 行为逐字不变」）。
 */
import type { Completion, CompletionSource } from "@codemirror/autocomplete";
import { addressQueryAt, isAllAddress, type RoomMember } from "../../../shared/room";

/** `@all` 的候选（群发是合法收件人写法，一并列出 —— §28.5 B） */
const ALL_OPTION: Completion = {
    label: "@all",
    detail: "群发（房间里所有 agent 成员）",
    type: "keyword",
    apply: "@all ",
};

export function memberCompletion(members: () => readonly RoomMember[]): CompletionSource {
    return (ctx) => {
        // 用**文档开头到光标**的整段文本判据（`parseAddress` 就是看整段文本的开头，不是看行）
        const before = ctx.state.sliceDoc(0, ctx.pos);
        const at = addressQueryAt(before);
        if (!at) return null;
        const q = at.query.toLowerCase();

        // 收件人只可能是 **agent** 成员：人成员不是投递目标（他本人在场，发言他自己看得见 ——
        // `resolveRecipients` 的 `@all` 也只展开 agent）。判据与投递同源。
        const agents = members().filter((m) => m.kind === "agent");
        const hit = agents.filter((m) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));

        const options: Completion[] = [];
        // `@all` 只在不与具体名字冲突时列（输入了具体前缀就别混进来）
        if (!q || isAllAddress(q) || "all".startsWith(q)) options.push(ALL_OPTION);
        for (const m of hit) {
            options.push({
                label: `@${m.name}`,
                // backend 是判别联合（`rule.discriminated-union`：公共字段同级、分支私有进 `data`）
                detail: m.backend ? `→ ${m.backend.data.taskUri}` : m.id,
                type: "variable",
                apply: `@${m.name} `,
            });
        }
        if (options.length === 0) return null;
        return { from: at.from, options, filter: false };
    };
}
