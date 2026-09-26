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
import { makeUiDriver, type UiDriver } from "./ui-drive";
import { waitUntil } from "./wait";

interface ElectronFixture {
    sh: ShellTest;
    HOME: string;
    electron: ElectronTest;
}

let fx: ElectronFixture;
/** 真实 UI 驱动（CDP 原生事件）：面板用例要"真的点得动"，不只是数据对 */
let ui: UiDriver | undefined;

/** a11y 树（renderer 可见元素的真实快照；`ui tree` 是任务树，别混） */
async function a11yTree(): Promise<any> {
    const r = await fx.sh.getJson(`./diy.sh ui inspect`);
    return (r.data as any)?.data?.tree;
}

/** a11y 树里的全部可见文本（`ui inspect` 的 tree 是单个根节点） */
function a11yTextOf(nodes: any, acc: string[] = []): string[] {
    const list = Array.isArray(nodes) ? nodes : nodes ? [nodes] : [];
    for (const n of list) {
        if (n?.text) acc.push(String(n.text));
        a11yTextOf(n?.children, acc);
    }
    return acc;
}

async function a11yText(): Promise<string> {
    return a11yTextOf(await a11yTree()).join("\n");
}

beforeAll(async () => {
    const electron = await startElectronTest();
    const HOME = electron.home;
    fx = {
        electron,
        HOME,
        sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
    };
    // 真实 UI 驱动（CDP 原生事件）：面板用例要"真的点得动"，不只是数据对
    ui = await makeUiDriver(electron.cdpUrl, a11yTree);
});

afterAll(async () => {
    ui?.close();
    await fx?.electron?.stop();
});

/** 会话日志键（与 main/services/local-agent.ts 的 keyOf 同规则） */
function sessionKey(taskUri: string): string {
    const readable = taskUri.replace(/[^\w.-]+/g, "_").slice(0, 64);
    const sum = createHash("sha256").update(taskUri).digest("hex").slice(0, 12);
    return `${readable}-${sum}`;
}

