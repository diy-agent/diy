// tests/core/chat-fold.test.ts — 轮次折叠语义（显示什么、按什么序、实时区给谁）
//
// 这些是**用户看得见的语义**，不是样式：顺序错一次就是"助理消息跑到用户消息上面"
//（2026-10-04 现象），实时区判错一次就是"步骤一完就空白"或"同一句出现两遍"（review P1-1）。
// 故钉在这里，组件只管画。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    DEFAULT_TURN_LEVEL,
    TURN_DETAIL_LAYER,
    TURN_LEVEL_MAX,
    clampLines,
    contentItems,
    cycleTurnLevel,
    expandableOf,
    historyOpenOf,
    isFailedTool,
    isInterruptedToolBlock,
    isProc,
    isTurnLevel,
    isUserText,
    conclusionOf,
    composeTail,
    endLeafTip,
    endMarkOf,
    endReasonOf,
    leadUsers,
    sceneTailOf,
    turnEndNote,
    leavesOf,
    liveTailOf,
    planOfLevel,
    procOpenOf,
    procStatusOf,
    tailOf,
    turnLevelLabel,
    turnRows,
} from "../../src/renderer_solid/lib/chat-fold";
import type { BlockNode } from "../../src/main/services/local-blocks";

function n(
    tag: string,
    id: string,
    attrs: Record<string, unknown> = {},
    children: BlockNode[] = [],
    stopped = true,
): BlockNode {
    return { tag, id, stopped, touched: 0, attrs, children };
}
const user = (id: string) => n("text", id, { role: "user", content: id });
const say = (id: string, stopped = true) => n("text", id, { content: id }, [], stopped); // 助理正文
const think = (id: string, stopped = true) => n("think", id, { content: "…" }, [], stopped);
const tool = (id: string, stopped = true, status = "done") =>
    n("tool", id, { tool: "bash", title: id, status }, [], stopped);
const err = (id: string) => n("error", id, { source: "llm", message: id });
const step = (id: string, kids: BlockNode[]) => n("step", id, {}, kids);
const turn = (...kids: BlockNode[]) => n("turn", "t1", {}, kids);
/** 带 `endReason` 的轮（结尾槽 / 现场 / 结束点的判据都读它） */
const ended = (type: string, data: Record<string, unknown> = {}, kids: BlockNode[] = []): BlockNode =>
    n("turn", "t1", { endReason: { type, data } }, kids);

describe("leavesOf：文档序拉平", () => {
    it("step 是纯容器，DFS 顺序 = 时间顺序", () => {
        const t = turn(step("s1", [user("u1"), think("k1")]), step("s2", [say("a1")]));
        expect(leavesOf(t).map((x) => x.id)).toEqual(["u1", "k1", "a1"]);
    });

    it("嵌套容器（旧日志的嵌套 turn）也向下递归，不整段丢", () => {
        const t = turn(user("u1"), turn(think("k1"), say("a1")));
        expect(leavesOf(t).map((x) => x.id)).toEqual(["u1", "k1", "a1"]);
    });
});

describe("leadUsers：轮首用户发言（渲染在轮次头之前）", () => {
    it("轮首连续的用户发言是 lead（IM 顺序：用户先说、助理的身份行再接）", () => {
        const t = turn(user("u1"), say("a1"), tool("x1"));
        expect(leadUsers(t).map((x) => x.id)).toEqual(["u1"]);
    });

    it("只取**开头连续**的：轮中插话不算 lead（提前 = 又一次重排）", () => {
        const t = turn(user("u1"), say("a1"), user("u2"), say("a2"));
        expect(leadUsers(t).map((x) => x.id)).toEqual(["u1"]);
    });

    it("助理先开口（无用户发言）时 lead 为空，轮次头仍在最上", () => {
        expect(leadUsers(turn(think("k1"), say("a1")))).toEqual([]);
    });

    it("轮首那批**不进历史行**（由调用方单独画，避免同一句画两遍）；轮中插话仍在历史里就地", () => {
        const t = turn(user("u1"), say("a1"), tool("x1"), user("u2"), say("a9"));
        expect(leadUsers(t).map((x) => x.id)).toEqual(["u1"]);
        const keys = turnRows(t, null).map((r) => r.key);
        expect(keys).not.toContain("u1"); // 轮首：调用方画
        expect(keys).toContain("u2"); // 轮中插话：留在历史（就地，不提前）
        expect(keys).toContain("a1"); // 更早的过程正文：3 级起可见
        expect(keys).not.toContain("a9"); // 结论：属结尾槽，不进历史
    });
});

