/**
 * persona.intent.test.ts — 【意图测试 · 无 UI 层】人物与「任务该怎么称呼自己」的规则说明书。
 *
 * ── 这份文件首先是**需求**，其次才是测试 ────────────────────────────
 * 读法：`describe` = 一组需求，`it` = 一条需求。断言只用业务词（人物、任务、缺省、绑定），
 * 不出现表名、字段名、传输方式。
 *
 * 判据（拿它当说明书的人该怎么看）：
 *   · 需求改了 → 改这里的文案与断言；改不动，说明这条被写成了实现细节。
 *   · 内部重构（换存储 / 换传输 / 换进程模型）→ 断言原样通过。
 *
 * ── 为什么这一层不用界面 ──────────────────────────────────────────
 * 它测的是**不走界面也要成立**的用户需求：CLI 用户、脚本、将来的第三方接入都直接调这些能力。
 * 执行方式选「进程内 rpc 直连生产实现」：不是测替身，而是省掉每条断言 0.68s 的起进程
 * （老写法 cli.intent.persona 34 条 137s，同一批规则在这里是几百毫秒）。
 * 数据根是临时目录，与用户的 ~/.diy 无关。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    ChannelClientBinding,
    ChannelServerBinding,
    createMemTransportPair,
    createTypedClient,
} from "@diy-agent/rpc";
import { apiDef } from "../../src/main/services/api-def";
import { bindAppHandlers } from "../../src/main/services/api-impl";
import { createProject } from "../../src/main/core/project";
import { seedHome } from "../../src/main/core/seed";
import { refreshModelRuntime } from "../../src/main/core/model-runtime";
import { getModelCatalog } from "../../src/shared/models";
import { sessionFileRel } from "../../src/main/core/local-paths";

type Persona = { id: string; name: string; model: string; reasoningEffort: string; instructions: string; taskCount: number };
type PersonaList = { default: string; personas: Persona[]; followCount: number };

let home: string;
let rpc: ReturnType<typeof createTypedClient<typeof apiDef>>;
let projectId: string;
let seq = 0;
/** 起手先种一个模型目录（空 home 没有 model.yaml ⇒ persona.set 一律"未知模型"） */
let MODEL = "";
/** 第二个可用模型（改模型的用例要换一个不同的） */
let MODEL2 = "";

/** 造一个人物，返回 id（对照组：CLI 的 `agent persona set`） */
async function addPersona(name: string, model = MODEL, extra: Record<string, string> = {}): Promise<string> {
    const r = (await rpc.diy.agent.persona.set({
        name,
        model,
        reasoningEffort: undefined,
        instructions: undefined,
        id: undefined,
        ...extra,
    } as never)) as { id: string };
    return r.id;
}

async function personaList(): Promise<PersonaList> {
    return (await rpc.diy.agent.persona.list({})) as PersonaList;
}

/** 建任务（跟着缺省人物），返回 uri */
async function setupTask(title: string): Promise<string> {
    const r = (await rpc.diy.task.create({ project: projectId, title: `${title}#${String(++seq)}` } as never)) as {
        uri?: string;
        data?: { uri?: string };
    };
    const uri = r.uri ?? r.data?.uri;
    if (!uri) throw new Error(`建任务失败: ${JSON.stringify(r).slice(0, 400)}`);
    return uri;
}

/** 读任务 frontmatter 里的 persona 键（**落盘事实**，不是接口回显） */
function personaOf(uri: string): string | undefined {
    const text = readFileSync(join(home, uri, "AGENTS.md"), "utf-8");
    const m = /^persona:\s*(.+)$/m.exec(text);
    return m ? m[1]!.trim() : undefined;
}

const uniq = (p: string): string => `${p}${Date.now().toString(36)}${String(seq++)}`;

beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "persona-rpc-"));
    process.env["DIY_HOME"] = home;
    // 空数据根里没有任何模型 ⇒ 先种一份（seed 写 model.yaml），再刷新运行时目录。
    // 不种的话 `persona.set --model …` 全部报「未知模型」（实测踩过）。
    seedHome(home, process.env, { autoOnly: false });
    refreshModelRuntime(home);

    const { serverTx, clientTx } = createMemTransportPair();
    bindAppHandlers(new ChannelServerBinding(serverTx));
    rpc = createTypedClient<typeof apiDef>(new ChannelClientBinding(clientTx), apiDef);
    projectId = createProject(join(home, "repo"), { label: "测试项目" });
    // 从**运行时目录**挑可用模型（不写死名字：快照变了也不假红）。
    // 注意不能用 `diy.agent.local.models` —— 那条要 Electron 的 local-agent，node 环境拿不到。
    const catalog = getModelCatalog();
    if (catalog.length === 0) throw new Error("种子后仍没有可用模型 —— seedHome / refreshModelRuntime 没生效");
    const idOf = (m: { ref?: string; id?: string }): string => m.ref ?? m.id ?? "";
    MODEL = idOf(catalog[0]!);
    MODEL2 = idOf(catalog[1] ?? catalog[0]!);
});

afterAll(() => {
    rmSync(home, { recursive: true, force: true });
});

describe("人物是一种配置：可以新建、改名、换模型，但不能删", () => {
    it("开箱即用：系统自带一个人物，新任务默认用它", async () => {
        const d = await personaList();
        expect(d.personas.length).toBeGreaterThanOrEqual(1);
        expect(d.personas.map((p) => p.id)).toContain(d.default);
        // 注意：空数据根里是**内置人物**（model 为空串 —— 它只是兜底，不是可用配置）。
        // 「缺省必须有模型」这条由「新建人物」与 select 校验守着；这里只锁 id 形状与默认指向。
        expect(d.personas.find((p) => p.id === d.default)?.name).toBeTruthy();
    });

    it("新建人物后可以单独改它的模型，没提到的设置保持不变", async () => {
        const 名 = uniq("密探");
        const id = await addPersona(名, MODEL, { instructions: "只回要点。" });
        expect(id).toMatch(/^persona\/\d+$/);
        const p = (await personaList()).personas.find((x) => x.id === id)!;
        expect(p.model).toBe(MODEL);
        expect(p.instructions).toBe("只回要点。");

        await rpc.diy.agent.persona.set({ id, model: MODEL2, name: undefined, reasoningEffort: undefined, instructions: undefined } as never);
        const p2 = (await personaList()).personas.find((x) => x.id === id)!;
        expect(p2.model).toBe(MODEL2);
        expect(p2.instructions).toBe("只回要点。");
        expect(p2.name).toBe(名);
    });

    it("给人物改名只改显示名，不影响任何引用", async () => {
        const 原 = uniq("待改名");
        const 新 = uniq("改名后");
        const id = await addPersona(原);
        await rpc.diy.agent.persona.set({ id, name: 新, model: undefined, reasoningEffort: undefined, instructions: undefined } as never);
        const p = (await personaList()).personas.find((x) => x.id === id)!;
        expect(p.name).toBe(新);
        expect(p.id).toBe(id);
    });

    it("写不进去的组合当场拒绝：不存在的模型、模型不支持的推理强度", async () => {
        await expect(
            rpc.diy.agent.persona.set({ name: "报错人物", model: "不存在的模型", id: undefined, reasoningEffort: undefined, instructions: undefined } as never),
        ).rejects.toThrow(/未知模型/);
        await expect(
            rpc.diy.agent.persona.set({ name: "报错人物", model: MODEL, reasoningEffort: "ultra", id: undefined, instructions: undefined } as never),
        ).rejects.toThrow(/不支持推理强度/);
        expect((await personaList()).personas.map((p) => p.name)).not.toContain("报错人物");
    });

    it("换缺省人物：跟随缺省的任务跟着变，固定绑定的任务不动", async () => {
        const 炮手 = await addPersona(uniq("炮手"), MODEL2);
        const 跟随的 = await setupTask("跟随缺省");
        expect(personaOf(跟随的)).toBeUndefined();

        const 固定的 = await setupTask("固定绑定");
        await rpc.diy.task.edit({ uri: 固定的, persona: 炮手 } as never);

        await rpc.diy.agent.persona.setDefault({ id: 炮手 });
        expect(personaOf(跟随的)).toBeUndefined();
        expect(personaOf(固定的)).toBe(炮手);

        const r1 = (await rpc.diy.task.show({ uri: 跟随的 } as never)) as { data?: { persona?: string } };
        expect(r1.data?.persona).toBeUndefined();
    });
});

