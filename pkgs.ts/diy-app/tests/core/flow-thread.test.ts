// tests/core/flow-thread.test.ts
// 🎯 打回**讨论线程**的锚点与闸门（##342）—— 不依赖 Electron 的那几件。
//
// 判据为什么值得单独钉住：
//   · **锚点**是「泳道视图」与「讨论视图」之间唯一的键（同一份事件流，两种投影）：`{from,to,seq}` 里
//     `seq` 必须是**落点那次驻留**的序号 —— 少了它，同一节点二次打回就串台（##320 P1-1 的同一教训）；
//   · **写闸门**（锚点必须真）是本任务「不造数据」硬约束的落点：一旦放行假锚点，界面上就会出现
//     「折线上根本不存在的争议」；
//   · **旁注容错**（坏行只报数 / 删文件不影响推进）是 `rule.core-log` 的落点。
// E2E 在 `tests/cli.intent.flow.test.ts`（讨论线程那一段）与 `cli.intent.flow-run.test.ts`（自动打回）。
//
// 与 UI 侧纯派生（`threadIdOfVisit`）的口径必须**逐字一致** —— 最后一例专门钉这条跨层契约。

import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { advanceFlow, appendBounceOpinion, bounceFlow, showFlow, startFlow } from "../../src/main/core/flow";
import { listThreads, postThread } from "../../src/main/core/flow-thread";
import { anchorKey, appendPost, parseAnchorKey, readPosts, type FlowPost } from "../../src/main/core/flow-store";
import { threadIdOfVisit } from "../../src/renderer_solid/lib/flow-model";

/** 建一条任务（unit 层只要目录 + frontmatter 够 `taskExists` 用，与 flow-runner.test.ts 同一手法） */
function freshTask(name: string): string {
    const uri = `projects/9/tasks/${name}`;
    mkdirSync(join(process.env["DIY_HOME"]!, uri), { recursive: true });
    writeFileSync(join(process.env["DIY_HOME"]!, uri, "AGENTS.md"), `---\ntitle: ${name}\nstate: pending\n---\n`, "utf-8");
    return uri;
}

/** 走到 review（clarify → design → implement → review） */
function toReview(uri: string): void {
    startFlow(uri, "dev");
    for (const node of ["clarify", "design", "implement", "review"]) advanceFlow(uri, node);
}

const THREADS = (uri: string): string => join(process.env["DIY_HOME"]!, uri, "flow", "threads.jsonl");

describe("锚点的文本形（##342）：`from->to#seq`", () => {
    it("round-trip；写法不完整 / seq 不是整数一律拒（输入闸门，不静默吞）", () => {
        const a = { from: "review", to: "implement", seq: 2 };
        expect(anchorKey(a)).toBe("review->implement#2");
        expect(parseAnchorKey("review->implement#2")).toEqual(a);
        for (const bad of ["", "review->implement", "review->implement#x", "->implement#1", "review->#1", "nonsense"]) {
            expect(() => parseAnchorKey(bad), bad).toThrow(/线程写法应为/);
        }
    });
});

describe("讨论流是旁注（##342）：读容错、可丢", () => {
    it("坏行 / 形状不符的行**跳过并计数**（好行照读）—— 旁注坏了不该影响运行", () => {
        const uri = freshTask("read-tolerant");
        const good: FlowPost = {
            id: "p1",
            at: "2026-01-01T00:00:00.000Z",
            author: "cli",
            type: "note",
            anchor: { from: "review", to: "implement", seq: 2 },
            text: "好行",
        };
        mkdirSync(join(process.env["DIY_HOME"]!, uri, "flow"), { recursive: true });
        writeFileSync(
            THREADS(uri),
            `${JSON.stringify(good)}\n{"id":"半截\n${JSON.stringify({ ...good, id: "p2", type: "nope" })}\n${JSON.stringify({ id: "p3" })}\n`,
            "utf-8",
        );
        const r = readPosts(uri);
        expect(r.posts.map((p) => p.id)).toEqual(["p1"]);
        expect(r.skipped).toBe(3);
        // 文件不在 = 还没人发过言（正常态，不是错）
        rmSync(THREADS(uri));
        expect(readPosts(uri)).toEqual({ posts: [], skipped: 0 });
    });
});

describe("线程结构从**折线**推（##342）：锚点不造、不串台", () => {
    it("一次打回 ⇒ 一条线程；同节点二次打回 ⇒ 两条（`seq` 各异，`fromSeq` 也各异）", () => {
        const uri = freshTask("derive");
        toReview(uri);
        bounceFlow(uri, "implement", [], "第一轮");
        advanceFlow(uri, "review"); // 出口 (a) 撤销打回（合法 next 边）
        bounceFlow(uri, "implement", [], "第二轮");

        const t = listThreads(uri);
        expect(t.threads.map((x) => x.id)).toEqual(["review->implement#2", "review->implement#3"]);
        expect(t.threads.map((x) => [x.anchor.from, x.anchor.to, x.anchor.seq])).toEqual([
            ["review", "implement", 2],
            ["review", "implement", 3],
        ]);
        expect(t.threads.map((x) => x.fromSeq)).toEqual([1, 2]);
        expect(t.threads.every((x) => x.real && x.status === "open" && x.posts.length === 0)).toBe(true);
        // 名字来自定义（UI 上直接可读）
        expect([t.threads[0]!.fromName, t.threads[0]!.toName]).toEqual(["Review", "开发"]);
        // 单条过滤
        expect(listThreads(uri, "review->implement#2").threads.map((x) => x.id)).toEqual(["review->implement#2"]);
        expect(() => listThreads(uri, "review->implement#9")).toThrow(/没有这条打回线程/);
    });

    it("讨论流里有、折线上查无的发言**不丢**：标 `real: false` 亮出来（坏数据不藏）", () => {
        const uri = freshTask("orphan");
        toReview(uri);
        appendPost(uri, {
            id: "ghost",
            at: "2026-01-01T00:00:00.000Z",
            author: "cli",
            type: "note",
            anchor: { from: "review", to: "implement", seq: 7 },
            text: "凭空造的发言",
        });
        const t = listThreads(uri);
        expect(t.threads).toHaveLength(1);
        expect(t.threads[0]).toMatchObject({ id: "review->implement#7", real: false, at: -1, fromSeq: null });
        expect(t.threads[0]!.posts.map((p) => p.id)).toEqual(["ghost"]);
    });
});

