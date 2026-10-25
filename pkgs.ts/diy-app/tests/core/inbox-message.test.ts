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

    it("job / agent / 无署名 ⇒ N1 + senderKind=machine（它们不需要人动手，##435）", async () => {
        const { messageEntryOf } = await import("../../src/main/services/inbox");
        for (const author of ["job", "agent:dev-1", undefined]) {
            const e = messageEntryOf({ taskUri: "projects/4/tasks/436", text: "一句", ...(author ? { author } : {}) });
            expect(e.level, String(author)).toBe("N1");
            expect(e.data?.["senderKind"], String(author)).toBe("machine");
        }
    });
});

describe("##436 顺带洞 ①：僵尸投递（deliveries 停在 queued/running）", () => {
    it("扫出来落一条 delivery-lost，带原话；再跑一次不再落（幂等）", async () => {
        const { ensureRoom, appendEvent, appendDelivery } = await import("../../src/main/core/room");
        const { sweepLostDeliveries } = await import("../../src/main/services/inbox-sweep");
        const { inboxHub } = await import("../../src/main/services/inbox");

        ensureRoom("projects/4/tasks/436", {
            members: [
                {
                    id: "agent:dev-1",
                    name: "dev-1",
                    kind: "agent",
                    backend: { type: "task", data: { taskUri: "projects/4/tasks/435" } },
                },
            ],
        });
        await appendEvent("projects/4/tasks/436", {
            id: "say-9",
            ts: new Date().toISOString(),
            kind: "say",
            channel: "default",
            author: "human:chen56",
            to: [],
            delivered: false,
            text: "这句话没送到",
        });
        await appendDelivery("projects/4/tasks/436", {
            eventId: "say-9",
            memberId: "agent:dev-1",
            status: "queued",
            taskUri: "projects/4/tasks/435",
            ts: new Date().toISOString(),
        });

        expect(await sweepLostDeliveries()).toBe(1);
        const rows = await inboxHub.list();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: "delivery-lost", taskUri: "projects/4/tasks/435" });
        expect(rows[0]!.data?.["raw"]).toBe("这句话没送到");
        expect(rows[0]!.data?.["sayId"]).toBe("say-9");

        // 同一件事重启再扫：不再落第二条
        expect(await sweepLostDeliveries()).toBe(0);
        expect(await inboxHub.list()).toHaveLength(1);
    });

    it("已投递（ok）不算僵尸；没有收件会话可跳的也不算（不造假按钮）", async () => {
        const { ensureRoom, appendDelivery } = await import("../../src/main/core/room");
        const { sweepLostDeliveries } = await import("../../src/main/services/inbox-sweep");
        ensureRoom("projects/4/tasks/437", {
            members: [{ id: "agent:x", name: "x", kind: "agent", backend: null }],
        });
        const now = new Date().toISOString();
        await appendDelivery("projects/4/tasks/437", { eventId: "say-ok", memberId: "agent:x", status: "ok", ts: now });
        await appendDelivery("projects/4/tasks/437", { eventId: "say-noop", memberId: "agent:x", status: "queued", ts: now });
        expect(await sweepLostDeliveries()).toBe(0);
    });
});

describe("##436 顺带洞 ②：终态任务里永不投递的队列", () => {
    it("done 任务 + drafts 里有 steers ⇒ 落一条；再跑不重复", async () => {
        const { sweepStuckQueues } = await import("../../src/main/services/inbox-sweep");
        const { inboxHub } = await import("../../src/main/services/inbox");
        const uri = "projects/4/tasks/438";
        const dir = join(home, uri);
        mkdirSync(join(dir, ".diy"), { recursive: true });
        writeFileSync(
            join(dir, "AGENTS.md"),
            "---\ntitle: 已结案\nstate: done\n---\n正文正文正文正文正文\n",
            "utf-8",
        );
        writeFileSync(
            join(dir, ".diy", "drafts.yaml"),
            `kind: diy.ui-drafts\nversion: 3\ntask: ${uri}\nfields: {}\nsteers:\n  - id: st-1\n    mode: next-turn\n    text: 这句没人取\n    created: "2026-10-25T12:00:00.000Z"\n    author: "human:chen56"\n`,
            "utf-8",
        );

        expect(await sweepStuckQueues()).toBe(1);
        const rows = await inboxHub.list();
        expect(rows[0]).toMatchObject({ kind: "delivery-lost", taskUri: uri });
        expect(rows[0]!.data?.["raw"]).toContain("这句没人取");

        expect(await sweepStuckQueues()).toBe(0);
    });

    it("非终态任务**不动**（用户随时可能点跑，猜错就是假警报）", async () => {
        const { sweepStuckQueues } = await import("../../src/main/services/inbox-sweep");
        const uri = "projects/4/tasks/439";
        const dir = join(home, uri);
        mkdirSync(join(dir, ".diy"), { recursive: true });
        writeFileSync(join(dir, "AGENTS.md"), "---\ntitle: 在跑\nstate: active\n---\n正文正文正文正文正文\n", "utf-8");
        writeFileSync(
            join(dir, ".diy", "drafts.yaml"),
            `kind: diy.ui-drafts\nversion: 3\ntask: ${uri}\nfields: {}\nsteers:\n  - id: st-2\n    mode: next-turn\n    text: 待投\n    created: "2026-10-25T12:00:00.000Z"\n`,
            "utf-8",
        );
        expect(await sweepStuckQueues()).toBe(0);
    });
});
