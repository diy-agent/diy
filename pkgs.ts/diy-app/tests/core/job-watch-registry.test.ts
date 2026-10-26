import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobWatchRegistry } from "../../src/main/services/job-watch-registry";
import type { JobWatchDef, ProbePart } from "../../src/shared/job-watch";

// ##408 v2：JobWatch 执行端。**不真等一拍** —— now 注入；探针注入（不碰真文件系统语义）。
// 真磁盘只用 tmpdir（落盘/坏文件/穿越这些必须过真 fs 才作数）。

let root: string;
let clock: number;
let probeValue: string;
let probeFails: boolean;
let delivered: { id: string; diff: string }[];

function makeRegistry(over: Partial<ConstructorParameters<typeof JobWatchRegistry>[0]> = {}): JobWatchRegistry {
    return new JobWatchRegistry({
        rootDir: join(root, "watch"),
        home: root,
        now: () => clock,
        probe: async (spec): Promise<ProbePart[]> => {
            if (probeFails) throw new Error("probe down");
            return [{ key: spec, value: probeValue }];
        },
        deliver: (def, ev) => void delivered.push({ id: def.id, diff: ev.diff }),
        ...over,
    });
}

function def(over: Partial<JobWatchDef> = {}): JobWatchDef {
    return {
        id: "daily-pr",
        title: "看 PR 有没有人回",
        every: 30,
        probes: ["glob:gen/**"],
        quietAfter: 4,
        sinks: ["task:projects/4/tasks/408"],
        subject: { kind: "none" },
        createdAt: "2026-10-26T00:00:00.000Z",
        enabled: true,
        ...over,
    };
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "diy-watch-"));
    clock = 1_000_000;
    probeValue = "a";
    probeFails = false;
    delivered = [];
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("落盘", () => {
    it("定义写进去能原样读回来（含 id 排序）", async () => {
        const reg = makeRegistry();
        await reg.saveDef(def({ id: "b-watch" }));
        await reg.saveDef(def({ id: "a-watch" }));
        expect((await reg.loadDefs()).map((d) => d.id)).toEqual(["a-watch", "b-watch"]);
        expect(readFileSync(join(root, "watch", "defs", "a-watch.json"), "utf8")).toContain("看 PR 有没有人回");
    });

    it("坏的 JSON / 手改坏的定义跳过不抛，别的定义照读", async () => {
        const reg = makeRegistry();
        await reg.saveDef(def({ id: "good" }));
        writeFileSync(join(root, "watch", "defs", "broken.json"), "{ not json");
        writeFileSync(join(root, "watch", "defs", "bad.json"), JSON.stringify({ id: "bad" }));
        expect((await reg.loadDefs()).map((d) => d.id)).toEqual(["good"]);
        expect(await reg.getDef("broken")).toBeNull();
    });

    it("id 含 ../ 被拒（落盘文件名就是 id，这是唯一闸门）", async () => {
        const reg = makeRegistry();
        await expect(reg.saveDef(def({ id: "../../etc/passwd" }))).rejects.toThrow(/非法/);
        await expect(reg.saveDef(def({ id: "a/b" }))).rejects.toThrow(/非法/);
    });

    it("没探过的 watch 读出来是空状态（等于「还没建基线」）", async () => {
        const reg = makeRegistry();
        expect(await reg.getState("nope")).toMatchObject({ fingerprint: null, lastProbeAt: null, probes: 0 });
    });

    it("坏状态文件 ⇒ 空状态，不让下一拍崩", async () => {
        const reg = makeRegistry();
        mkdirSync(join(root, "watch", "state"), { recursive: true });
        writeFileSync(join(root, "watch", "state", "x.json"), '{"probes": "nope"}');
        expect(await reg.getState("x")).toMatchObject({ probes: 0, errorStreak: 0 });
    });

    it("removeDef 连状态一起清，且幂等", async () => {
        const reg = makeRegistry();
        await reg.saveDef(def());
        await reg.saveState("daily-pr", { ...(await reg.getState("daily-pr")), probes: 3 });
        expect(await reg.removeDef("daily-pr")).toBe(true);
        expect(await reg.removeDef("daily-pr")).toBe(false);
        expect(await reg.loadDefs()).toEqual([]);
        expect((await reg.getState("daily-pr")).probes).toBe(0);
    });
});

