// tests/cli.intent.template.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 template 域 CLI 意图测试 —— 提示词模版（内置只读 + 项目级覆盖 + 装配预览）
//
// 需求定义（本文件即契约）：
//   1. list/get：七份内置，_guard 锁定不可覆盖（带 tip）
//   2. save/restore：项目级覆盖落盘 + sidecar 记 baseVersion；恢复后不留残留
//   3. 拒绝：不可覆盖项 / 非白名单 relpath（含原型链键）/ 穿越
//   4. preview：分节装配（空节不进请求）+ 仿真请求体（走真发组装链）+ 告警不回退成假值
//   5. preview 的 project 以 taskUri 为准（两者指向不同项目时不静默错配）
//   6. 超预算：拒绝发送，但**轮次必须闭合**（stop + turn-end 审计，不留僵尸轮次）
//
// 每个用例自建 project、自删；共享的只有 Electron 基础设施，共享数据为零。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";

interface ElectronFixture {
    sh: ShellTest;
    HOME: string;
    electron: ElectronTest;
}

let fx: ElectronFixture;

beforeAll(async () => {
    // 超预算用例会走到 chat()，它要求 main 进程有 OPENCODE_ZEN_API_KEY；
    // 该路径在发送前就早退（不触网），给假 key 只为过前置校验。
    process.env["OPENCODE_ZEN_API_KEY"] ||= "intent-test-dummy-key";
    // DIY_CLI 注入契约：真实入口会注入它（diy.sh / bin/diy / electron-dev.mts），
    // 这里让隔离 Electron 继承一份，断言「注入后提示词不再退化成裸 diy」；
    // 「未注入」分支由单测 tests/core/prompt-registry.test.ts 覆盖。
    process.env["DIY_CLI"] ||= join(__dirname, "..", "..", "..", "diy.sh");
    const electron = await startElectronTest();
    const HOME = electron.home;
    fx = {
        electron,
        HOME,
        sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
    };
});

afterAll(async () => {
    await fx?.electron?.stop();
});

async function freshProj(name: string): Promise<string> {
    const repo = `${fx.HOME}/tpl-${name}`;
    const res = await fx.sh.getJson(`./diy.sh project create ${repo}`);
    return String(((res.data as Record<string, unknown>)?.data as Record<string, unknown>)?.id);
}

async function cleanup(id: string): Promise<void> {
    await fx.sh.run(`./diy.sh project remove ${id}`);
}

/** 覆盖文件路径（不走 CLI，便于直接构造边界输入） */
function overridePath(pid: string, relpath: string): string {
    return join(fx.HOME, "projects", pid, "template", relpath);
}

describe("template list/get", () => {
    it("list — 装配入口 + 七份节 + 链片段、全部 builtin、入口与 _guard 锁定", async () => {
        const pid = await freshProj("list");
        const r = await fx.sh.getJson(`./diy.sh template list ${pid}`);
        const list = r.data as Array<{
            relpath: string;
            status: string;
            locked: boolean;
            lockTip: string;
            role: "entry" | "section";
        }>;
        expect(list.map((e) => e.relpath)).toEqual([
            "_system.md",
            "identity.md",
            "diy.md",
            "project.md",
            "task.md",
            "rules.md",
            "skills.md",
            "_guard.md",
        ]);
        expect(list.every((e) => e.status === "builtin")).toBe(true);
        // 角色由入口的 include 推导（不再由 frontmatter 声明，避免两处漂移）
        expect(list.find((e) => e.relpath === "_system.md")!.role).toBe("entry");
        expect(list.find((e) => e.relpath === "project.md")!.role).toBe("section");
        expect(list.every((e) => e.role === (e.relpath === "_system.md" ? "entry" : "section"))).toBe(true);
        // 命名约定 `_` = 锁定：入口与保命契约都不可覆盖
        const guard = list.find((e) => e.relpath === "_guard.md")!;
        expect(guard.locked).toBe(true);
        expect(guard.lockTip.length).toBeGreaterThan(0);
        expect(list.find((e) => e.relpath === "_system.md")!.locked).toBe(true);
        expect(list.find((e) => e.relpath === "rules.md")!.locked).toBe(false);
        await cleanup(pid);
    });

    it("get — 单份模版含内置/当前/stale", async () => {
        const pid = await freshProj("get");
        const r = await fx.sh.getJson(`./diy.sh template get ${pid} diy.md`);
        const e = r.data as Record<string, unknown>;
        expect(e["status"]).toBe("builtin");
        expect(e["current"]).toBe(e["builtin"]);
        expect(e["stale"]).toBe(false);
        // 变量命名空间化（M4）：模版里写 {{diy.cli}}，由入口注入的绝对路径渲染
        expect(String(e["builtin"])).toContain("{{diy.cli}}");
        await cleanup(pid);
    });
});