describe("liveTailOf：活动块（就地画在文档序里）", () => {
    it("非直播轮次没有活动块", () => {
        expect(liveTailOf(turn(user("u1"), tool("x1", false)), false)).toBeNull();
    });

    it("一步在跑 → 就是它（渲染侧看 stopped=false ⇒ 实时刷）", () => {
        const t = turn(user("u1"), tool("x1", false));
        expect(liveTailOf(t, true)).toBe(leavesOf(t)[1]);
        expect(liveTailOf(t, true)!.stopped).toBe(false);
    });

    it("一步跑完、后面还没有内容 → **仍然返回它**（冻结：框不消失，等下一步替换）", () => {
        const t = turn(user("u1"), tool("x1"));
        expect(liveTailOf(t, true)!.id).toBe("x1");
        expect(liveTailOf(t, true)!.stopped).toBe(true);
    });

    it("**正文也是「收取中的数据」**：text 一生效，活动块就是它（2026-10-11 口径修正）", () => {
        // 旧规则（R17）活动块只认过程叶子 ⇒ 正文流在框**下面**，正文流完再遇到工具时
        // 又整段跳回框上面（用户实测的"消失跳位"）。新口径：中间载体装**所有**收取中的东西。
        const t = turn(tool("x1"), say("a1", ));
        expect(liveTailOf(t, true)!.id).toBe("a1");
    });

    it("跑完后的用户插话不改变判据（活不活跃只看「最后一个非用户叶子」）", () => {
        const t = turn(tool("x1"), user("u2"));
        expect(liveTailOf(t, true)!.id).toBe("x1");
    });

    it("还没有任何助理内容 → 没有活动块（那段时间交给「等待响应」loading）", () => {
        expect(liveTailOf(turn(user("u1")), true)).toBeNull();
    });

    it("取的是**文档序最后一个非用户叶子**（think/tool/text 混排也一样）", () => {
        const t = turn(think("k1"), tool("x1"), think("k2", false));
        expect(liveTailOf(t, true)!.id).toBe("k2");
        const t2 = turn(think("k1"), tool("x1"), say("a1", ));
        expect(liveTailOf(t2, true)!.id).toBe("a1");
    });
});

describe("isUserText / isProc", () => {
    it("按 role 判用户发言，按 tag 判过程块", () => {
        expect(isUserText(user("u"))).toBe(true);
        expect(isUserText(say("a"))).toBe(false);
        expect(isProc(think("k"))).toBe(true);
        expect(isProc(tool("x"))).toBe(true);
        expect(isProc(say("a"))).toBe(false);
    });
});

describe("展开级别：循环 1→2→3→4→1", () => {
    it("逐级上升，到头回到 1（点完最深层回最浅层）", () => {
        let l = DEFAULT_TURN_LEVEL;
        const seen: number[] = [];
        for (let i = 0; i < 4; i++) {
            l = cycleTurnLevel(l);
            seen.push(l);
        }
        expect(seen).toEqual([4, 1, 2, 3]); // 从默认 3 出发
    });

    it("脏值不入级别（isTurnLevel 是唯一判据）", () => {
        for (const bad of [0, 5, -1, 2.5, "3", null, undefined, NaN]) {
            expect(isTurnLevel(bad), String(bad)).toBe(false);
        }
        for (const good of [1, 2, 3, 4]) expect(isTurnLevel(good)).toBe(true);
    });

    it("每级各有一句人话（tip/aria 用，不写死在组件里）", () => {
        expect([1, 2, 3, 4].map((l) => turnLevelLabel(l as 1 | 2 | 3 | 4))).toEqual([
            "摘要结论",
            "完整结论",
            "全部正文",
            "逐条过程",
        ]);
    });

    it("第 5 层（单条过程内容）不在这条循环里：MAX 就是 4，循环永远到不了 5", () => {
        expect(TURN_LEVEL_MAX).toBe(4);
        expect(TURN_DETAIL_LAYER).toBe(TURN_LEVEL_MAX + 1);
        let l = DEFAULT_TURN_LEVEL;
        const touched: number[] = [];
        for (let i = 0; i < 12; i++) touched.push((l = cycleTurnLevel(l)));
        expect(Math.max(...touched)).toBe(TURN_LEVEL_MAX);
    });
});

describe("historyOpenOf：历史开不开（级别只改「历史展开多少」）", () => {
    it("没动过 → 跟全局：3 级起开、1-2 级闭", () => {
        expect([1, 2, 3, 4].map((g) => historyOpenOf(undefined, g as 1 | 2 | 3 | 4))).toEqual([
            false,
            false,
            true,
            true,
        ]);
    });

    it("收拢 → 恒闭（任何级别）", () => {
        for (const g of [1, 2, 3, 4] as const) expect(historyOpenOf(true, g)).toBe(false);
    });

    it("展开 → 恒开 —— **1 级下点人物栏也能直接开历史**（不必先切到 3 级）", () => {
        for (const g of [1, 2, 3, 4] as const) expect(historyOpenOf(false, g)).toBe(true);
    });
});