/** 读任务 frontmatter 里的 persona（**人物 id**；直接读文件：锁的是"落盘事实"而非接口回显） */
function personaOf(uri: string): string | undefined {
    const fp = join(fx.HOME, uri, "AGENTS.md");
    if (!existsSync(fp)) throw new Error(`任务文件不存在: ${fp}`);
    const m = readFileSync(fp, "utf-8").match(/^persona:\s*(.+)$/m);
    return m?.[1]?.trim().replace(/^['"]|['"]$/g, "");
}

/** 按名字查人物 id（重试安全的寻址方式；找不到抛错，不静默） */
async function personaIdByName(name: string): Promise<string> {
    const hit = (await personaList()).personas.find((p) => p.name === name);
    if (!hit) throw new Error(`人物「${name}」不存在`);
    return hit.id;
}

/** 建一个项目 + 一个任务，返回任务 URI（每次新项目：任务号从 1 起，避免猜 id） */
async function setupTask(title: string): Promise<string> {
    const repo = `${fx.HOME}/persona-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const r = await fx.sh.getJson(`./diy.sh project create ${repo} --label 人物实验`);
    const pid = String(((r.data as Record<string, unknown>)?.data as Record<string, unknown>)?.id ?? "");
    const created = await fx.sh.getJson(`./diy.sh task create ${title} ${pid}`);
    return String(((created.data as Record<string, unknown>)?.data as Record<string, unknown>)?.uri ?? "");
}

/**
 * 建/改人物，返回 **id**。
 *
 * 用例里一律用 id 引用（`--persona <id>`）：名字是标签、id 才是引用键 ——
 * 这条契约由本文件的「改名不影响绑定」用例锁住，其他用例按真实用法写。
 */
async function addPersona(name: string, model: string, extra = ""): Promise<string> {
    const r = await fx.sh.getJson(
        `./diy.sh agent persona set --name ${name} --model ${model}${extra ? ` ${extra}` : ""}`,
    );
    const id = (r.data as { id?: string } | undefined)?.id;
    if (!id) throw new Error(`建人物失败（未返回 id）: ${name}`);
    return id;
}

/**
 * 每次调用都不同的名字：**重试安全**。
 *
 * vitest 配置了 `retry: 1`（E2E 防时序噪声）。重试会重跑用例，于是"同名人物"会被建两次，
 * 而任务还指着上一轮那个 id —— 断言拿新 id 去比，就报 `expected 'p4' to be 'p15'`
 * 这种看着像产品 bug、其实是测试自伤的错。名字唯一后，按名字查到的必然是**本轮**那个。
 */
let nameSeq = 0;
function uniq(prefix: string): string {
    return `${prefix}${Date.now().toString(36)}${nameSeq++}`;
}

/** 人物清单（用例内部断言用） */
async function personaList(): Promise<{
    default: string;
    personas: Array<{ id: string; name: string; model: string; reasoningEffort: string; style: string; taskCount: number }>;
}> {
    const r = await fx.sh.getJson(`./diy.sh agent persona list`);
    return r.data as never;
}

describe("agent.persona — 人物是配置实体", () => {
    it("开箱即用：一个人物（内置缺省），default 是它的 id", async () => {
        const d = await personaList();
        expect(d.personas.length).toBeGreaterThanOrEqual(1);
        expect(d.default).toBeTruthy();
        expect(d.personas.map((p) => p.id)).toContain(d.default); // default 是 **id**
        // 缺省人物必须有模型（模型是必填 —— 否则"缺省"就退化成代码里的硬编码回落）
        expect(d.personas.find((p) => p.id === d.default)?.model).toBeTruthy();
    });

    it("新建人物（返回 id）+ 按 id 改模型（统一修改的落点）", async () => {
        const 名 = uniq("密探");
        const id = await addPersona(名, "mimo-v2.6-flash", "--style '只回要点。'");
        expect(id).toMatch(/^p\d+$/);

        const p = (await personaList()).personas.find((x) => x.id === id)!;
        expect(p.model).toBe("mimo-v2.6-flash");
        expect(p.style).toBe("只回要点。");

        // 改模型：按 id 定位，只给 --model，其他字段保持（"未给 = 保持"语义）
        await fx.sh.run(`./diy.sh agent persona set ${id} --model gpt-6-luna`);
        const p2 = (await personaList()).personas.find((x) => x.id === id)!;
        expect(p2.model).toBe("gpt-6-luna");
        expect(p2.style).toBe("只回要点。");
        expect(p2.name).toBe(名); // 名字没被动
    });

    it("改名：只改显示名，id 不变（引用键稳定）", async () => {
        const 原 = uniq("待改名");
        const 新 = uniq("改名后");
        const id = await addPersona(原, "gpt-6-luna");
        await fx.sh.run(`./diy.sh agent persona set ${id} --name ${新}`);
        const p = (await personaList()).personas.find((x) => x.id === id)!;
        expect(p.name).toBe(新);
        expect(p.id).toBe(id);
    });

    it("非法配置写入前被拒：未知模型 / 档位不在该模型支持集内", async () => {
        const bad = await fx.sh.run(`./diy.sh agent persona set --name 报错人物 --model 不存在的模型`);
        expect(bad.stderr + bad.stdout).toMatch(/未知模型/);

        // mimo-v2.6-flash 不支持 xhigh（实测上游 400，见 shared/models.ts）
        const bad2 = await fx.sh.run(
            `./diy.sh agent persona set --name 报错人物 --model mimo-v2.6-flash --reasoningEffort xhigh`,
        );
        expect(bad2.stderr + bad2.stdout).toMatch(/不支持推理强度/);

        // 两次都失败 → 人物不该被建出来（写入侧拦住，不留半成品）
        expect((await personaList()).personas.map((p) => p.name)).not.toContain("报错人物");
    });

    it("setDefault 只影响之后新建的任务（已有任务绑定不变）", async () => {
        const 炮手 = await addPersona(uniq("炮手"), "deepseek-v4.1-flash");
        const uri = await setupTask("默认人物变更前的任务");
        const before = personaOf(uri);
        expect(before).toBeTruthy();

        await fx.sh.run(`./diy.sh agent persona setDefault ${炮手}`);
        expect(personaOf(uri)).toBe(before); // 已有任务仍绑原人物

        const uri2 = await setupTask("默认人物变更后的任务");
        expect(personaOf(uri2)).toBe(炮手); // 新建任务物化新缺省
    });
});

describe("任务 ↔ 人物绑定（引用存 id）", () => {
    it("新建任务物化缺省人物 id（not null：读到的任务一定有值）", async () => {
        const uri = await setupTask("绑定测试");
        expect(personaOf(uri)).toMatch(/^p\d+$/);
    });

    it("换人物 = 只改本任务（不影响别的任务）—— 续聊，不重置会话", async () => {
        const 工兵 = await addPersona(uniq("工兵"), "gpt-5.6-luna");
        const a = await setupTask("任务A");
        const b = await setupTask("任务B");
        const before = personaOf(b);

        // 预置一份"已有会话"的 ops 日志（键 = local-agent 的 keyOf 规则：可读前缀 + sha256 前 12 位）
        const ops = join(fx.HOME, "local", `${sessionKey(a)}.ops.jsonl`);
        mkdirSync(join(fx.HOME, "local"), { recursive: true });
        writeFileSync(ops, `${JSON.stringify({ op: "start", id: "t1", kind: "turn" })}\n`, "utf-8");

        await fx.sh.run(`./diy.sh task edit ${a} --persona ${工兵}`);
        expect(personaOf(a)).toBe(工兵);
        expect(personaOf(b)).toBe(before); // 另一个任务一点没变 —— 这就是"不互相影响"
        // 续聊：换人物不碰会话日志（不是"清空上下文重开"）
        expect(existsSync(ops)).toBe(true);
    });

    it("**人物改名后，任务的绑定不断**（引用存 id 的理由）", async () => {
        // 若拿名字当引用键，改名就等于把所有引用打断 → 引用者静默回落缺省人物（换模型不打招呼）
        const 原名 = uniq("原名");
        const 新名 = uniq("新名");
        const id = await addPersona(原名, "gpt-6-luna");
        const uri = await setupTask("改名不影响绑定的任务");
        await fx.sh.run(`./diy.sh task edit ${uri} --persona ${id}`);

        await fx.sh.run(`./diy.sh agent persona set ${id} --name ${新名}`);
        expect(personaOf(uri)).toBe(id); // 绑定原样
        // 且读侧解析到的是改名后的人物（不是回落缺省）
        expect((await personaList()).personas.find((x) => x.id === id)?.name).toBe(新名);
    });

    it("任务能看到自己的人物（task show 回显 persona id）", async () => {
        const uri = await setupTask("回显测试");
        const r = await fx.sh.getJson(`./diy.sh task show ${uri}`);
        expect((r.data as { data: { persona?: string } }).data.persona).toMatch(/^p\d+$/);
    });

    it("换到不存在的人物被拒（不许写出悬空引用）", async () => {
        const uri = await setupTask("悬空引用测试");
        const r = await fx.sh.run(`./diy.sh task edit ${uri} --persona p9999`);
        expect(r.stderr + r.stdout).toMatch(/不存在/);
        expect(personaOf(uri)).not.toBe("p9999");
    });

    it("人物不能清空（任务必须有人物）", async () => {
        const uri = await setupTask("清空人物测试");
        const r = await fx.sh.run(`./diy.sh task edit ${uri} --persona ''`);
        expect(r.stderr + r.stdout).toMatch(/不能为空|至少/);
    });

    it("创建任务时可显式指定人物（按 id）", async () => {
        const id = await addPersona(uniq("被指定的"), "gpt-6-luna");
        const repo = `${fx.HOME}/persona-create-${Date.now()}`;
        const r = await fx.sh.getJson(`./diy.sh project create ${repo} --label 指定人物`);
        const pid = String(((r.data as Record<string, unknown>)?.data as Record<string, unknown>)?.id ?? "");
        await fx.sh.run(`./diy.sh task create 指定人物的任务 ${pid} --persona ${id}`);
        expect(personaOf(`projects/${pid}/tasks/1`)).toBe(id);
    });
});

describe("References — 引用计数（改人物前先看见影响面）", () => {
    it("list 回传每人物的 taskCount", async () => {
        const id = await addPersona(uniq("统计人物167"), "gpt-6-luna");
        const uri = await setupTask("被统计的任务");
        await fx.sh.run(`./diy.sh task edit ${uri} --persona ${id}`);

        const d = await personaList();
        expect(d.personas.find((p) => p.id === id)?.taskCount).toBe(1);
        // 没人在用的人物计数为 0（而不是缺失）
        expect(typeof d.personas.find((p) => p.id === d.default)?.taskCount).toBe("number");
    });
});

describe("人物暂不提供删除（有意的能力缺位）", () => {
    it("没有 remove 子命令 —— 改人物而非删人物", async () => {
        // 删掉一个人物会让所有引用它的任务**静默回落**到缺省人物（换模型不打招呼）。
        // 要下线一个人物就改它的模型/口气（引用者原地跟随）；真需要删除时，
        // 得先设计"引用迁移"（把这 N 个任务改绑到别处）一起做。
        const r = await fx.sh.run(`./diy.sh agent persona remove p1`);
        expect(r.code).not.toBe(0);
    });
});

describe("UI：会话页看得见当前人物", () => {
    it("执行页显示当前人物名与其模型（不是只存在数据里）", async () => {
        const 名 = uniq("演示人物");
        const id = await addPersona(名, "mimo-v2.6-flash");
        const uri = await setupTask("UI人物测试");
        await fx.sh.run(`./diy.sh task edit ${uri} --persona ${id}`);
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);

        const text = await a11yText();
        // 会话页的人物按钮：**当前绑定的人物名**（若 renderer 拿不到 persona 字段，
        // 这里会退回显示缺省人物 —— 那正是"界面说的模型和实际用的不是一回事"）
        expect(text).toContain(名);
        // 人读模型名（不是 id）：人物决定模型，界面上要看得见是哪个
        expect(text).toContain("MiMo V2.6 Flash");
    });
});

describe("UI：人物面板（主从视图）—— 选、改、换绑都在这里", () => {
    /**
     * 打开面板：点会话页的人物按钮。
     *
     * **必须按任务 URI 限定选择器**（sel = 本任务那个面板）：每个 tab 各挂一个 LocalChatPage，
     * 同时挂载时 `[aria-label="用于本任务"]` 会有多份 —— 全局 querySelector 命中的是**别人那个面板**，
     * 于是"点了我这儿"实际动的是另一个任务的绑定（实测：断言里 persona 一直是另一个 id）。
     * 就绪判据也用面板独有元素，不拿"agent 人物"这类文字（会话页按钮的 aria-label 里就有）。
     */
    /**
     * 真实点击**并把目标滚入视野**。
     *
     * clickSelector 只在"元素中心"派发原生事件，不做命中检查 —— 目标在滚动区外时，
     * 坐标落到别人身上，表现为"点了没反应"（实测：人物列表随用例累积变长后，最后一项在视口外）。
     */
    async function clickIn(selector: string): Promise<void> {
        await ui!.eval<boolean>(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return false;
            el.scrollIntoView({ block: "center" });
            return true;
        })()`);
        await ui!.clickSelector(selector);
    }

    function sel(root: string): string {
        return `[data-testid="persona-drawer"][data-uri="${root}"]`;
    }
    async function openPanel(root: string): Promise<void> {
        // 面板可能还开着（上个用例留下的）：先**全部**关掉。
        // 必须关干净：面板只在 open 的 false→true 跳变时刷新清单，若它还开着，
        // 本用例刚建的人物不会出现在左列 → 后面的点击找不到目标（实测就是这个坑）。
        // 关的时候不能按 sel(root) 限定：那时 selectedUri 还停在上一个用例的任务上。
        await ui!.eval<boolean>(`(() => {
            document.querySelectorAll('[data-testid="persona-drawer"] [aria-label="关闭人物面板"]').forEach(b => b.click());
            return true;
        })()`);
        await waitUntil(
            async () => ui!.eval<number>(`document.querySelectorAll('[data-testid="persona-drawer"]').length`),
            (n) => n === 0,
            { label: "旧面板已关" },
        );
        await ui!.clickSelector(`[aria-label="打开 agent 人物面板"]`);
        await waitUntil(
            async () => ui!.eval<boolean>(`!!document.querySelector('${sel(root)}')`),
            (v) => v === true,
            { label: "面板已打开" },
        );
        await waitUntil(
            async () => ui!.eval<boolean>(`(() => {
                const b = document.querySelector('${sel(root)} button[aria-pressed]');
                return !!b && !b.disabled;
            })()`),
            (v) => v === true,
            { label: "模型/档位按钮可用（清单已到）" },
        );
    }

    it("主从视图：左列人物带引用数，右侧是平铺的模型/级别按钮（不是下拉）", async () => {
        const 名 = uniq("面板人物");
        const id = await addPersona(名, "mimo-v2.6-flash");
        const uri = await setupTask("面板测试任务");
        await fx.sh.run(`./diy.sh task edit ${uri} --persona ${id}`);
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);

        await openPanel(uri);
        const text = await a11yText();
        expect(text).toContain(名);
        expect(text).toContain("本任务");
        expect(text).toMatch(/\d+ 个任务在用|暂无任务在用/);
        // 属性直接可改；模型用**平铺按钮**（aria-pressed 标记选中），不是 select
        expect(text).toContain("模型");
        expect(text).toContain("思考级别");
        expect(text).toContain("口气");
        // 右侧默认编辑的是**本任务绑定的人物**（否则用户会在别人身上改全局配置）
        const st = await ui!.eval<{ editing: string | null; bound: string | null; selects: number }>(`(() => {
            const d = document.querySelector('${sel(uri)}');
            return {
                editing: d?.getAttribute('data-editing') ?? null,
                bound: d?.getAttribute('data-bound') ?? null,
                selects: d?.querySelectorAll('select').length ?? -1,
            };
        })()`);
        expect(st.editing).toBe(id);
        expect(st.bound).toBe(id);
        // 面板内不应再有 <select>（模型与档位都是平铺按钮；名字/口气是输入框）
        expect(st.selects).toBe(0);
        // 且**当前模型的按钮是选中态**（显示与实际一致：选中 mimo 就得亮 mimo）
        const pressed = await ui!.eval<string[]>(
            `Array.from(document.querySelectorAll('${sel(uri)} button[aria-pressed="true"]')).map(b => b.getAttribute('aria-label'))`,
        );
        expect(pressed).toContain("MiMo V2.6 Flash");
    });

    it("点平铺按钮改模型 → 落盘 personas.yaml（改完即存）", async () => {
        const id = await addPersona(uniq("改模型人物"), "mimo-v2.6-flash");
        const uri = await setupTask("改模型任务");
        await fx.sh.run(`./diy.sh task edit ${uri} --persona ${id}`);
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await openPanel(uri);

        // 真实点击「GPT 6 Luna」按钮（不是派发合成 change —— 这里就是按钮，点得动）
        await clickIn(`${sel(uri)} button[aria-label="GPT 6 Luna"]`);
        const changed = await waitUntil(
            async () => (await personaList()).personas.find((p) => p.id === id)?.model,
            (m) => m === "gpt-6-luna",
            { label: "personas.yaml 里的模型已改" },
        );
        expect(changed).toBe("gpt-6-luna");
    });

    it("改模型后，档位按钮换成该模型的候选集（各模型词表不同）", async () => {
        // gpt-6-luna 支持 xhigh/max；mimo-v2.6-flash 只到 high。切模型后按钮集必须跟着换，
        // 否则用户点一个上游必拒的档位（400 Invalid request parameters）。
        const id = await addPersona(uniq("档位随模型"), "mimo-v2.6-flash");
        const uri = await setupTask("档位测试任务");
        await fx.sh.run(`./diy.sh task edit ${uri} --persona ${id}`);
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await openPanel(uri);

        const levelsOf = () =>
            ui!.eval<string[]>(
                `Array.from(document.querySelectorAll('${sel(uri)} button[aria-pressed]')).map(b => b.getAttribute('aria-label'))`,
            );
        expect(await levelsOf()).not.toContain("超高"); // mimo 没有 xhigh
        await clickIn(`${sel(uri)} button[aria-label="GPT 6 Luna"]`);
        await waitUntil(async () => (await levelsOf()).includes("超高"), (v) => v === true, { label: "档位集跟着换" });
    });

    it("改名输入框：改完即存，id 不变", async () => {
        const 前 = uniq("面板改名前");
        const 后 = uniq("面板改名后");
        const id = await addPersona(前, "gpt-6-luna");
        const uri = await setupTask("面板改名任务");
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await openPanel(uri);
        // 左列点中它，再改名字输入框
        await clickIn(`${sel(uri)} [aria-label="人物 ${前}"]`);
        await clickIn(`${sel(uri)} input[aria-label="人物名字"]`);
        await ui!.press("Meta+A");
        await ui!.type(后);
        await ui!.press("Enter");
        await waitUntil(
            async () => (await personaList()).personas.find((p) => p.id === id)?.name,
            (n) => n === 后,
            { label: "名字已存" },
        );
    });

    it("「用于本任务」= 换绑本任务（只改引用，不改任何人物配置）", async () => {
        const 候选名 = uniq("候选人");
        const 候选人 = await addPersona(候选名, "gpt-6-luna");
        const uri = await setupTask("换绑任务");
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await openPanel(uri);

        // 等左列出现「候选人」，真实点击它，再点「用于本任务」（都限定在本任务的面板内）
        await waitUntil(
            async () => ui!.eval<boolean>(`!!document.querySelector('${sel(uri)} [aria-label="人物 ${候选名}"]')`),
            (v) => v === true,
            { label: "左列出现候选人" },
        );
        await clickIn(`${sel(uri)} [aria-label="人物 ${候选名}"]`);
        await waitUntil(
            async () => ui!.eval<string | null>(`document.querySelector('${sel(uri)}')?.getAttribute('data-editing') ?? null`),
            (v) => v === 候选人,
            { label: "右侧切到候选人" },
        );
        await clickIn(`${sel(uri)} [aria-label="用于本任务"]`);

        // 落盘事实：任务 frontmatter 的 persona 改了；且候选人的配置一点没动
        await waitUntil(async () => personaOf(uri), (v) => v === 候选人, { label: "任务已换绑" });
        expect(personaOf(uri)).toBe(候选人);
        expect((await personaList()).personas.find((p) => p.id === 候选人)?.model).toBe("gpt-6-luna");
    });
});