describe("一拍：挑该探的", () => {
    it("第一次只建基线（不投递），第二次内容变了才投且 diff 只有一行", async () => {
        const reg = makeRegistry();
        await reg.saveDef(def());

        const first = await reg.tickAll();
        expect(first).toMatchObject({ watches: 1, due: 1, probed: 1, changed: 0 });
        expect(delivered).toEqual([]);

        probeValue = "b";
        clock += 30 * 60_000; // every=30：不到点不探
        const second = await reg.tickAll();
        expect(second).toMatchObject({ due: 1, probed: 1, changed: 1 });
        expect(delivered).toEqual([{ id: "daily-pr", diff: "~ glob:gen/**: a → b" }]);
    });

    it("内容没变 ⇒ 不投递，只把无关变化次数 +1（降频依据）", async () => {
        const reg = makeRegistry();
        await reg.saveDef(def());
        await reg.tickAll();
        clock += 30 * 60_000;
        await reg.tickAll();
        expect(delivered).toEqual([]);
        expect((await reg.getState("daily-pr")).quietStreak).toBe(1);
    });

    it("没到点 ⇒ 这一拍跳过它（不探、不写盘）", async () => {
        const reg = makeRegistry();
        await reg.saveDef(def());
        await reg.tickAll();
        const probesBefore = (await reg.getState("daily-pr")).probes;
        clock += 60_000; // 只过了 1 分钟，every=30
        const r = await reg.tickAll();
        expect(r).toMatchObject({ due: 0, probed: 0 });
        expect((await reg.getState("daily-pr")).probes).toBe(probesBefore);
    });

    it("探针失败 ⇒ 记 errorStreak，不抛；连坏 3 次进 broken 名单", async () => {
        const reg = makeRegistry();
        await reg.saveDef(def({ every: 1 }));
        probeFails = true;
        const r1 = await reg.tickAll();
        expect(r1).toMatchObject({ due: 1, probed: 0, failed: 1 });
        expect((await reg.getState("daily-pr")).errorStreak).toBe(1);

        clock += 60_000;
        await reg.tickAll();
        clock += 60_000;
        const r3 = await reg.tickAll();
        expect(r3.broken).toEqual(["daily-pr"]);
    });

    it("一个 watch 坏了不影响其他 watch 同一拍照跑", async () => {
        const seed = makeRegistry();
        await seed.saveDef(def({ id: "a-bad", every: 1, probes: ["boom:x"] }));
        await seed.saveDef(def({ id: "b-good", every: 1 }));
        let calls = 0;
        // 用 spec 前缀区分：`boom:` 抛错，其余正常
        const reg = new JobWatchRegistry({
            rootDir: join(root, "watch"),
            home: root,
            now: () => clock,
            probe: async (spec) => {
                calls += 1;
                if (spec.startsWith("boom:")) throw new Error("nope");
                return [{ key: spec, value: "v" }];
            },
            deliver: () => void 0,
        });
        const r = await reg.tickAll();
        expect(calls).toBe(2);
        expect(r).toMatchObject({ due: 2, probed: 1, failed: 1 });
        expect((await reg.getState("a-bad")).errorStreak).toBe(1);
        expect((await reg.getState("b-good")).probes).toBe(1);
    });
});

describe("生命周期：对象没了就 ended", () => {
    it("subject 报 gone ⇒ 标 ended，此后一拍都不探（但 state 留着可查）", async () => {
        const reg = makeRegistry({ subjectState: () => "gone" });
        await reg.saveDef(def({ every: 1, subject: { kind: "run", runId: "r1" } }));
        const r = await reg.tickAll();
        expect(r.ended).toEqual(["daily-pr"]);
        expect(r.due).toBe(0);
        const st = await reg.getState("daily-pr");
        expect(st.ended).toMatchObject({ at: clock, reason: expect.stringContaining("run:r1") });

        clock += 60_000;
        const r2 = await reg.tickAll();
        expect(r2).toMatchObject({ due: 0, ended: [] });
    });

    it("subject 报 unknown 不动（重启后 run 表是空的 ≠ 结束了）", async () => {
        const reg = makeRegistry({ subjectState: () => "unknown" });
        await reg.saveDef(def({ every: 1, subject: { kind: "run", runId: "r1" } }));
        const r = await reg.tickAll();
        expect(r.ended).toEqual([]);
        expect((await reg.getState("daily-pr")).ended).toBeNull();
    });

    it("persistent 的对象压根不问（command / none）", async () => {
        let asked = 0;
        const reg = makeRegistry({
            subjectState: () => {
                asked += 1;
                return "gone";
            },
        });
        await reg.saveDef(def({ every: 1, subject: { kind: "none" } }));
        await reg.tickAll();
        expect(asked).toBe(0);
        expect((await reg.getState("daily-pr")).ended).toBeNull();
    });
});

describe("broken 只投一次", () => {
    it("连续失败跨过阈值那一拍投一条 broken，之后继续失败不再投", async () => {
        const reg = makeRegistry({ deliver: (d, ev) => void delivered.push({ id: d.id, diff: `${ev.kind}:${ev.diff}` }) });
        await reg.saveDef(def({ every: 1 }));
        probeFails = true;
        clock += 60_000;
        for (let i = 0; i < 5; i++) {
            await reg.tickAll();
            clock += 60_000;
        }
        const broken = delivered.filter((d) => d.diff.startsWith("broken:"));
        expect(broken).toHaveLength(1);
        expect(broken[0].diff).toBe("broken:probe down");
    });
});