describe("写闸门（##342 不造数据）", () => {
    it("锚点必须是折线上**真发生过**的那次打回：不存在 / 不是打回 / 源不符 ⇒ 一律拒（且一个字节都不写）", () => {
        const uri = freshTask("gate");
        toReview(uri);
        expect(() => postThread(uri, "review->implement#2", "还没打回过", "note", "cli")).toThrow(/折线上没有/);
        expect(() => postThread(uri, "implement->review#1", "review#1 是推进进来的", "note", "cli")).toThrow(/推进/);
        expect(() => postThread(uri, "design->implement#1", "源对不上", "note", "cli")).toThrow(/折线上没有|不是/);
        // 一次都没写：文件都不存在
        expect(() => readFileSync(THREADS(uri), "utf-8")).toThrow();

        bounceFlow(uri, "implement", [], "打回");
        expect(() => postThread(uri, "review->implement#2", "   ", "note", "cli")).toThrow(/正文为空/);
        const after = postThread(uri, "review->implement#2", "开发：已改完", "note", "开发 agent");
        expect(after.threads[0]!.posts.map((p) => [p.author, p.text])).toEqual([["开发 agent", "开发：已改完"]]);
    });

    it("两出口的状态发言：resolved / escalate 由**最后一条状态发言**决定；位置一动不动", () => {
        const uri = freshTask("exit");
        toReview(uri);
        bounceFlow(uri, "implement", [], "打回");
        const key = "review->implement#2";
        expect(listThreads(uri).threads[0]!.status).toBe("open");
        expect(postThread(uri, key, "已解决", "resolved", "开发 agent").threads[0]!.status).toBe("resolved");
        // 普通发言不改变状态（只有状态发言算）
        const t = postThread(uri, key, "再补一句", "note", "cli");
        expect(t.threads[0]!.status).toBe("resolved");
        expect(postThread(uri, key, "交人裁决", "escalate", "human").threads[0]!.status).toBe("escalated");
        // 领域态没被动过：位置仍是打回落点，折线长度不变
        const v = showFlow(uri);
        expect(v.position).toBe("implement");
        expect(v.trajectory).toHaveLength(5);
        expect(readFileSync(join(process.env["DIY_HOME"]!, uri, "flow", "path.jsonl"), "utf-8")).not.toContain("已解决");
    });
});

describe("意见一等落盘（##342）：`appendBounceOpinion` 挂的锚点 = 这次打回的落点", () => {
    it("正文与作者落进讨论流；`at` 用**那次驻留自己的时间戳**（不是「现在」）", () => {
        const uri = freshTask("opinion");
        toReview(uri);
        const view = bounceFlow(uri, "implement", [], "第一轮打回");
        const post = appendBounceOpinion(uri, view, "P0：边界条件没覆盖", "评审 agent");
        expect(post.anchor).toEqual({ from: "review", to: "implement", seq: 2 });
        expect(post.at).toBe(view.trajectory[view.trajectory.length - 1]!.at);
        const t = listThreads(uri);
        expect(t.threads[0]!.posts.map((p) => [p.type, p.author, p.text])).toEqual([
            ["note", "评审 agent", "P0：边界条件没覆盖"],
        ]);
        // 只接受**打回**的回执（拿推进的回执来挂意见是调用方的错，当场拒）
        const adv = advanceFlow(uri, "review");
        expect(() => appendBounceOpinion(uri, adv, "挂错地方", "cli")).toThrow(/只接\*\*打回\*\*的回执/);
    });
});

describe("跨层同形（##342）：UI 的 `threadIdOfVisit` 与 main 的 `anchorKey` 必须逐字一致", () => {
    it("折线第 i 次驻留若是打回 ⇒ 给出的 id 与 main 侧线程 id 相同", () => {
        const uri = freshTask("same-key");
        toReview(uri);
        bounceFlow(uri, "implement");
        const v = showFlow(uri);
        // 折线末条 = 打回落点（implement#2）
        const fromUi = threadIdOfVisit(v.trajectory, v.trajectory.length - 1);
        expect(fromUi).toBe("review->implement#2");
        expect(fromUi).toBe(listThreads(uri).threads[0]!.id);
        expect(fromUi).toBe(anchorKey({ from: "review", to: "implement", seq: 2 }));
        // 非打回驻留（推进进来的）⇒ 没有线程可展开
        expect(threadIdOfVisit(v.trajectory, 0)).toBeNull();
        expect(threadIdOfVisit(v.trajectory, 99)).toBeNull();
    });
});