describe("任务用哪个人物：跟随缺省，或者固定绑一个", () => {
    it("新建任务默认跟随缺省——不给它钉死当时那个人物", async () => {
        const uri = await setupTask("跟随缺省绑定");
        expect(personaOf(uri)).toBeUndefined();
        const text = readFileSync(join(home, uri, "AGENTS.md"), "utf-8");
        expect(text).not.toMatch(/^persona:/m);
    });

    it("给某个任务换人物，只影响它自己，历史对话不重来", async () => {
        const 工兵 = await addPersona(uniq("工兵"));
        const a = await setupTask("任务A");
        const b = await setupTask("任务B");
        const before = personaOf(b);

        const ops = join(home, sessionFileRel(a, "ops"));
        mkdirSync(dirname(ops), { recursive: true });
        writeFileSync(ops, `${JSON.stringify({ op: "start", id: "t1", kind: "turn" })}\n`, "utf-8");

        await rpc.diy.task.edit({ uri: a, persona: 工兵 } as never);
        expect(personaOf(a)).toBe(工兵);
        expect(personaOf(b)).toBe(before);
        expect(existsSync(ops)).toBe(true);
    });

    it("人物改名字以后，绑它的任务照旧是它", async () => {
        const 原名 = uniq("原名");
        const 新名 = uniq("新名");
        const id = await addPersona(原名);
        const uri = await setupTask("改名不影响绑定");
        await rpc.diy.task.edit({ uri, persona: id } as never);

        await rpc.diy.agent.persona.set({ id, name: 新名, model: undefined, reasoningEffort: undefined, instructions: undefined } as never);
        expect(personaOf(uri)).toBe(id);
        expect((await personaList()).personas.find((x) => x.id === id)?.name).toBe(新名);
    });

    it("固定绑定后，看任务详情能看出它绑的是谁", async () => {
        const id = await addPersona(uniq("回显人物"));
        const uri = await setupTask("回显测试");
        await rpc.diy.task.edit({ uri, persona: id } as never);
        const r = (await rpc.diy.task.show({ uri } as never)) as { data?: { persona?: string } };
        expect(r.data?.persona).toBe(id);
        expect(id).toMatch(/^persona\/\d+$/);
    });

    it("绑一个不存在的人物会被拒绝——系统里不留指向空的引用", async () => {
        const uri = await setupTask("悬空引用");
        await expect(rpc.diy.task.edit({ uri, persona: "persona/9999" } as never)).rejects.toThrow(/不存在/);
        expect(personaOf(uri)).not.toBe("persona/9999");
    });

    it("把任务的人物清空，等于改回跟随缺省", async () => {
        const id = await addPersona(uniq("被清空的"));
        const a = await setupTask("清空A");
        await rpc.diy.task.edit({ uri: a, persona: id } as never);
        expect(personaOf(a)).toBe(id);
        await rpc.diy.task.edit({ uri: a, persona: "default" } as never);
        expect(personaOf(a)).toBeUndefined();

        const b = await setupTask("清空B");
        await rpc.diy.task.edit({ uri: b, persona: id } as never);
        await rpc.diy.task.edit({ uri: b, persona: "" } as never);
        expect(personaOf(b)).toBeUndefined();
    });

    it("建任务时就能直接指定用哪个人物", async () => {
        const id = await addPersona(uniq("被指定的"));
        const r = (await rpc.diy.task.create({ project: projectId, title: `指定人物#${String(++seq)}`, persona: id } as never)) as {
            uri?: string;
            data?: { uri?: string };
        };
        const uri = r.uri ?? r.data?.uri;
        expect(uri).toBeTruthy();
        expect(personaOf(uri!)).toBe(id);
    });
});

describe("影响面：换一个人物之前，先能看出谁在用它", () => {
    it("人物清单里能看到每个人物被多少个任务用着", async () => {
        const id = await addPersona(uniq("统计人物"));
        const uri = await setupTask("被统计的任务");
        await rpc.diy.task.edit({ uri, persona: id } as never);
        const d = await personaList();
        expect(d.personas.find((p) => p.id === id)?.taskCount).toBe(1);
        expect(typeof d.personas.find((p) => p.id === d.default)?.taskCount).toBe("number");
    });
});

describe("人物暂时不能删除（有意为之，不是缺功能）", () => {
    it("系统里没有删除人物的入口——下线一个人物就改它的配置，让引用者原地跟随", () => {
        const persona = (apiDef.diy.agent as unknown as { persona?: Record<string, unknown> }).persona ?? {};
        expect(Object.keys(persona)).not.toContain("remove");
    });
});
