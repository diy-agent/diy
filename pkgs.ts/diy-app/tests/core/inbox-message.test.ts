// tests/core/inbox-message.test.ts
// ═══════════════════════════════════════════════════════════════
// ##436 块 4 + 两个顺带洞：**留言进信箱** / **僵尸投递** / **永不投递的队列**。
//
// 为什么这几条必须在服务层验（纯函数验不了）：
//   ① 「人署名 ⇒ N2 / 机器 ⇒ N1」用的判据是 **`core/drafts.isHumanAuthor`**（与 ##435 的
//      L2 准入同一份实现）—— 换了实现这里就该红；
//   ② 原文必须**不截断**地进 `data.raw`（用户抱怨的根因就是"没有内容可读"）；
//   ③ 启动扫尾是**幂等**的：重启十次也只在信箱里留一条（判据 = `data.dedupeKey`）；
//   ④ 扫尾**不许静默**：僵尸投递 / 终态任务的队列必须各留一条可读条目。
//
// 全部在临时 DIY_HOME 里跑（绝不碰生产 ~/.diy）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "diy-inbox-msg-"));
    process.env["DIY_HOME"] = home;
    vi.resetModules(); // hub 有模块级 ring / 扫尾有进程内 flag：每个用例一份干净实例
});

afterEach(() => {
    delete process.env["DIY_HOME"];
    rmSync(home, { recursive: true, force: true });
});

describe("##436 留言条目：分级（人 = N2 / 机器 = N1）+ 原文不丢", () => {
    it("人署名 ⇒ N2 + senderKind=human；原文整段进 data.raw（不截断）", async () => {
        const { messageEntryOf } = await import("../../src/main/services/inbox");
        const raw = "第一行\n" + "长正文".repeat(80) + "\n最后一行";
        const e = messageEntryOf({
            taskUri: "projects/4/tasks/436",
            text: raw,
            author: "human:chen56",
            roomId: "projects/4/tasks/436",
            fromName: "#436",
            sayId: "say-1",
            steerId: "st-1",
        });
        expect(e.level).toBe("N2");
        expect(e.kind).toBe("message");
        expect(e.data?.["senderKind"]).toBe("human");
        expect(e.data?.["raw"]).toBe(raw); // 原文一字不少
        expect(e.text.length).toBeLessThan(raw.length); // 列表那行是摘要
        expect(e.source).toContain("human:chen56");
        expect(e.data?.["sayId"]).toBe("say-1");
        expect(e.data?.["steerId"]).toBe("st-1");
    });

    it("**你自己发的**（author === selfId）⇒ N1 + senderKind=self，不给自己报信（##266 阻塞 2）", async () => {
        const { messageEntryOf } = await import("../../src/main/services/inbox");
        // 本人 → 别人（房间投给另一个成员）：不能升 N2，否则你在 UI 里说一句顶栏就催你一次
        const self = messageEntryOf({
            taskUri: "projects/4/tasks/436",
            text: "帮我看看这个",
            author: "human:chen56",
            selfId: "human:chen56",
            roomId: "projects/4/tasks/436",
        });
        expect(self.level).toBe("N1");
        expect(self.data?.["senderKind"]).toBe("self");
        expect(self.text).toContain("你自己");
        expect(self.detail).toContain("你自己发的");
    });

    it("**别人 → 本人** ⇒ N2（人署名 + 不是你自己：真的有人在等）；agent 署名照旧 N1", async () => {
        const { messageEntryOf } = await import("../../src/main/services/inbox");
        const other = messageEntryOf({
            taskUri: "projects/4/tasks/436",
            text: "这条要你回",
            author: "human:someone-else",
            selfId: "human:chen56",
        });
        expect(other.level).toBe("N2");
        expect(other.data?.["senderKind"]).toBe("human");

        const agent = messageEntryOf({
            taskUri: "projects/4/tasks/436",
            text: "派个活",
            author: "agent:dev-1",
            selfId: "human:chen56",
        });
        expect(agent.level).toBe("N1");
        expect(agent.data?.["senderKind"]).toBe("machine");
        // ⚠️ 这只影响**信箱角标**（只数 N2），不动 ##435 的 L2 叫醒判据（那边自有 `session-alerts.pick()`）
    });

    it("job / agent / 无署名 ⇒ N1 + senderKind=machine（它们不需要人动手，##435）", async () => {
        const { messageEntryOf } = await import("../../src/main/services/inbox");
        for (const author of ["job", "agent:dev-1", undefined]) {
            const e = messageEntryOf({ taskUri: "projects/4/tasks/436", text: "一句", ...(author ? { author } : {}) });
            expect(e.level, String(author)).toBe("N1");
            expect(e.data?.["senderKind"], String(author)).toBe("machine");
        }
    });
});