describe("template save/restore", () => {
    it("save → overridden + 落盘 + sidecar；restore → 回 builtin 且不留残留", async () => {
        const pid = await freshProj("save");
        await fx.sh.assertJson(`./diy.sh template save ${pid} identity.md "定制身份行"`, {
            ok: true,
            data: { status: "overridden", current: "定制身份行" },
        });
        expect(existsSync(overridePath(pid, "identity.md"))).toBe(true);
        expect(existsSync(join(fx.HOME, "projects", pid, "template", ".meta.yaml"))).toBe(true);

        await fx.sh.assertJson(`./diy.sh template restore ${pid} identity.md`, {
            ok: true,
            data: { status: "builtin" },
        });
        expect(existsSync(overridePath(pid, "identity.md"))).toBe(false);
        // 恢复后 sidecar 不留空壳、目录不留空壳
        expect(existsSync(join(fx.HOME, "projects", pid, "template", ".meta.yaml"))).toBe(false);
        expect(existsSync(join(fx.HOME, "projects", pid, "template"))).toBe(false);
        // 幂等
        await fx.sh.run(`./diy.sh template restore ${pid} identity.md`);
        await cleanup(pid);
    });

    it("save 拒绝：_guard 不可覆盖 / 非白名单 / 原型链键 / 穿越", async () => {
        const pid = await freshProj("reject");
        for (const rel of ["_guard.md", "nope.md", "toString", "../state.yaml"]) {
            const r = await fx.sh.run(`./diy.sh template save ${pid} ${rel} "x"`);
            expect(r.code, `${rel} 应被拒绝`).not.toBe(0);
        }
        await cleanup(pid);
    });
});