describe("planOfLevel：每一级看得见什么（只管两处）", () => {
    it("1 级结论压摘要 · 2 级结论全文 · 3 级历史缺省开 · 4 级过程 bar 铺开", () => {
        expect(planOfLevel(1)).toEqual({ conclusionClamped: true, midExpanded: false, historyOpen: false });
        expect(planOfLevel(2)).toEqual({ conclusionClamped: false, midExpanded: false, historyOpen: false });
        expect(planOfLevel(3)).toEqual({ conclusionClamped: false, midExpanded: false, historyOpen: true });
        expect(planOfLevel(4)).toEqual({ conclusionClamped: false, midExpanded: true, historyOpen: true });
    });

    it("级别单调：往上一级只会多显示（摘要只会变全文），不会少", () => {
        for (let l = 1; l < TURN_LEVEL_MAX; l++) {
            const a = planOfLevel(l as 1 | 2 | 3 | 4);
            const b = planOfLevel((l + 1) as 1 | 2 | 3 | 4);
            expect(Number(b.conclusionClamped)).toBeLessThanOrEqual(Number(a.conclusionClamped));
            expect(Number(b.historyOpen)).toBeGreaterThanOrEqual(Number(a.historyOpen));
            expect(Number(b.midExpanded)).toBeGreaterThanOrEqual(Number(a.midExpanded));
        }
    });
});

describe("contentItems：3 级起的中间区（正文逐条 + 连续过程一行 bar）", () => {
    /** 视图：正文/用户/error 取 id，过程段取「首叶子 id + 段内 id 表」 */
    const view = (its: ReturnType<typeof contentItems>) =>
        its.map((i) =>
            i.kind === "proc"
                ? { proc: i.key, parts: i.parts.map((n) => n.id) }
                : { kind: i.kind, id: i.node.id },
        );

    it("正文各自成项（不折行），连续过程折成一行 bar —— 文档序原样", () => {
        // 思考+工具 → 正文① → 思考+工具 → 正文②（②是末条，也照样各自成项）
        const t = turn(think("k1"), tool("x1"), say("a1"), think("k2"), tool("x2"), say("a2"));
        expect(view(contentItems(t))).toEqual([
            { proc: "k1", parts: ["k1", "x1"] },
            { kind: "text", id: "a1" },
            { proc: "k2", parts: ["k2", "x2"] },
            { kind: "text", id: "a2" },
        ]);
    });

    it("顺序 = 文档序：「思考 → 正文」在界面上就是思考的 bar 在前（旧版把正文提到工具前，用户实测踩到）", () => {
        const t = turn(think("k1"), say("a1"));
        expect(view(contentItems(t))).toEqual([
            { proc: "k1", parts: ["k1"] },
            { kind: "text", id: "a1" },
        ]);
    });

    it("用户插话与 error 就地单独成项，并**切断**过程段（两侧的过程不并成一行）", () => {
        const t = turn(user("u1"), think("k1"), say("a1"), user("u2"), err("e1"), think("k2"), say("a9"));
        expect(view(contentItems(t))).toEqual([
            { proc: "k1", parts: ["k1"] },
            { kind: "text", id: "a1" },
            { kind: "user", id: "u2" },
            { kind: "error", id: "e1" },
            { proc: "k2", parts: ["k2"] },
            { kind: "text", id: "a9" },
        ]);
    });

    it("轮首用户发言交给 leadUsers 单独画（此处排除，避免同一句画两遍）", () => {
        const t = turn(user("u1"), say("a1"));
        expect(view(contentItems(t))).toEqual([{ kind: "text", id: "a1" }]);
    });

    it("skip 掉活动块那个节点：它带定高展开体单独画，留在文档序里就是同一块画两遍", () => {
        const t = turn(think("k1"), tool("x1", false), say("a1"));
        const live = leavesOf(t)[1];
        expect(view(contentItems(t, (n) => n === live))).toEqual([
            { proc: "k1", parts: ["k1"] },
            { kind: "text", id: "a1" },
        ]);
    });

    it("段整个被 skip 掉时**不出空段**（否则界面上多一条空白 bar）", () => {
        const t = turn(think("k1"), say("a1"));
        const live = leavesOf(t)[0];
        expect(view(contentItems(t, (n) => n === live))).toEqual([{ kind: "text", id: "a1" }]);
    });

    it("段的 key = 段内首个叶子 id（供 <For> / pin 复用，跨帧稳定）", () => {
        const t = turn(think("k1"), tool("x1"), think("k2"), say("a1"));
        expect(contentItems(t)[0]!.key).toBe("k1");
    });
});