describe("##436 顺带洞：结案任务里没人取的留言（kind=lost）", () => {
    const draftsOf = (uri: string, steers: string): string =>
        `kind: diy.ui-drafts\nversion: 3\ntask: ${uri}\nfields: {}\nsteers:\n${steers}`;

    function makeTask(uri: string, state: string, steers: string): void {
        const dir = join(home, uri);
        mkdirSync(join(dir, ".diy"), { recursive: true });
        writeFileSync(join(dir, "AGENTS.md"), `---\ntitle: 任务\nstate: ${state}\n---\n正文正文正文正文正文\n`, "utf-8");
        writeFileSync(join(dir, ".diy", "drafts.yaml"), draftsOf(uri, steers), "utf-8");
    }

    it("done 任务 + steers 非空 ⇒ 每条留言落一条 lost（带 steerId / 原文 / created / state）；再跑不重复", async () => {
        const { sweepStuckSteers } = await import("../../src/main/services/inbox-sweep");
        const { inboxHub } = await import("../../src/main/services/inbox");
        const uri = "projects/4/tasks/438";
        makeTask(
            uri,
            "done",
            '  - id: st-1\n    mode: next-turn\n    text: 这句没人取\n    created: "2026-10-25T12:00:00.000Z"\n    author: "human:chen56"\n',
        );

        expect(await sweepStuckSteers()).toBe(1);
        const rows = await inboxHub.list();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: "lost", taskUri: uri, level: "N1" });
        expect(rows[0]!.data?.["raw"]).toBe("这句没人取");
        expect(rows[0]!.data?.["steerId"]).toBe("st-1");
        expect(rows[0]!.data?.["created"]).toBe("2026-10-25T12:00:00.000Z");
        expect(rows[0]!.data?.["state"]).toBe("done");
        // 文案口径（##266）：说清"不会被取出"+"可逆"，不是"已丢弃"
        expect(rows[0]!.text).toContain("不会被取出");
        expect(rows[0]!.detail).toContain("可逆");
        expect(rows[0]!.detail).toContain("task edit");

        // 同一件事重启再扫：不再落第二条（幂等键 = uri#steerId）
        expect(await sweepStuckSteers()).toBe(0);
        expect(await inboxHub.list()).toHaveLength(1);
    });

    it("cancelled / closed / shelved 都算「不再接受新轮次」", async () => {
        const { sweepStuckSteers } = await import("../../src/main/services/inbox-sweep");
        const { inboxHub } = await import("../../src/main/services/inbox");
        let i = 0;
        for (const state of ["cancelled", "closed", "shelved"]) {
            const uri = `projects/4/tasks/${450 + i++}`;
            makeTask(uri, state, `  - id: st-${i}\n    mode: next-turn\n    text: 躺着\n    created: "2026-10-25T12:00:00.000Z"\n`);
        }
        expect(await sweepStuckSteers()).toBe(3);
        expect((await inboxHub.list()).map((r) => r.taskUri).sort()).toEqual([
            "projects/4/tasks/450",
            "projects/4/tasks/451",
            "projects/4/tasks/452",
        ]);
    });

    it("非结案任务**不动**（用户随时可能点跑，猜错就是假警报）", async () => {
        const { sweepStuckSteers } = await import("../../src/main/services/inbox-sweep");
        const uri = "projects/4/tasks/439";
        makeTask(uri, "active", '  - id: st-2\n    mode: next-turn\n    text: 待投\n    created: "2026-10-25T12:00:00.000Z"\n');
        expect(await sweepStuckSteers()).toBe(0);
    });

    it("结案但 steers 为空 ⇒ 不落条目（没东西可取 ≠ 有东西取不出）", async () => {
        const { sweepStuckSteers } = await import("../../src/main/services/inbox-sweep");
        makeTask("projects/4/tasks/440", "done", "");
        expect(await sweepStuckSteers()).toBe(0);
    });
});
