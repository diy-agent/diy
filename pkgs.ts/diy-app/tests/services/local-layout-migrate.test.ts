// tests/services/local-layout-migrate.test.ts
// 🎯 落位迁移（##379）的**数据安全**契约：幂等可续、绝不覆盖、孤儿留原地、生产根只准 dry-run。
//
// 为什么单测必须真造盘：这个命令动的正是「删源文件」的活 —— 桩掉 fs 就等于没测。

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { keyOf, legacySessionFile, localDir, resolveSessionFile, sessionDir, sessionFile } from "../../src/main/core/local-paths";
import { migrateLocalLayout } from "../../src/main/services/local-layout-migrate";

let URI = "";
beforeAll(() => {
    URI = createTask({ title: "迁移测试", project: createProject(join(diyHome(), "migrate-work")) });
});

const writeLegacy = (uri: string, kind: "ops" | "llm" | "compact", text: string): string => {
    const f = legacySessionFile(uri, kind);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text, "utf-8");
    return f;
};

describe("dry-run：只算不动", () => {
    it("源文件原地不动，清单给出「源 → 目标」", () => {
        const legacy = writeLegacy(URI, "ops", `{"op":"start"}\n`);
        const r = migrateLocalLayout({ dryRun: true, toolout: false });
        expect(r.dryRun).toBe(true);
        expect(existsSync(legacy)).toBe(true); // 一个字节都没动
        expect(existsSync(sessionFile(URI, "ops"))).toBe(false);
        const e = r.entries.find((x) => x.from.endsWith(`local/${keyOf(URI)}.ops.jsonl`));
        expect(e?.action).toBe("move");
        expect(e?.to).toBe(`local/${URI}/${keyOf(URI)}/ops.jsonl`);
        expect(r.moved).toBeGreaterThan(0);
    });
});

describe("实迁：搬 + 幂等续跑", () => {
    it("copy → 校验 → 删源；内容逐字节一致；重跑不再搬（skip）", () => {
        const uri = createTask({ title: "迁移-实迁", project: createProject(join(diyHome(), "migrate-real")) });
        const text = `{"op":"start","id":"t1"}\n{"op":"append"}\n`;
        const legacy = writeLegacy(uri, "ops", text);

        const first = migrateLocalLayout({ dryRun: false, toolout: false });
        expect(first.moved).toBeGreaterThan(0);
        expect(existsSync(legacy)).toBe(false);
        expect(readFileSync(sessionFile(uri, "ops"), "utf-8")).toBe(text);

        // 幂等：第二次跑不再有 move（源已不在；哪怕手工把源再放回来，目标等大也只 skip）
        writeFileSync(legacy, text, "utf-8");
        const second = migrateLocalLayout({ dryRun: false, toolout: false });
        expect(existsSync(legacy)).toBe(false); // 等大残留源被收尾清掉
        expect(second.conflicts).toBe(0);
        expect(readFileSync(sessionFile(uri, "ops"), "utf-8")).toBe(text);
    });

    it("目标已存在且**不等大** → conflict，两边都留着（数据安全优先于搬干净）", () => {
        const uri = createTask({ title: "迁移-冲突", project: createProject(join(diyHome(), "migrate-conflict")) });
        const legacy = writeLegacy(uri, "llm", "legacy-content\n");
        const next = sessionFile(uri, "llm");
        mkdirSync(dirname(next), { recursive: true });
        writeFileSync(next, "other-longer-content\n", "utf-8");

        const r = migrateLocalLayout({ dryRun: false, toolout: false });
        expect(r.conflicts).toBeGreaterThan(0);
        expect(existsSync(legacy)).toBe(true);
        expect(readFileSync(next, "utf-8")).toBe("other-longer-content\n");
    });

    it("孤儿（key 反查不到任务）→ unknown 留原地，不删不猜", () => {
        const root = localDir();
        const orphan = join(root, `projects_9_tasks_999-abcdef012345.ops.jsonl`);
        writeFileSync(orphan, `{"op":"start"}\n`, "utf-8");
        const r = migrateLocalLayout({ dryRun: false, toolout: false });
        expect(r.unknown).toBeGreaterThan(0);
        expect(existsSync(orphan)).toBe(true);
        rmSync(orphan, { force: true });
    });
});