describe("conclusionOf：结论 = 文档序**最后一个叶子**恰好是助理正文", () => {
    it("模型说完就停（正文在末尾）→ 是结论", () => {
        const t = turn(user("u1"), think("k1"), tool("x1"), say("a9"));
        expect(conclusionOf(t)!.id).toBe("a9");
    });

    it("中途被打断（末叶子是工具）→ **没有结论**（旧判据会把中间那句过程话当结论，用户报的 bug）", () => {
        const t = turn(user("u1"), say("a1"), tool("x1", false));
        expect(conclusionOf(t)).toBeNull();
        // 于是结尾槽按"结束点"给那个工具（见 tailOf）—— 不再伪造一条"像结论"的假话
        expect(tailOf(t, null)).toMatchObject({ kind: "endleaf" });
    });

    it("末叶子是 think / error 同样没有结论", () => {
        expect(conclusionOf(turn(say("a1"), think("k1", false)))).toBeNull();
        expect(conclusionOf(turn(say("a1"), err("e1")))).toBeNull();
    });

    it("末叶子是用户插话 → 正文仍是结论（插话不等于助理说了新话）", () => {
        const t = turn(say("a1"), user("u2"));
        expect(conclusionOf(t)!.id).toBe("a1");
    });
});

describe("sceneTailOf / composeTail：异常结束的「现场」", () => {
    const ended = (type: string, kids: BlockNode[], data: Record<string, unknown> = {}): BlockNode =>
        n("turn", "t1", { endReason: { type, data } }, kids);

    it("completed / max-tokens → 无现场（正文即结论，notice 已说清）", () => {
        expect(sceneTailOf(ended("completed", [tool("x1")]))).toBeNull();
        expect(sceneTailOf(ended("max-tokens", [say("a1")]))).toBeNull();
    });

    it("aborted / interrupted / error / max-steps + 末叶子不是正文 → 末叶子就是现场", () => {
        for (const ty of ["aborted", "interrupted", "error", "max-steps"]) {
            const t = ended(ty, [say("a1"), tool("x1", false)]);
            expect(sceneTailOf(t)!.id, ty).toBe("x1");
        }
    });

    it("异常结束但**末叶子是正文** → 不另开现场（那本就是结论，避免同一句画两遍）", () => {
        expect(sceneTailOf(ended("aborted", [tool("x1"), say("a1")]))).toBeNull();
    });

    it("旧日志（无 endReason）用 attrs.interrupted 兜底", () => {
        const t = n("turn", "t1", { interrupted: true }, [tool("x1", false)]);
        expect(sceneTailOf(t)!.id).toBe("x1");
        expect(sceneTailOf(n("turn", "t1", {}, [tool("x1", false)]))).toBeNull();
    });

    it("composeTail：末叶子是 error → 红条压顶 + 主体取它前一个非 error 叶子", () => {
        const t = ended("error", [tool("x1", false), err("e1")]);
        const sc = composeTail(t, sceneTailOf(t))!;
        expect(sc.error!.id).toBe("e1");
        expect(sc.body!.id).toBe("x1");
    });

    it("composeTail：普通末叶子 → 主体就是它、无错误条", () => {
        const t = ended("aborted", [tool("x1", false)]);
        expect(composeTail(t, sceneTailOf(t))).toEqual({ body: leavesOf(t)[0], error: null });
        expect(composeTail(t, null)).toBeNull();
    });

    it("error 前面没有内容 → 主体为 null（只出红条，不造空体）", () => {
        const t = ended("error", [err("e1")]);
        expect(composeTail(t, sceneTailOf(t))).toEqual({ body: null, error: leavesOf(t)[0] });
    });
});