describe("template preview", () => {
    it("分节装配 + 空节不进请求 + 仿真请求体走真发组装链", async () => {
        const pid = await freshProj("preview");
        await fx.sh.run(`./diy.sh task create 预览任务 ${pid}`);
        const uri = `projects/${pid}/tasks/1`;
        const r = await fx.sh.getJson(`./diy.sh template preview ${pid} --taskUri ${uri}`);
        const p = r.data as Record<string, unknown>;
        const system = String(p["system"]);
        expect(system).toContain("<diy>");
        expect(system).toContain("<project_context>");
        expect(system).toContain("<task>");
        expect(system).toContain("<rules>");
        expect(system).toContain("<guard>");
        expect(system).not.toContain("<skills>"); // 空节不进请求
        expect(system).toContain("预览任务");
        // DIY_CLI 注入后：渲染成绝对入口，且不再报「未注入」告警
        expect(system).toContain(String(process.env["DIY_CLI"]));
        expect(p["warnings"]).toEqual([]);
        // 仿真请求体：与真发同一条链（messages[0] 是 system、带 tools/参数）
        const body = p["requestBody"] as Record<string, unknown>;
        expect(body).toBeTruthy();
        const messages = body["messages"] as Array<Record<string, unknown>>;
        expect(messages[0]?.["role"]).toBe("system");
        expect(messages[0]?.["content"]).toBe(system);
        expect(body["tools"]).toBeTruthy();
        await cleanup(pid);
    });

    it("project 以 taskUri 为准（两个 project 不一致时不静默错配）", async () => {
        const pidA = await freshProj("uriA");
        const pidB = await freshProj("uriB");
        await fx.sh.run(`./diy.sh task create A任务 ${pidA}`);
        const r = await fx.sh.getJson(
            `./diy.sh template preview ${pidB} --taskUri projects/${pidA}/tasks/1`,
        );
        const p = r.data as Record<string, unknown>;
        // system 里的任务与 cwd 必须来自 taskUri 的那个项目
        expect(String(p["system"])).toContain("A任务");
        expect(String(p["system"])).toContain(`projects/${pidA}/tasks/1`);
        await cleanup(pidA);
        await cleanup(pidB);
    });

    it("覆盖只取 body（frontmatter 不进请求）；未知路径响亮报错（不再静默上报）", async () => {
        const pid = await freshProj("frontmatter");
        mkdirSync(join(fx.HOME, "projects", pid, "template"), { recursive: true });
        // 先放一个**合法**覆盖：frontmatter 必须不进请求
        writeFileSync(
            overridePath(pid, "rules.md"),
            "---\ntitle: 手写覆盖\nversion: 9\n---\n<rules>\n- 我自己的规则\n</rules>\n",
            "utf-8",
        );
        const ok = await fx.sh.getJson(`./diy.sh template preview ${pid}`);
        const okSystem = String((ok.data as Record<string, unknown>)["system"]);
        expect(okSystem).toContain("- 我自己的规则");
        expect(okSystem).not.toContain("title: 手写覆盖");
        // 预览带结构 trace（试验场「模版结构树」的数据源）；真发不带
        const trace = (ok.data as Record<string, unknown>)["trace"] as Array<Record<string, unknown>>;
        expect(Array.isArray(trace)).toBe(true);
        // 节点的「参数」= 模版里写的 relpath；「值」= 求值结果
        expect(trace.some((n) => n["arg"] === "./rules.md")).toBe(true);
        expect(trace.every((n) => typeof n["bytes"] === "number")).toBe(true);
        // 区间随预览下发：点模版结构树 → 高亮模版那段源码 + 预览那段产出（两个区间都在）
        const sys = String((ok.data as Record<string, unknown>)["system"]);
        for (const n of trace) {
            const src = n["src"] as { from: number; to: number };
            const out = n["out"] as { from: number; to: number };
            expect(src, `src 区间缺失：${n["name"]}`).toBeTruthy();
            expect(out, `out 区间缺失：${n["name"]}`).toBeTruthy();
            expect(src.to).toBeGreaterThan(src.from);
            expect(out.from).toBeLessThanOrEqual(out.to);
            expect(out.to).toBeLessThanOrEqual(sys.length);
        }
        // 实际注入值随预览一起下发（「变量值」view 的数据源）
        const values = (ok.data as Record<string, unknown>)["values"] as Record<string, unknown>;
        expect(Object.keys(values)).toEqual(
            expect.arrayContaining(["diy", "project", "task", "cwd", "chain", "skills"]),
        );

        // 再放一个引用未知路径的覆盖：引擎严格 → 预览直接失败（旧行为是"未知变量"软警告）
        writeFileSync(
            overridePath(pid, "rules.md"),
            "---\ntitle: 手写覆盖\nversion: 9\n---\n<rules>\n- 规则 {{nope}}\n</rules>\n",
            "utf-8",
        );
        const bad = await fx.sh.run(`./diy.sh template preview ${pid}`);
        expect(bad.code).not.toBe(0);
        expect(String(bad.stderr)).toContain("nope");
        // 手工放的覆盖（无 sidecar）也提示可能过期
        const g = await fx.sh.getJson(`./diy.sh template get ${pid} rules.md`);
        expect((g.data as Record<string, unknown>)["stale"]).toBe(true);
        await cleanup(pid);
    });

    it("超预算：拒绝发送但轮次闭合（stop + turn-end 审计）", async () => {
        const pid = await freshProj("budget");
        await fx.sh.run(`./diy.sh task create 超预算任务 ${pid}`);
        const uri = `projects/${pid}/tasks/1`;
        // 直接放一份超大覆盖（> 64KB 预算）：走读路径即可，不必经 CLI 传 70KB 参数
        mkdirSync(join(fx.HOME, "projects", pid, "template"), { recursive: true });
        writeFileSync(overridePath(pid, "identity.md"), "x".repeat(70 * 1024), "utf-8");

        const r = await fx.sh.run(`./diy.sh agent local chat ${uri} "你好"`, 60_000);
        const ops = r.stdout
            .split("\n")
            .filter((l) => l.trim().startsWith('{"op"'))
            .map((l) => JSON.parse(l) as { op: string; id: string; kind?: string; meta?: { source?: string } });
        expect(ops.some((o) => o.op === "start" && o.kind === "error" && o.meta?.source === "budget")).toBe(true);
        const turn = ops.find((o) => o.op === "start" && o.kind === "turn");
        expect(turn, "应有 turn 块").toBeTruthy();
        // 关键回归：超预算早退也必须闭合（历史 bug：return 绕过 finally，留僵尸轮次）
        expect(ops.some((o) => o.op === "stop" && o.id === turn!.id)).toBe(true);

        const audit = readFileSync(join(fx.HOME, "log", "agent-bash.jsonl"), "utf-8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { taskUri?: string; phase?: string });
        const mine = audit.filter((a) => a.taskUri === uri);
        expect(mine.some((a) => a.phase === "turn-start")).toBe(true);
        expect(mine.some((a) => a.phase === "turn-end")).toBe(true);
        await cleanup(pid);
    }, 90_000);
});
