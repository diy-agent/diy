// tests/cli.intent.persona.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 agent 人物（persona）意图验证 —— 需求定义者
//
// 本文件锁的是这条需求（用户原话的两难）：
//   "不同会话要用不同模型，但又要能统一改；改一个会话不能把另一个也改了。"
// 落法（本层不实现多人对话，只实现"配置挂人物、会话持引用"）：
//   1. 人物是**全局配置实体**：模型/参数/口气挂它，改它对所有引用者**下一轮**生效
//   2. 任务 frontmatter 的 persona 是**引用**：换人物只影响本任务，续聊（上下文不动）
//   3. 新建任务物化缺省人物名（not null：读到的任务一定有值）
//   4. 人物的模型必须合法（未知模型 / 档位不支持 → 写入前拒绝）
//   5. 被引用的人物不可删（否则任务会静默换模型）
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";

interface ElectronFixture {
    sh: ShellTest;
    HOME: string;
    electron: ElectronTest;
}

let fx: ElectronFixture;

beforeAll(async () => {
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

/** 建一个项目 + 一个任务，返回任务 URI（每次新项目：任务号从 1 起，避免猜 id） */
async function setupTask(title: string): Promise<string> {
    const repo = `${fx.HOME}/persona-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const r = await fx.sh.getJson(`./diy.sh project create ${repo} --label 人物实验`);
    const pid = String(((r.data as Record<string, unknown>)?.data as Record<string, unknown>)?.id ?? "");
    // 用返回的 uri（不拼 tasks/1）：命令回显即事实，拼接只是猜测
    const created = await fx.sh.getJson(`./diy.sh task create ${title} ${pid}`);
    return String(((created.data as Record<string, unknown>)?.data as Record<string, unknown>)?.uri ?? "");
}

/** 会话日志键（与 main/services/local-agent.ts 的 keyOf 同规则） */
function sessionKey(taskUri: string): string {
    const readable = taskUri.replace(/[^\w.-]+/g, "_").slice(0, 64);
    const sum = createHash("sha256").update(taskUri).digest("hex").slice(0, 12);
    return `${readable}-${sum}`;
}

/** 读任务 frontmatter 里的 persona（直接读文件：锁的是"落盘事实"而不是接口回显） */
function personaOf(uri: string): string | undefined {
    const fp = join(fx.HOME, uri, "AGENTS.md");
    if (!existsSync(fp)) throw new Error(`任务文件不存在: ${fp}`);
    const m = readFileSync(fp, "utf-8").match(/^persona:\s*(.+)$/m);
    return m?.[1]?.trim().replace(/^['"]|['"]$/g, "");
}

describe("agent.persona — 人物是配置实体", () => {
    it("开箱即用：一个人物（内置缺省），且它就是缺省人物", async () => {
        const r = await fx.sh.getJson(`./diy.sh agent persona list`);
        const d = r.data as { default: string; personas: Array<{ name: string; model: string }> };
        expect(d.personas.length).toBeGreaterThanOrEqual(1);
        expect(d.default).toBeTruthy();
        expect(d.personas.map((p) => p.name)).toContain(d.default);
        // 缺省人物必须有模型（模型是必填 —— 否则"缺省"就退化成代码里的硬编码回落）
        expect(d.personas.find((p) => p.name === d.default)?.model).toBeTruthy();
    });

    it("新建人物 + 改人物的模型（统一修改的落点）", async () => {
        await fx.sh.run(`./diy.sh agent persona set 密探 --model mimo-v2.6-flash --style '只回要点。' --desc '轻量快问快答'`);
        const r = await fx.sh.getJson(`./diy.sh agent persona list`);
        const d = r.data as { personas: Array<{ name: string; model: string; style: string }> };
        const p = d.personas.find((x) => x.name === "密探");
        expect(p?.model).toBe("mimo-v2.6-flash");
        expect(p?.style).toBe("只回要点。");

        // 改模型：只给 --model，其他字段保持（CLI 的"未给 = 保持"语义）
        await fx.sh.run(`./diy.sh agent persona set 密探 --model gpt-6-luna`);
        const r2 = await fx.sh.getJson(`./diy.sh agent persona list`);
        const p2 = (r2.data as { personas: Array<{ name: string; model: string; style: string }> }).personas.find(
            (x) => x.name === "密探",
        );
        expect(p2?.model).toBe("gpt-6-luna");
        expect(p2?.style).toBe("只回要点。");
    });

    it("非法配置写入前被拒：未知模型 / 档位不在该模型支持集内", async () => {
        const bad = await fx.sh.run(`./diy.sh agent persona set 报错人物 --model 不存在的模型`);
        expect(bad.stderr + bad.stdout).toMatch(/未知模型/);

        // mimo-v2.6-flash 不支持 xhigh（实测上游 400，见 shared/models.ts）
        const bad2 = await fx.sh.run(`./diy.sh agent persona set 报错人物 --model mimo-v2.6-flash --reasoningEffort xhigh`);
        expect(bad2.stderr + bad2.stdout).toMatch(/不支持推理强度/);

        // 两次都失败 → 人物不该被建出来（写入侧拦住，不留半成品）
        const r = await fx.sh.getJson(`./diy.sh agent persona list`);
        expect((r.data as { personas: Array<{ name: string }> }).personas.map((p) => p.name)).not.toContain("报错人物");
    });

    it("setDefault 只影响之后新建的任务（已有任务绑定不变）", async () => {
        await fx.sh.run(`./diy.sh agent persona set 炮手 --model deepseek-v4.1-flash`);
        const uri = await setupTask("默认人物变更前的任务");

        await fx.sh.run(`./diy.sh agent persona setDefault 炮手`);
        expect(personaOf(uri)).toBe("大副"); // 已有任务仍绑原人物

        const uri2 = await setupTask("默认人物变更后的任务");
        expect(personaOf(uri2)).toBe("炮手"); // 新建任务物化新缺省
    });
});

describe("任务 ↔ 人物绑定", () => {
    it("新建任务物化缺省人物名（not null：读到的任务一定有值）", async () => {
        const uri = await setupTask("绑定测试");
        expect(personaOf(uri)).toBeTruthy();
    });

    it("换人物 = 只改本任务（不影响别的任务）—— 续聊，不重置会话", async () => {
        await fx.sh.run(`./diy.sh agent persona set 工兵 --model gpt-5.6-luna`);
        const a = await setupTask("任务A");
        const b = await setupTask("任务B");
        const before = personaOf(b);

        // 预置一份"已有会话"的 ops 日志（键 = local-agent 的 keyOf 规则：可读前缀 + sha256 前 12 位）
        const ops = join(fx.HOME, "local", `${sessionKey(a)}.ops.jsonl`);
        mkdirSync(join(fx.HOME, "local"), { recursive: true });
        writeFileSync(ops, `${JSON.stringify({ op: "start", id: "t1", kind: "turn" })}\n`, "utf-8");

        await fx.sh.run(`./diy.sh task edit ${a} --persona 工兵`);
        expect(personaOf(a)).toBe("工兵");
        expect(personaOf(b)).toBe(before); // 另一个任务一点没变 —— 这就是"不互相影响"
        // 续聊：换人物不碰会话日志（不是"清空上下文重开"）
        expect(existsSync(ops)).toBe(true);
    });

    it("任务能看到自己的人物（task show 回显 persona）", async () => {
        const uri = await setupTask("回显测试");
        const r = await fx.sh.getJson(`./diy.sh task show ${uri}`);
        const d = r.data as { data: { persona?: string } };
        expect(d.data.persona).toBeTruthy();
    });

    it("换到不存在的人物被拒（不许写出悬空引用）", async () => {
        const uri = await setupTask("悬空引用测试");
        const r = await fx.sh.run(`./diy.sh task edit ${uri} --persona 根本没有这个人`);
        expect(r.stderr + r.stdout).toMatch(/不存在/);
        expect(personaOf(uri)).not.toBe("根本没有这个人");
    });

    it("人物名不能清空（任务必须有人物）", async () => {
        const uri = await setupTask("清空人物测试");
        const r = await fx.sh.run(`./diy.sh task edit ${uri} --persona ''`);
        expect(r.stderr + r.stdout).toMatch(/不能为空|至少/);
    });

    it("创建任务时可显式指定人物", async () => {
        const repo = `${fx.HOME}/persona-create-${Date.now()}`;
        const r = await fx.sh.getJson(`./diy.sh project create ${repo} --label 指定人物`);
        const pid = String(((r.data as Record<string, unknown>)?.data as Record<string, unknown>)?.id ?? "");
        await fx.sh.run(`./diy.sh task create 指定人物的任务 ${pid} --persona 工兵`);
        expect(personaOf(`projects/${pid}/tasks/1`)).toBe("工兵");
    });
});

describe("UI：人物在界面上看得见、点得动（详情面板）", () => {
    /** a11y 树文本（ui inspect；`ui tree` 是任务树，别混） */
    function collectText(nodes: any[], acc: string[] = []): string[] {
        for (const n of nodes ?? []) {
            if (n?.text) acc.push(String(n.text));
            if (n?.children) collectText(n.children, acc);
        }
        return acc;
    }
    async function a11yText(): Promise<string> {
        const r = await fx.sh.getJson(`./diy.sh ui inspect`);
        return collectText([(r.data as any)?.data?.tree]).join("\n");
    }

    it("任务执行页显示当前人物与它的模型（不是只存在数据里）", async () => {
        await fx.sh.run(`./diy.sh agent persona set 演示人物 --model mimo-v2.6-flash`);
        const uri = await setupTask("UI人物测试");
        await fx.sh.run(`./diy.sh task edit ${uri} --persona 演示人物`);
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);

        const text = await a11yText();
        // 会话页的人物按钮：**当前绑定的人物名**（若 renderer 拿不到 persona 字段，
        // 这里会退回显示缺省人物 —— 那正是"界面说的模型和实际用的不是一回事"）
        expect(text).toContain("演示人物");
        // 人读模型名（不是 id）：人物决定模型，界面上要看得见是哪个
        expect(text).toContain("MiMo V2.6 Flash");
    });
});

describe("人物的删除保护", () => {
    it("被任务引用的人物不可删（否则那些任务会静默换模型）", async () => {
        await fx.sh.run(`./diy.sh agent persona set 突击手 --model gpt-6-luna`);
        const uri = await setupTask("引用突击手的任务");
        await fx.sh.run(`./diy.sh task edit ${uri} --persona 突击手`);

        const r = await fx.sh.run(`./diy.sh agent persona remove 突击手`);
        expect(r.stderr + r.stdout).toMatch(/仍被.*引用/);

        // 改绑后可删
        await fx.sh.run(`./diy.sh task edit ${uri} --persona 大副`);
        await fx.sh.run(`./diy.sh agent persona remove 突击手`);
        const list = await fx.sh.getJson(`./diy.sh agent persona list`);
        expect((list.data as { personas: Array<{ name: string }> }).personas.map((p) => p.name)).not.toContain("突击手");
    });
});