describe("turnEndNote：结束原因翻成人话（所有级别恒显）", () => {
    const ended = (type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
        n("turn", "t1", { endReason: { type, data }, ...extra });

    it("每个值域都有一句（不给 UI 留 undefined）", () => {
        for (const ty of ["completed", "max-steps", "max-tokens", "aborted", "error", "interrupted"]) {
            const note = turnEndNote(ended(ty, { limit: 60, maxOutputTokens: 4000, source: "abort", message: "x" }));
            if (ty === "completed" || ty === "error") expect(note, ty).toBeNull();
            else expect(note, ty).toBeTruthy();
        }
    });

    it("notice（含限制值的那句）优先于兜底文案", () => {
        expect(turnEndNote(ended("max-steps", { limit: 60 }, { notice: "达到 maxSteps=60 步上限…" }))).toBe(
            "达到 maxSteps=60 步上限…",
        );
    });

    it("max-steps 没带 notice 也能说清（限制值来自 endReason.data）", () => {
        expect(turnEndNote(ended("max-steps", { limit: 8 }))).toContain("8");
    });

    it("aborted 按 source 分三句：用户停止 / 流中断 / 来源不明（##308 统一语义）", () => {
        // 判据是 `source`，不是"有没有 detached"：main 的中止 error 块与这里同源同句
        // （唯一文案源 shared/turn-end 的 `abortText`），不再一个轮次两个结论。
        expect(turnEndNote(ended("aborted", { source: "user" }))).toBe("生成已取消");
        // ##305 起 `detached` 不再表示"消费端断开"（刷新只退订、不打断）——只剩"流意外中断"
        expect(turnEndNote(ended("aborted", { source: "detached" }))).toContain("流中断");
        // 旧日志里用户停止也不带 reason（`"abort"`）→ 不冒充用户停止，按"被中断、未跑完"说
        expect(turnEndNote(ended("aborted", { source: "abort" }))).toContain("被中断");
    });

    it("error 的细节由 error 块/现场说 —— 这一行不重复", () => {
        expect(turnEndNote(ended("error", { source: "stream", message: "x" }))).toBeNull();
    });

    it("旧日志（无 endReason）：沿用 attrs.interrupted / notice", () => {
        expect(turnEndNote(n("turn", "t1", { interrupted: true }))).toContain("本轮未完成");
        expect(turnEndNote(n("turn", "t1", { notice: "截断了" }))).toBe("截断了");
        expect(turnEndNote(n("turn", "t1", {}))).toBeNull();
    });

    it("endReasonOf 挡住脏值", () => {
        expect(endReasonOf(n("turn", "t1", { endReason: "completed" }))).toBeNull();
        expect(endReasonOf(n("turn", "t1", { endReason: { type: "completed", data: {} } }))).toEqual({
            type: "completed",
            data: {},
        });
    });
});

describe("clampLines：1 级摘要按行截断", () => {
    it("行数不超上限 → 原样，omitted=0（短结论不该显示「已折叠 0 行」）", () => {
        expect(clampLines("a\nb", 3)).toEqual({ text: "a\nb", omitted: 0 });
    });

    it("超出 → 只留前 N 行，并报出被藏起来的行数", () => {
        expect(clampLines("a\nb\nc\nd", 2)).toEqual({ text: "a\nb", omitted: 2 });
    });

    it("按行切而不是按字符切：代码块/列表不会被切在中间", () => {
        expect(clampLines("```\nx=1\n```\ntail", 3).text).toBe("```\nx=1\n```");
    });

    // review ##253 RV-2：前导空行在 Markdown 里没有语义（首个块之前本来就被吃掉），
    // 却会占满摘要的行额度 —— 摘要的语义是"看得见内容"。
    it("前导空行不占额度：`\\n\\n正文` 在 2 行额度下仍看得见正文", () => {
        expect(clampLines("\n\n正文", 2)).toEqual({ text: "正文", omitted: 0 });
        // 额度用完之后照旧按行截（前导空行只是不参与计数，不许把正文一起吞了）
        expect(clampLines("\n\n一行\n二行\n三行", 2)).toEqual({ text: "一行\n二行", omitted: 1 });
    });

    // review ##253 RV-6：正文行的"能不能折"由 `omitted > 0` 判（组件 `TextRow.canFold`）——
    // 前导空行不占额度之后，这种输入**不该**再给出箭头（旧判据按原始行数 5 > 3 给箭头，
    // 点开却和标题一模一样：箭头承诺了不存在的东西）。
    it("前导空行吃掉的行数不算「还能展开」：omitted=0 ⇒ 组件不给箭头", () => {
        expect(clampLines("\n\n一行\n二行\n三行", 3)).toEqual({ text: "一行\n二行\n三行", omitted: 0 });
        // 真多出一行就照旧给（底线：判据只差"前导空行"，不是把折叠能力整体关掉）
        expect(clampLines("\n\n一行\n二行\n三行\n四行", 3)).toEqual({ text: "一行\n二行\n三行", omitted: 1 });
    });
});

// ─── 级别同构（2026-10-11 用户口径：「级别显示应该是同构的，尽量不要特殊处理」） ───

describe("expandableOf：这一行点开会不会多出东西", () => {
    it("思考只有一行 → 不给展开能力（展开体与标题是同一句）", () => {
        expect(expandableOf(n("think", "k1", { content: "想一下" }))).toBe(false);
        expect(expandableOf(n("think", "k2", { content: "" }))).toBe(false);
    });

    it("思考多行 / 单行超长（标题会被裁到 90 字）→ 可展开", () => {
        expect(expandableOf(n("think", "k1", { content: "第一行\n第二行" }))).toBe(true);
        expect(expandableOf(n("think", "k2", { content: "x".repeat(91) }))).toBe(true);
        expect(expandableOf(n("think", "k3", { content: "x".repeat(90) }))).toBe(false);
    });

    it("工具恒可展开：它有 result / 完整命令可看", () => {
        expect(expandableOf(tool("x1"))).toBe(true);
    });

    // review ##253 RV-2：判据必须与标题（`firstLine` 跳过前导空行）**同一套**，
    // 否则 content = "\n只有一行" 会被判成可展开，点开后体里与标题是同一句（"像坏了"）。
    it("前导空行不改变判据：`\\n只有一行` 仍不给展开能力，`\\n一行\\n两行` 仍可展开", () => {
        expect(expandableOf(n("think", "k1", { content: "\n只有一行" }))).toBe(false);
        // 只有空行 / 空白 → 同样没东西可展（标题会退回"思考"两字）
        expect(expandableOf(n("think", "k2", { content: "\n  \n" }))).toBe(false);
        expect(expandableOf(n("think", "k3", { content: "\n一行\n两行" }))).toBe(true);
        // 单行超长那条底线别丢：前导空行 + 超长单行照样可展开（标题会被裁到 90 字）
        expect(expandableOf(n("think", "k4", { content: `\n${"x".repeat(91)}` }))).toBe(true);
        expect(expandableOf(n("think", "k5", { content: `\n${"x".repeat(90)}` }))).toBe(false);
    });
});

describe("turnRows：过程历史行（**不含结尾槽**）", () => {
    const t = turn(
        step("s1", [user("u1")]),
        step("s2", [think("k1"), tool("x1")]),
        step("s3", [say("a1")]),
    );
    const shape = (rows: ReturnType<typeof turnRows>) =>
        rows.map((r) => (r.kind === "proc" ? `proc:${r.parts.map((p) => p.id).join(",")}` : `${r.kind}:${r.key}`));

    it("结论不进历史行（它属结尾槽）；过程折成一行 bar；轮首用户不进（由调用方画）", () => {
        expect(shape(turnRows(t, null))).toEqual(["proc:k1,x1"]);
    });

    it("直播中：活动块那一个叶子从历史里剔掉（结尾槽画它，不画两遍）", () => {
        const live = think("k1");
        const rows = turnRows(t, live);
        expect(rows.some((r) => r.kind === "proc" && r.parts.some((p) => p.id === "k1"))).toBe(false);
        expect(rows.some((r) => r.kind === "proc" && r.parts.some((p) => p.id === "x1"))).toBe(true);
    });

    // review ##253 RV-1：末叶子是 error 时，尾槽画的是「红条 + 它前面那个叶子（body）」——
    // body 也算"被尾槽占用了"，否则同一块在过程历史里再画一遍（默认 3 级、尾槽默认展开，
    // 不点任何东西就能看见上下各一份）。这条 R20 修过、R21 级别同构重构时收了 owned 又丢了。
    it("现场：末件是 error 时，现场主体（它前面那个叶子）不进历史行", () => {
        const t = ended("error", {}, [step("s1", [tool("x1"), err("e1")])]);
        const body = composeTail(t, sceneTailOf(t))!.body!;
        expect(body.id).toBe("x1");
        expect(turnRows(t, null).some((r) => r.kind === "proc" && r.parts.some((p) => p.id === "x1"))).toBe(false);
    });

    it("现场：主体是助理正文时，那条正文也不进历史行（历史 text 行 vs 现场主体）", () => {
        const t = ended("error", {}, [step("s1", [say("a1"), err("e1")])]);
        expect(composeTail(t, sceneTailOf(t))!.body!.id).toBe("a1");
        expect(turnRows(t, null).some((r) => r.key === "a1")).toBe(false);
    });
});

describe("tailOf：结尾槽的四种形态（自暴露 · 恒显）", () => {
    it("末件是助理正文 → 结论", () => {
        const tl = tailOf(turn(think("k1"), say("a9")), null)!;
        expect(tl.kind).toBe("conclusion");
        expect(tl.node.id).toBe("a9");
    });

    it("completed 但末件不是正文（通常是工具）→ 结束点，不冒充结论（R25 拍板）", () => {
        const tl = tailOf(ended("completed", {}, [say("a1"), tool("x1")]), null)!;
        expect(tl.kind).toBe("endleaf");
        expect(tl.node.id).toBe("x1");
    });

    it("异常结束 + 末件不是正文 → 现场（error / max-steps / aborted / interrupted 一视同仁）", () => {
        for (const ty of ["error", "max-steps", "aborted", "interrupted"]) {
            const tl = tailOf(ended(ty, { limit: 3 }, [say("a1"), tool("x1", false)]), null)!;
            expect(tl.kind, ty).toBe("scene");
            expect(tl.node.id, ty).toBe("x1");
        }
    });

    it("直播中 → 执行过程（半结尾；不看结束原因）", () => {
        const tl = tailOf(turn(think("k1"), tool("x1", false)), think("k1"))!;
        expect(tl.kind).toBe("live");
        expect(tl.node.id).toBe("k1");
    });

    it("末件是 error 块 → 现场该管，不出结束点", () => {
        expect(tailOf(n("turn", "t1", {}, [say("a1"), err("e1")]), null)).toBeNull();
    });

    it("异常结束但末件是正文 → 结论已覆盖，不再叠一个结束点", () => {
        expect(tailOf(ended("aborted", { source: "abort" }, [tool("x1"), say("a1")]), null)!.kind).toBe(
            "conclusion",
        );
    });
});

describe("轮尾状态行的状态图标（endMarkOf）", () => {
    // 判据来自 endReason（##288）；这里钉的是**字形与色档**，不是文案
    it("直播中 → ◌（灰），不看 endReason", () => {
        expect(endMarkOf({ type: "completed" } as never, true)).toMatchObject({ icon: "◌", tone: "live" });
    });

    it("completed → ✓ 绿；error → ✗ 红；被限制/被中断 → ⛔ 黄（不是红：没报错）", () => {
        expect(endMarkOf({ type: "completed" } as never, false)).toMatchObject({ icon: "✓", tone: "ok" });
        expect(endMarkOf({ type: "error", data: {} } as never, false)).toMatchObject({ icon: "✗", tone: "err" });
        expect(endMarkOf({ type: "max-tokens", data: {} } as never, false)).toMatchObject({ icon: "⛔", tone: "cut" });
        expect(endMarkOf({ type: "aborted", data: { source: "abort" } } as never, false)).toMatchObject({
            icon: "⛔",
            tone: "cut",
        });
        // aborted 的 tip 同样按 source 分句（与 turnEndNote 同源，不许各写各的）
        expect(endMarkOf({ type: "aborted", data: { source: "user" } } as never, false).tip).toBe("生成已取消");
        expect(endMarkOf({ type: "interrupted", data: {} } as never, false)).toMatchObject({ icon: "⛔", tone: "cut" });
    });

    it("旧日志没有 endReason → 不给图标（不编状态，连灰点都不给）", () => {
        expect(endMarkOf(null, false)).toMatchObject({ icon: "", tone: "none" });
    });

    it("max-steps 的 tip 带上限（用户要能分辨「限制」与「报错」）", () => {
        expect(endMarkOf({ type: "max-steps", data: { limit: 40 } } as never, false).tip).toContain("40");
    });
});

describe("结束点（endleaf）tag 的 tooltip：必须跟着 endReason 走", () => {
    // review ##253 RV-3：`tailOf` 在没有 endReason 的**旧日志**上同样会给 endleaf，
    // 而 `endMarkOf` 对同一批轮刻意"不编状态"（连图标都不给）。
    // 原来组件把 tip 写死成「正常结束，但模型未给文字结论」⇒ 同一件事两个口径。
    it("completed → 可以断言「正常结束」（这是 endReason 说的）", () => {
        const t = n("turn", "t1", { endReason: { type: "completed", data: {} } }, [step("s1", [tool("x1")])]);
        expect(endLeafTip(t)).toBe("正常结束，但模型未给文字结论");
    });

    it("completed 带 notice → 用 notice（更细的那句优先）", () => {
        const t = n("turn", "t1", { endReason: { type: "completed", data: {} }, notice: "提前收尾" }, [
            step("s1", [tool("x1")]),
        ]);
        expect(endLeafTip(t)).toBe("提前收尾");
    });

    it("max-tokens → 说截断，不说「正常结束」", () => {
        const t = n("turn", "t1", { endReason: { type: "max-tokens", data: {} } }, [step("s1", [tool("x1")])]);
        expect(endLeafTip(t)).toContain("上限");
    });

    // review ##253 小项4：notice 是 main 写下的"更细的那句"，**每个分支都该压过模板文案**
    // （原来只有 completed 分支读它）。
    it("max-tokens 带 notice → 用 notice（与 completed 分支同一优先级）", () => {
        const t = n(
            "turn",
            "t1",
            { endReason: { type: "max-tokens", data: {} }, notice: "长思考撞上限" },
            [step("s1", [think("k1")])],
        );
        expect(endLeafTip(t)).toBe("长思考撞上限");
    });

    // review ##253 小项4：endleaf 的末件**不一定是工具**（max-tokens 撞在长思考里时是思考，
    // 甚至 plan），而那一件东西就画在 tip 旁边 —— tooltip 不该再断言它是什么。
    it("不替末件断言类型：末件是思考时也不说「停在工具」", () => {
        const t = n("turn", "t1", { endReason: { type: "max-tokens", data: {} } }, [step("s1", [think("k1")])]);
        expect(endLeafTip(t)).not.toContain("工具");
        const t2 = n("turn", "t2", {}, [step("s1", [think("k1")])]);
        expect(endLeafTip(t2)).not.toContain("工具");
    });

    it("无 endReason（旧日志）→ 说「结束原因未知」，不替它编一个结束原因", () => {
        const t = n("turn", "t1", {}, [step("s1", [tool("x1")])]);
        expect(tailOf(t, null)!.kind).toBe("endleaf"); // 可达（尾槽确实会画它）
        expect(endLeafTip(t)).toContain("未知");
        expect(endLeafTip(t)).not.toContain("正常结束");
        // 与状态行同一批轮的"不编状态"口径一致：那边连图标都不给
        expect(endMarkOf(endReasonOf(t), false).icon).toBe("");
    });

    // review3 RV-7：`notice`（maxSteps/maxTokens 的收尾文案）比 `endReason` **早一个月**进仓
    // ⇒ 中间那批"上限收尾"轮**带 notice、无 endReason**（`danglingStopPatches` 只补开口轮，管不着）。
    // 原来 `!r` 分支抢在 notice 之前 ⇒ 状态行说"达到上限"、其上的 tooltip 却说"结束原因未知"。
    // 判据与 `turnEndNote` **同源**（`interrupted ? … : notice`）—— 结论一律由它反推，别再抄一遍模板。
    it("无 endReason 但有 notice → 跟状态行同源（不许说「结束原因未知」）", () => {
        const t = n("turn", "t1", { notice: "达到 maxSteps=40 步上限，本轮强制收尾" }, [step("s1", [tool("x1")])]);
        expect(turnEndNote(t)).toBe("达到 maxSteps=40 步上限，本轮强制收尾");
        expect(endLeafTip(t)).toBe(turnEndNote(t));
    });

    it("无 endReason 但 interrupted → 也跟状态行同源（说「未完成」而不是「未知」）", () => {
        const t = n("turn", "t1", { interrupted: true }, [step("s1", [tool("x1")])]);
        expect(endLeafTip(t)).toBe(turnEndNote(t));
        expect(endLeafTip(t)).toContain("未完成");
    });
});

// ─── 过程行状态：用户看得见的那一档（##329 review1 R1）────────────────
//
// 判据原来是组件里的私有函数（`statusMark` / `procOpen`），单测够不着 ⇒ 有人改 status 语义
// 或改坏组件接线，测试全绿而用户照旧看不到 ✗ —— 那正是 ##329 的原始形态（数据对了、界面没变）。
// 现在判据在纯函数里，下面这几条就是"数据 → 界面"那一段的钉子。
describe("过程行状态：✗ 与失败块恒开（##329）", () => {
    it('status==="error" → ✗（失败不许画成 ✓）', () => {
        expect(procStatusOf(tool("x1", true, "error"), false)).toMatchObject({ icon: "✗", tone: "error" });
        expect(procStatusOf(tool("x2", true, "done"), false)).toMatchObject({ icon: "✓", tone: "ok" });
    });

    it("失败块**默认展开**（error 块 / 失败的工具行），且默认值没被翻过来", () => {
        expect(procOpenOf(err("e1"), {}, false)).toBe(true);
        expect(procOpenOf(tool("x1", true, "error"), {}, false)).toBe(true);
        // 成功 / 在跑的工具行仍默认收起（原来的默认口径没变）
        expect(procOpenOf(tool("x2", true, "done"), {}, false)).toBe(false);
        // pin 仍是用户的显式覆盖
        expect(procOpenOf(tool("x2", true, "done"), { x2: true }, false)).toBe(true);
    });

    it("中断遗留 → ⊘（没结果 ≠ 失败）；有轮次在跑时是 ●（别把 CLI 在跑的一轮读成历史）", () => {
        expect(procStatusOf(tool("x1", false, "interrupted"), false)).toMatchObject({ icon: "⊘", tone: "warn" });
        // 旧日志：未收 stop、无 status，此刻没有轮次在跑 → 中断遗留
        expect(procStatusOf(tool("x2", false, ""), false).icon).toBe("⊘");
        // 同一块，此刻有轮次在跑 → 不能判成"中断的历史"（任务 194 现象一）
        expect(procStatusOf(tool("x2", false, ""), true)).toMatchObject({ icon: "●", tone: "wait" });
        // ⊘ 不是 ✗：两者不共用一个判据（中断的块不会被算成失败）
        expect(isFailedTool(tool("x2", false, "interrupted"))).toBe(false);
    });

    // ★ 纯函数绿 ≠ 用户看得见：**接线**才是那一段。有人把判据抄回组件（或干脆不调新函数），
    // 上面几条全绿而 ✗ 照旧不出现 —— 那正是 ##329 的原始形态（数据对了、界面没变）。
    // 同款先例：`prompt-registry.test.ts` 的 ★「两条链路都真的调它」。
    it("★ 源码护栏：组件真的走这两个纯函数，且没把判据抄回去", () => {
        const src = readFileSync(
            join(__dirname, "..", "..", "src", "renderer_solid", "components", "LocalChatPage.tsx"),
            "utf-8",
        );
        expect(src).toContain("procStatusOf("); // 状态灯接上了
        expect(src).toContain("procOpenOf("); // 默认开合接上了
        expect(src).not.toMatch(/attrs\.status\s*===\s*"error"/); // 失败判据没被内联回来
        expect(src).not.toMatch(/function\s+procOpen\b/); // 组件私有判据没复活
        expect(src).not.toMatch(/function\s+isInterruptedToolBlock/);
    });

    it("用户发言不给状态灯；过程 bar 的 ✗ 与状态灯共用同一判据", () => {
        expect(procStatusOf(user("u1"), false).icon).toBe("");
        expect(isFailedTool(tool("x1", true, "error"))).toBe(true);
        expect(isFailedTool(think("k1"))).toBe(false);
        expect(isInterruptedToolBlock(think("k1"), false)).toBe(false);
    });
});