describe("中途失败：截断副本不可见（##266 review1 R1）", () => {
    // 旧实现 `copyFileSync(from, to)` 直接落目标：copy 中途被杀会留下**截断的 to**，
    // 而读侧双认只判存在 ⇒ 把截断那份当权威、后续 append 接在截断处（历史静默腰斩）。
    // 现实现先写 `to.tmp` 再同目录 rename：`to` 只可能以完整形态出现，`.tmp` 永不被读侧认领。
    it("上次中断留下的 `.tmp` 残留 → 重跑得到完整目标，`.tmp` 消失", () => {
        const uri = createTask({ title: "迁移-中断", project: createProject(join(diyHome(), "migrate-crash")) });
        const text = Array.from({ length: 50 }, (_, i) => `{"op":"append","i":${i}}`).join("\n") + "\n";
        const legacy = writeLegacy(uri, "ops", text);
        const to = sessionFile(uri, "ops");
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(`${to}.tmp`, text.slice(0, 40), "utf-8"); // 模拟 copy 中途断电的残片

        const r = migrateLocalLayout({ dryRun: false, toolout: false });
        const e = r.entries.find((x) => x.from === `local/${keyOf(uri)}.ops.jsonl`);
        expect(e?.action).toBe("move");
        expect(existsSync(legacy)).toBe(false);
        expect(existsSync(`${to}.tmp`)).toBe(false);
        expect(readFileSync(to, "utf-8")).toBe(text); // 逐字节完整
        expect(readFileSync(to, "utf-8").split("\n").filter(Boolean)).toHaveLength(50);
    });

    it("读侧永不认领 `.tmp`：只有残片时裁决仍走「旧平铺兜底」", () => {
        const uri = createTask({ title: "迁移-残片", project: createProject(join(diyHome(), "migrate-part")) });
        const legacy = writeLegacy(uri, "ops", `{"op":"start"}\n`);
        const to = sessionFile(uri, "ops");
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(`${to}.tmp`, "truncated", "utf-8"); // 残片存在，但目标不存在

        expect(existsSync(to)).toBe(false); // 残片不冒充目标
        expect(resolveSessionFile(uri, "ops")).toBe(legacy); // 裁决看到的是旧平铺（完整那份）
        expect(readFileSync(resolveSessionFile(uri, "ops"), "utf-8")).toBe(`{"op":"start"}\n`);
        rmSync(`${to}.tmp`, { force: true });
    });

    it("目标已存在且比源小（旧实现留下的截断副本）→ 备份后重做，读侧立刻读到完整行数（##266 review2 R1.1）", () => {
        // 新实现不再**产生**截断目标；但盘上可能已有旧版本留下的残迹。若只报 conflict「留原地」，
        // 读侧双认仍会优先认领那份截断的 ⇒ 历史依旧腰斩。判据：正常迁移只产生「等大」目标，
        // 故「目标 < 源」只可能是截断残迹 ⇒ 备份后重做（源零丢失）。
        const uri = createTask({ title: "迁移-截断目标", project: createProject(join(diyHome(), "migrate-truncated-target")) });
        const text = Array.from({ length: 50 }, (_, i) => `{"op":"append","i":${i}}`).join("\n") + "\n";
        const legacy = writeLegacy(uri, "ops", text);
        const to = sessionFile(uri, "ops");
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, text.slice(0, 40), "utf-8"); // 截断目标（比源小）

        // 迁移前：读侧优先认领截断那份（R1.1 的风险）
        const before = readFileSync(resolveSessionFile(uri, "ops"), "utf-8").split("\n").filter(Boolean);
        expect(before.length).toBeLessThan(50);

        const r = migrateLocalLayout({ dryRun: false, toolout: false });
        const e = r.entries.find((x) => x.from === `local/${keyOf(uri)}.ops.jsonl`);
        expect(e?.action).toBe("move");
        expect(e?.note).toContain("截断副本");
        expect(existsSync(legacy)).toBe(false);
        expect(readFileSync(to, "utf-8")).toBe(text); // 读侧立刻恢复完整
        expect(readFileSync(resolveSessionFile(uri, "ops"), "utf-8").split("\n").filter(Boolean)).toHaveLength(50);
        // 残片备份留着（数据安全优先于搬干净）
        const backups = readdirSync(dirname(to)).filter((n) => n.includes(".conflict-"));
        expect(backups).toHaveLength(1);
        expect(readFileSync(join(dirname(to), backups[0]), "utf-8")).toBe(text.slice(0, 40));
    });
});

describe("工具输出原文：按会话账本归属（##379）", () => {
    it("账本里 clipped 引用过的 id → 搬到该会话目录", () => {
        const uri = createTask({ title: "迁移-toolout", project: createProject(join(diyHome(), "migrate-toolout")) });
        writeLegacy(uri, "compact", `{"kind":"compact","details":{"clipped":[{"id":"call_mig_1"}]}}\n`);
        const legacyOut = join(localDir(), "toolout", "call_mig_1.txt");
        mkdirSync(dirname(legacyOut), { recursive: true });
        writeFileSync(legacyOut, "原文全文", "utf-8");

        const r = migrateLocalLayout({ dryRun: false, toolout: true });
        expect(r.toolOut.owned).toBeGreaterThan(0);
        expect(existsSync(legacyOut)).toBe(false);
        expect(readFileSync(join(sessionDir(uri), "toolout", "call_mig_1.txt"), "utf-8")).toBe("原文全文");
    });
});

describe("生产根：只允许 dry-run", () => {
    it("DIY_ENV=production 时实迁直接报错（不静默降级）", () => {
        const prev = process.env["DIY_ENV"];
        process.env["DIY_ENV"] = "production";
        try {
            expect(() => migrateLocalLayout({ dryRun: false, toolout: false })).toThrow(/生产根/);
            expect(migrateLocalLayout({ dryRun: true, toolout: false }).dryRun).toBe(true);
        } finally {
            if (prev === undefined) delete process.env["DIY_ENV"];
            else process.env["DIY_ENV"] = prev;
        }
    });
});
