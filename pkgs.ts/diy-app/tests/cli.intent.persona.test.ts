// tests/cli.intent.persona.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 agent 人物（persona）意图验证 —— 需求定义者
//
// 本文件锁的是这条需求（用户原话的两难）：
//   "不同会话要用不同模型，但又要能统一改；改一个会话不能把另一个也改了。"
// 落法（本层不实现多人对话，只实现"配置挂人物、会话持引用"）：
//   1. 人物是**全局配置实体**：模型/参数/行为指令挂它，改它对所有引用者**下一轮**生效
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
        sh: new ShellTest({
            cwd: join(__dirname, "..", "..", ".."),
            env: { HOME, DIY_HOME: HOME },
        }),
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
    const pid = String(
        ((r.data as Record<string, unknown>)?.data as Record<string, unknown>)?.id ?? "",
    );
    const created = await fx.sh.getJson(`./diy.sh task create ${title} ${pid}`);
    return String(
        ((created.data as Record<string, unknown>)?.data as Record<string, unknown>)?.uri ?? "",
    );
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
    personas: Array<{
        id: string;
        name: string;
        model: string;
        reasoningEffort: string;
        instructions: string;
        taskCount: number;
    }>;
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
        const id = await addPersona(名, "mimo-v2.6-flash", "--instructions '只回要点。'");
        expect(id).toMatch(/^persona\/\d+$/);

        const p = (await personaList()).personas.find((x) => x.id === id)!;
        expect(p.model).toBe("mimo-v2.6-flash");
        expect(p.instructions).toBe("只回要点。");

        // 改模型：按 id 定位，只给 --model，其他字段保持（"未给 = 保持"语义）
        await fx.sh.run(`./diy.sh agent persona set ${id} --model gpt-6-luna`);
        const p2 = (await personaList()).personas.find((x) => x.id === id)!;
        expect(p2.model).toBe("gpt-6-luna");
        expect(p2.instructions).toBe("只回要点。");
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
        const bad = await fx.sh.run(
            `./diy.sh agent persona set --name 报错人物 --model 不存在的模型`,
        );
        expect(bad.stderr + bad.stdout).toMatch(/未知模型/);

        // mimo-v2.6-flash 不支持 xhigh（实测上游 400，见 shared/models.ts）
        const bad2 = await fx.sh.run(
            `./diy.sh agent persona set --name 报错人物 --model mimo-v2.6-flash --reasoningEffort xhigh`,
        );
        expect(bad2.stderr + bad2.stdout).toMatch(/不支持推理强度/);

        // 两次都失败 → 人物不该被建出来（写入侧拦住，不留半成品）
        expect((await personaList()).personas.map((p) => p.name)).not.toContain("报错人物");
    });

    it("setDefault：**跟随缺省**的任务跟着变；**固定绑定**的任务不动", async () => {
        // 需求原文（167 的"统一修改 vs 互不影响"两难）在这里第一次真正落地：
        //   跟随 = 引用（改缺省，跟随者一起变）
        //   固定 = 钉死（改缺省与我无关）
        // 两种状态在落盘上就分得清（有没有 persona 键），不靠任何"是不是自动生成的"猜测。
        const 炮手 = await addPersona(uniq("炮手"), "deepseek-v4.1-flash");

        const 跟随的 = await setupTask("跟随缺省的任务");
        expect(personaOf(跟随的)).toBeUndefined(); // 新建默认：不写键

        const 固定的 = await setupTask("固定绑定的任务");
        await fx.sh.run(`./diy.sh task edit ${固定的} --persona ${炮手}`);

        await fx.sh.run(`./diy.sh agent persona setDefault ${炮手}`);
        expect(personaOf(跟随的)).toBeUndefined(); // 键仍不存在（跟随是"不写键"，不是写死当下这个 id）
        expect(personaOf(固定的)).toBe(炮手); // 固定绑定不受影响

        // 解析侧：两者现在**都**解析成炮手，但原因不同（一个跟随、一个钉死）
        const r1 = await fx.sh.getJson(`./diy.sh task show ${跟随的}`);
        const r2 = await fx.sh.getJson(`./diy.sh task show ${固定的}`);
        expect((r1.data as { data: { persona?: string } }).data.persona).toBeUndefined();
        expect((r2.data as { data: { persona?: string } }).data.persona).toBe(炮手);
    });
});

describe("任务 ↔ 人物绑定（引用存 id）", () => {
    it("新建任务**默认跟随缺省**（不写 persona 键），不是物化当时的缺省 id", async () => {
        // 需求原文：「新建任务默认为跟随缺省」。
        // 落盘判据必须看**文件**（键在不在），不能看接口回显 —— 读侧解析一定会给出一个人物，
        // 那样两种状态看起来一样，而它们的行为（改缺省跟不跟）完全不同。
        const uri = await setupTask("跟随缺省绑定测试");
        expect(personaOf(uri)).toBeUndefined();
        // 且文件里真的没有那一行（不是"值为空串"这种半吊子写法）
        const text = readFileSync(join(fx.HOME, uri, "AGENTS.md"), "utf-8");
        expect(text).not.toMatch(/^persona:/m);
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

    it("固定绑定后 task show 回显 persona id（新格式 persona/<n>）", async () => {
        const id = await addPersona(uniq("回显人物"), "gpt-6-luna");
        const uri = await setupTask("回显测试");
        await fx.sh.run(`./diy.sh task edit ${uri} --persona ${id}`);
        const r = await fx.sh.getJson(`./diy.sh task show ${uri}`);
        expect((r.data as { data: { persona?: string } }).data.persona).toBe(id);
        expect(id).toMatch(/^persona\/\d+$/);
    });

    it("换到不存在的人物被拒（不许写出悬空引用）", async () => {
        const uri = await setupTask("悬空引用测试");
        const r = await fx.sh.run(`./diy.sh task edit ${uri} --persona persona/9999`);
        expect(r.stderr + r.stdout).toMatch(/不存在/);
        expect(personaOf(uri)).not.toBe("persona/9999");
    });

    it("清空人物 = 改为**跟随缺省**（合法动作，不再是「不能为空」的错误）", async () => {
        // 语义变更：从"任务必须有人物"改成"人物永远是解析得出来的，但绑定可以不固定"。
        // `default` 与空串两种写法等价（省得调用方记两套）。
        const id = await addPersona(uniq("被清空的"), "gpt-6-luna");
        const a = await setupTask("清空人物测试A");
        await fx.sh.run(`./diy.sh task edit ${a} --persona ${id}`);
        expect(personaOf(a)).toBe(id);

        await fx.sh.run(`./diy.sh task edit ${a} --persona default`);
        expect(personaOf(a)).toBeUndefined(); // 键被删掉 = 跟随

        const b = await setupTask("清空人物测试B");
        await fx.sh.run(`./diy.sh task edit ${b} --persona ${id}`);
        await fx.sh.run(`./diy.sh task edit ${b} --persona ''`);
        expect(personaOf(b)).toBeUndefined(); // 空串等价
    });

    it("创建任务时可显式指定人物（按 id）", async () => {
        const id = await addPersona(uniq("被指定的"), "gpt-6-luna");
        const repo = `${fx.HOME}/persona-create-${Date.now()}`;
        const r = await fx.sh.getJson(`./diy.sh project create ${repo} --label 指定人物`);
        const pid = String(
            ((r.data as Record<string, unknown>)?.data as Record<string, unknown>)?.id ?? "",
        );
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
        // 要下线一个人物就改它的模型/行为指令（引用者原地跟随）；真需要删除时，
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
        // 显示的是**模型 id**（发给上游的那个值），不是上游的显示名 —— 两者经常对不上
        expect(text).toContain("mimo-v2.6-flash");
    });
});

describe("UI：人物面板（主从视图）—— 选、改、换绑都在这里", () => {
    /**
     * 打开面板：点会话页的人物按钮。
     *
     * **必须按任务 URI 限定选择器**（sel = 本任务那个面板）：每个 tab 各挂一个 LocalChatPage，
     * 同时挂载时面板内部控件（如人物项）会有多份 —— 全局 querySelector 命中的是**别人那个面板**，
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
            async () =>
                ui!.eval<number>(
                    `document.querySelectorAll('[data-testid="persona-drawer"]').length`,
                ),
            (n) => n === 0,
            { label: "旧面板已关" },
        );
        await ui!.clickSelector(`[aria-label="打开 agent 人物面板"]`);
        await waitUntil(
            async () => ui!.eval<boolean>(`!!document.querySelector('${sel(root)}')`),
            (v) => v === true,
            { label: "面板已打开" },
        );
        // 就绪 = 右侧**已经定下来**：要么是属性编辑器（模型按钮可用），要么是跟随缺省说明态。
        // 不能只等模型按钮 —— 本任务跟随缺省时右侧根本没有编辑器，等它必然超时（实测）。
        await waitUntil(
            async () =>
                ui!.eval<boolean>(`(() => {
                    const d = document.querySelector('${sel(root)}');
                    if (!d) return false;
                    if (d.querySelector('[data-testid="persona-follow-pane"]')) return true;
                    const b = d.querySelector('button[aria-pressed]');
                    return !!b && !b.disabled;
                })()`),
            (v) => v === true,
            { label: "右侧已定下来（编辑器或跟随缺省说明态）" },
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
        // 人物列表不再混入任务信息（本任务/引用数移到 info 条与绑定模式语义中）
        expect(text).toContain("缺省");
        // 属性直接可改；模型用**平铺按钮**（aria-pressed 标记选中），不是 select
        expect(text).toContain("模型");
        expect(text).toContain("思考级别");
        expect(text).toContain("行为指令");
        // 右侧默认编辑的是**本任务绑定的人物**（否则用户会在别人身上改全局配置）
        const st = await ui!.eval<{
            editing: string | null;
            bound: string | null;
            selects: number;
        }>(`(() => {
            const d = document.querySelector('${sel(uri)}');
            return {
                editing: d?.getAttribute('data-editing') ?? null,
                bound: d?.getAttribute('data-bound') ?? null,
                selects: d?.querySelectorAll('select').length ?? -1,
            };
        })()`);
        expect(st.editing).toBe(id);
        expect(st.bound).toBe(id);
        // 面板内不应再有 <select>（模型与档位都是平铺按钮；名字/行为指令是输入框）
        expect(st.selects).toBe(0);
        // 且**当前模型的按钮是选中态**（显示与实际一致：选中 mimo 就得亮 mimo）
        const pressed = await ui!.eval<string[]>(
            `Array.from(document.querySelectorAll('${sel(uri)} button[aria-pressed="true"]')).map(b => b.getAttribute('aria-label'))`,
        );
        expect(pressed).toContain("mimo-v2.6-flash");
    });

    it("点平铺按钮改模型 → 落盘 personas.yaml（改完即存）", async () => {
        const id = await addPersona(uniq("改模型人物"), "mimo-v2.6-flash");
        const uri = await setupTask("改模型任务");
        await fx.sh.run(`./diy.sh task edit ${uri} --persona ${id}`);
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await openPanel(uri);

        // 真实点击模型按钮（按钮显示 id；不是派发合成 change —— 这里就是按钮，点得动）
        await clickIn(`${sel(uri)} button[aria-label="gpt-6-luna"]`);
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
        await clickIn(`${sel(uri)} button[aria-label="gpt-6-luna"]`);
        await waitUntil(
            async () => (await levelsOf()).includes("超高"),
            (v) => v === true,
            { label: "档位集跟着换" },
        );
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

    it("新建人物：模型/档位/行为指令都能填（不是只能填名字）", async () => {
        // 曾经的形态：新建态只放开了名字，模型/档位/行为指令一律 disabled —— 于是"建人物"只能填名字，
        // 而 model 在 main 侧是必填（没有模型的人物等于把模型交回硬编码回落），创建实际会失败。
        // 这条锁的是：三块属性在**新建态就可交互**，且填的值随创建一并落盘。
        const 名 = uniq("新建人物");
        const uri = await setupTask("新建人物任务");
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await openPanel(uri);

        await clickIn(`${sel(uri)} [aria-label="新建人物"]`);

        // 1) 新建态三块属性都必须可交互（模型/档位 = button[aria-pressed]，行为指令 = textarea）
        const st = await waitUntil(
            async () =>
                ui!.eval<{
                    count: number;
                    disabled: number;
                    instructionsDisabled: boolean;
                }>(`(() => {
                    const d = document.querySelector('${sel(uri)}');
                    const btns = Array.from(d.querySelectorAll('button[aria-pressed]'));
                    const ta = d.querySelector('textarea[aria-label="人物行为指令"]');
                    return { count: btns.length, disabled: btns.filter(b => b.disabled).length, instructionsDisabled: ta ? ta.disabled : true };
                })()`),
            (v) => v.count > 0,
            { label: "新建态的模型/档位按钮已就绪" },
        );
        expect(st.disabled).toBe(0);
        expect(st.instructionsDisabled).toBe(false);

        // 2) 真填一遍：名字 + 换模型 + 换档位 + 行为指令
        await clickIn(`${sel(uri)} input[aria-label="新人物名字"]`);
        await ui!.type(名);
        await clickIn(`${sel(uri)} button[aria-label="mimo-v2.6-flash"]`);
        await clickIn(`${sel(uri)} button[aria-label="低"]`); // 非默认档（默认是中），证明选的是它
        await clickIn(`${sel(uri)} textarea[aria-label="人物行为指令"]`);
        await ui!.type("每次汇报前先喊「报告」。");
        await clickIn(`${sel(uri)} [aria-label="创建人物"]`);

        // 3) 落盘事实：创建时填的三块属性都写进了 personas.yaml
        const pl = await waitUntil(
            async () => (await personaList()).personas.find((x) => x.name === 名),
            (v) => !!v,
            { label: "新人物已落盘" },
        );
        expect(pl!.model).toBe("mimo-v2.6-flash");
        expect(pl!.reasoningEffort).toBe("low");
        expect(pl!.instructions).toBe("每次汇报前先喊「报告」。");
        // 4) 建完停在**刚建好的人物**上（否则"跟随本任务绑定"的校准会立刻切回别人，看着像没建成）
        expect(
            await ui!.eval<string | null>(
                `document.querySelector('${sel(uri)}')?.getAttribute('data-editing') ?? null`,
            ),
        ).toBe(pl!.id);
        // 5) 新建**不自动换绑**本任务（换绑是双击左列的事，两件事不混）
        expect(
            await ui!.eval<string | null>(
                `document.querySelector('${sel(uri)}')?.getAttribute('data-bound') ?? null`,
            ),
        ).not.toBe(pl!.id);
    });

    it("任务里存的是**旧名字**时，界面显示 main 实际会用的人物（而不是「选择人物」）", async () => {
        // 半迁移状态：personas.yaml 已是新结构（p1），而任务还存着名字「大副」。
        // main 侧按 id 找不到 → 回落缺省（能正常回答），所以界面必须显示**那个回落结果**；
        // 若显示"选择人物/Agent"，就把"配置在、功能好"伪装成"配置丢了" —— 实测就是这个坑。
        const uri = await setupTask("旧名字引用任务");
        // 直接改文件模拟旧数据（RPC 侧只接受有效 id，写不进去）
        const fp = join(fx.HOME, uri, "AGENTS.md");
        // 任务现在默认**跟随缺省**（没有 persona 行），故这里是"插入"而不是"替换"：
        // 模拟的是"任务里存着一个按名字写的旧引用"
        const before = readFileSync(fp, "utf-8");
        expect(before).not.toMatch(/^persona:/m); // 前提：确实没有该键（否则下面的插入没意义）
        writeFileSync(fp, before.replace(/^---\n/m, "---\npersona: 大副\n"), "utf-8");

        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        const text = await waitUntil(
            async () =>
                ui!.eval<string | null>(
                    `document.querySelector('[aria-label="打开 agent 人物面板"]')?.textContent ?? null`,
                ),
            (t) => !!t && !t.includes("选择人物") && !t.includes("加载中"),
            { label: "人物按钮显示回落结果" },
        );
        // 按钮显示的是**按名字认出的那个人物**（比回落缺省更准），且模型用它的真实 id
        // （不写死具体值：隔离数据根用的是内置人物，模型随内置默认走）
        const pl = await personaList();
        const byName = pl.personas.find((p) => p.name === "大副")!;
        expect(text).toContain(byName.name);
        expect(text).toContain(byName.model); // 模型按 id 显示（上游名字与 id 经常对不上）
    });

    it("每条 assistant 回复上方显示人物头像与名字（回复人可见）", async () => {
        const 名 = uniq("发言人");
        const id = await addPersona(名, "mimo-v2.6-flash");
        const uri = await setupTask("回复人展示任务");
        await fx.sh.run(`./diy.sh task edit ${uri} --persona ${id}`);
        // 造一段"已定稿"的会话（不依赖真实 LLM）：turn + assistant 文本块
        const ops = join(fx.HOME, "local", `${sessionKey(uri)}.ops.jsonl`);
        mkdirSync(join(fx.HOME, "local"), { recursive: true });
        const lines = [
            { op: "start", id: "t1", kind: "turn", meta: { model: "mimo-v2.6-flash" } },
            { op: "start", id: "t1_u", kind: "text", parent: "t1", meta: { role: "user" } },
            { op: "delta", id: "t1_u", fields: { content: "你好" } },
            { op: "stop", id: "t1_u" },
            { op: "start", id: "t1_a", kind: "text", parent: "t1", meta: { role: "assistant" } },
            { op: "delta", id: "t1_a", fields: { content: "收到，sir。" } },
            { op: "stop", id: "t1_a" },
            { op: "stop", id: "t1" },
        ];
        writeFileSync(ops, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");

        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        // 回复人 = 本任务绑定的人物（名字 + 模型），显示在消息**上方**
        const byline = await waitUntil(
            async () =>
                ui!.eval<string | null>(`(() => {
                const el = document.querySelector('[data-testid="assistant-byline"]');
                return el ? el.textContent : null;
            })()`),
            (t) => !!t && t.includes("发言人"),
            { label: "出现回复人署名" },
        );
        expect(byline).toContain(名);
        expect(byline).toContain("mimo-v2.6-flash");
    });

    it("署名以**该轮会话记录**为准，不是当前人物配置的投影（改绑定/改缺省不改写历史）", async () => {
        // 任务 196：原先署名读"当前绑定人物/缺省"，于是改一次 personas.yaml 的 default，
        // 全部历史回复的署名一起被改写 —— ops 里明明是 mimo，界面却署名大副。
        // 本用例锁：每轮署名各自显示**该轮** turn.meta.model；无记录的旧轮次标注为推断。
        const 名 = uniq("署名人");
        const id = await addPersona(名, "mimo-v2.6-flash");
        const uri = await setupTask("署名事实任务");
        await fx.sh.run(`./diy.sh task edit ${uri} --persona ${id}`);
        const ops = join(fx.HOME, "local", `${sessionKey(uri)}.ops.jsonl`);
        mkdirSync(join(fx.HOME, "local"), { recursive: true });
        const turn = (tid: string, model: string | undefined, say: string) => [
            {
                op: "start",
                id: tid,
                kind: "turn",
                ...(model === undefined ? {} : { meta: { model } }),
            },
            { op: "start", id: `${tid}_u`, kind: "text", parent: tid, meta: { role: "user" } },
            { op: "delta", id: `${tid}_u`, fields: { content: "你好" } },
            { op: "stop", id: `${tid}_u` },
            { op: "start", id: `${tid}_a`, kind: "text", parent: tid, meta: { role: "assistant" } },
            { op: "delta", id: `${tid}_a`, fields: { content: say } },
            { op: "stop", id: `${tid}_a` },
            { op: "stop", id: tid },
        ];
        const lines = [
            ...turn("t1", "mimo-v2.6-flash", "第一轮。"), // 与本任务绑定人物一致
            ...turn("t2", "deepseek-v4.1-flash", "第二轮。"), // 换绑/改缺省之前的历史轮
            ...turn("t3", undefined, "第三轮。"), // 旧格式：没有 model 记录
        ];
        writeFileSync(ops, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");

        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        const bylines = async () =>
            ui!.eval<string[]>(`(() => {
                return [...document.querySelectorAll('[data-testid="assistant-byline"]')]
                    .map((el) => (el.textContent ?? "") + "|" + (el.getAttribute("data-inferred") ?? ""));
            })()`);
        const got = await waitUntil(bylines, (v) => v.length === 3, {
            label: "三轮署名都渲染出来",
        });

        // ① 该轮 model 与当前人物一致 → 名字 + 该轮模型，且不是推断
        expect(got[0]).toContain(名);
        expect(got[0]).toContain("mimo-v2.6-flash");
        expect(got[0]).not.toContain("|1"); // 无 data-inferred
        // ② 该轮记录的是**另一个**模型 → 显示该轮模型；绝不显示当前人物的名字去顶替
        expect(got[1]).toContain("deepseek-v4.1-flash");
        expect(got[1]).not.toContain("mimo-v2.6-flash");
        expect(got[1]).not.toContain(名);
        // ③ 旧轮次无记录 → 回落当前人物，但**明确标注为推断**（不假装确定）
        expect(got[2]).toContain(名);
        expect(got[2]).toContain("当时人物未知");
        expect(got[2]).toContain("|1");

        // 反向护栏：任务绑定（换绑）不该改写**已发生**轮次的署名 —— 换到另一个模型的人物后重开
        const 别 = await addPersona(uniq("别人"), "gpt-6-luna");
        await fx.sh.run(`./diy.sh task edit ${uri} --persona ${别}`);
        await fx.sh.getJson(`./diy.sh ui tab close active`);
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        const after = await waitUntil(
            bylines,
            (v) => v.length === 3 && v[1]!.includes("deepseek-v4.1-flash"),
            { label: "换绑后署名仍是各轮事实" },
        );
        expect(after[0]).toContain("mimo-v2.6-flash"); // t1 事实不变
        expect(after[1]).toContain("deepseek-v4.1-flash"); // t2 事实不变
        expect(after[1]).not.toContain("gpt-6-luna"); // 新绑定不得污染历史
    });

    it("人物搜索：按字段过滤并高亮；Esc/清除恢复列表；无结果有提示", async () => {
        const 名 = uniq("搜索人物");
        await addPersona(
            名,
            "mimo-v2.6-flash",
            "--reasoningEffort none --instructions '只回要点。'",
        );
        const uri = await setupTask("搜索人物任务");
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await openPanel(uri);
        const root = sel(uri);
        const search = `${root} input[aria-label="搜索人物"]`;
        await waitUntil(
            async () => ui!.eval<boolean>(`!!document.querySelector('${search}')`),
            (v) => v === true,
            { label: "人物搜索框上屏" },
        );
        const personCount = () =>
            ui!.eval<number>(
                `document.querySelectorAll('${root} button[aria-label^="人物 "]').length`,
            );
        await waitUntil(
            async () =>
                ui!.eval<boolean>(`!!document.querySelector('${root} [aria-label="人物 ${名}"]')`),
            (visible) => visible,
            { label: "新建人物已出现在列表" },
        );
        const typeQuery = async (query: string) => {
            const value = await ui!.eval<string>(
                `document.querySelector('${search}')?.value ?? ''`,
            );
            if (value) await ui!.clickSelector(`${root} [aria-label="清除人物搜索"]`);
            await ui!.clickSelector(search);
            await ui!.type(query);
            await waitUntil(
                async () => ui!.eval<string>(`document.querySelector('${search}')?.value ?? ''`),
                (current) => current === query,
                { label: `搜索框输入「${query}」` },
            );
        };

        await typeQuery("只回要点");
        await waitUntil(
            async () => personCount(),
            (count) => count === 1,
            { label: "行为指令过滤人物" },
        );
        const marks = await waitUntil(
            async () =>
                ui!.eval<string[]>(
                    `Array.from(document.querySelectorAll('${root} mark')).map(x => x.textContent ?? '')`,
                ),
            (current) => current.includes("只回要点"),
            { label: "行为指令命中高亮" },
        );
        expect(marks).toContain("只回要点");

        await ui!.clickSelector(`${root} [aria-label="清除人物搜索"]`);
        await waitUntil(
            async () => ui!.eval<string>(`document.querySelector('${search}')?.value ?? ''`),
            (value) => value === "",
            { label: "清除按钮清空搜索" },
        );
        expect(await personCount()).toBeGreaterThan(1);

        await typeQuery("绝不存在的人物搜索词");
        await waitUntil(
            async () => ui!.eval<string>(`document.querySelector('${root}')?.innerText ?? ''`),
            (text) => text.includes("没有匹配") && text.includes("绝不存在的人物搜索词"),
            { label: "无匹配提示上屏" },
        );
        expect(await personCount()).toBe(0);
        await ui!.clickSelector(`${root} [aria-label="清除人物搜索"]`);
        await waitUntil(
            async () => ui!.eval<string>(`document.querySelector('${search}')?.value ?? ''`),
            (value) => value === "",
            { label: "清除无匹配搜索" },
        );
        expect(await personCount()).toBeGreaterThan(1);
    });

    it("面板几何：高约 2/3 视口、左列占 1/3；模型按钮按**价格从低到高**排列", async () => {
        // 需求原文：「整个 drawer 再大一些，2/3 屏高度，左侧的人物列表再宽一些，占 1/3 吧」
        //         +「默认的模型列表改一下，mimo、deepseek、gtp5.6、gpt6，便宜的放前面」。
        // 几何是"看得见的需求"，不给断言就会在后续调样式时悄悄退化（这条量的是真实 rect）。
        const uri = await setupTask("面板几何任务");
        // 固定绑定到一个真实人物：跟随缺省时右侧是说明态，没有模型按钮可量
        const id = await addPersona(uniq("几何人物"), "gpt-6-luna");
        await fx.sh.run(`./diy.sh task edit ${uri} --persona ${id}`);
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await openPanel(uri);

        const geo = await waitUntil(
            async () =>
                ui!.eval<{ hRatio: number; leftRatio: number; models: string[] } | null>(`(() => {
                    const d = document.querySelector('${sel(uri)}');
                    if (!d) return null;
                    const dr = d.getBoundingClientRect();
                    const list = d.querySelector('[data-tip]')?.parentElement;   // 左列滚动容器
                    const lr = list?.getBoundingClientRect();
                    const models = [...d.querySelectorAll('button[aria-pressed]')]
                        .map(b => b.getAttribute('aria-label'))
                        .filter(l => l && l.includes('-'));
                    return {
                        hRatio: dr.height / window.innerHeight,
                        leftRatio: lr ? lr.width / dr.width : -1,
                        models,
                    };
                })()`),
            (v) => !!v && v.models.length > 0,
            { label: "量出面板几何与模型顺序" },
        );
        // 66.666vh（小屏被 42rem 上限兜住，那时比例会偏小 —— 只断言"明显比原来大"）
        expect(geo!.hRatio).toBeGreaterThan(0.5);
        expect(geo!.leftRatio).toBeGreaterThan(0.3);
        expect(geo!.leftRatio).toBeLessThan(0.36);
        // 便宜的在前面（清单顺序即展示顺序；顺序变了这条会红，提醒同步改文案）
        expect(geo!.models.slice(0, 4)).toEqual([
            "mimo-v2.6-flash",
            "deepseek-v4.1-flash",
            "gpt-5.6-luna",
            "gpt-6-luna",
        ]);
    });

    it("「跟随缺省」是左列第一行：单击显示说明态（不给编辑器），双击 = 本任务改为跟随并关窗", async () => {
        // 需求原文：「如何选择缺省 agent 这个选项呢？」—— 落法：它是**绑定模式**而不是人物，
        // 所以放在列表**之上**、用分隔线隔开，并且右侧不给属性编辑器（跟随态下改模型改的是
        // 缺省人物的全局定义，会影响所有跟随者，那种动作必须回"选中那个人物再改"）。
        const id = await addPersona(uniq("固定绑定"), "gpt-6-luna");
        const uri = await setupTask("跟随缺省行任务");
        await fx.sh.run(`./diy.sh task edit ${uri} --persona ${id}`);
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await openPanel(uri);

        // ① 打开时右侧编辑的是**本任务固定的那个人物**（不是跟随行）
        expect(
            await ui!.eval<string | null>(
                `document.querySelector('${sel(uri)}')?.getAttribute('data-editing') ?? null`,
            ),
        ).toBe(id);

        // ② 单击「跟随缺省」→ 右侧切成说明态，且**不出现**模型/档位按钮（没有编辑器）
        await clickIn(`${sel(uri)} [aria-label="跟随缺省人物"]`);
        const pane = await waitUntil(
            async () =>
                ui!.eval<{ text: string; hasEditor: boolean } | null>(`(() => {
                    const d = document.querySelector('${sel(uri)}');
                    const p = d?.querySelector('[data-testid="persona-follow-pane"]');
                    if (!p) return null;
                    return { text: p.innerText, hasEditor: d.querySelectorAll('button[aria-pressed]').length > 0 };
                })()`),
            (v) => !!v,
            { label: "跟随缺省说明态上屏" },
        );
        expect(pane!.text).toContain("跟随缺省人物");
        expect(pane!.text).toContain("下一轮起跟着变");
        expect(pane!.hasEditor).toBe(false); // 跟随态不给编辑器（改的是全局定义，会误伤）

        // ③ 双击同一行 → 本任务改为跟随（删掉 persona 键）+ 关面板
        await ui!.dblclickSelector(`${sel(uri)} [aria-label="跟随缺省人物"]`);
        await waitUntil(
            async () => personaOf(uri),
            (v) => v === undefined,
            { label: "任务已改为跟随缺省" },
        );
        await waitUntil(
            async () => ui!.eval<number>(`document.querySelectorAll('${sel(uri)}').length`),
            (n) => n === 0,
            {
                label: "面板已关闭",
            },
        );

        // ④ 再打开：右侧停在「跟随缺省」行（而不是解析出来的那个人物 —— 那会读成"我固定绑了它"）
        await openPanel(uri);
        expect(
            await ui!.eval<string | null>(
                `document.querySelector('${sel(uri)}')?.getAttribute('data-editing') ?? null`,
            ),
        ).toBe("");
        // 人物列表不再混入任务信息；选中态用特殊背景表达即可
        expect(
            await ui!.eval<boolean>(
                `document.querySelector('${sel(uri)} [aria-label="跟随缺省人物"]')?.className.includes('bg-primary/15') ?? false`,
            ),
        ).toBe(true);
    });

    it("**双击**左列人物 = 换绑本任务 + 关面板（只改引用，不改任何人物配置）", async () => {
        // 需求原文：「不需要用于本任务的按钮，双击就是改了人物并关掉窗口」。
        // 这条同时锁三件事：① 双击真的触发换绑（不是"两次单击"——那不会产生 dblclick）
        // ② 换绑只动本任务的引用 ③ 面板自动关闭（动作闭环，不用再手动关）
        const 候选名 = uniq("候选人");
        const 候选人 = await addPersona(候选名, "gpt-6-luna");
        const uri = await setupTask("换绑任务");
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await openPanel(uri);

        await waitUntil(
            async () =>
                ui!.eval<boolean>(
                    `!!document.querySelector('${sel(uri)} [aria-label="人物 ${候选名}"]')`,
                ),
            (v) => v === true,
            { label: "左列出现候选人" },
        );
        // 提示语必须在，且走 **data-tip**（由 App 的全局面板级 tooltip 渲染 —— 2026-10-03
        // 统一替换掉会被 overflow 容器裁剪的 daisyUI `.tooltip`/`tooltip-content`）
        const tip = await ui!.eval<{ text: string | null; hasTooltipClass: boolean }>(`(() => {
            const el = document.querySelector('${sel(uri)} [aria-label="人物 ${候选名}"]');
            const wrap = el.closest('[data-tip]');
            return {
                text: wrap?.getAttribute('data-tip') ?? null,
                hasTooltipClass: wrap?.classList.contains('tooltip-bottom') ?? false,
            };
        })()`);
        expect(tip.text).toBe("双击选择此人物");
        expect(tip.hasTooltipClass).toBe(false);

        // 滚入视野再真实双击（与 clickIn 同理：滚动区外的元素点不到）
        await ui!.eval<boolean>(`(() => {
            const el = document.querySelector('${sel(uri)} [aria-label="人物 ${候选名}"]');
            if (!el) return false;
            el.scrollIntoView({ block: "center" });
            return true;
        })()`);
        await ui!.dblclickSelector(`${sel(uri)} [aria-label="人物 ${候选名}"]`);

        // 落盘事实：任务 frontmatter 的 persona 改了；且候选人的配置一点没动
        await waitUntil(
            async () => personaOf(uri),
            (v) => v === 候选人,
            { label: "任务已换绑" },
        );
        expect(personaOf(uri)).toBe(候选人);
        expect((await personaList()).personas.find((p) => p.id === 候选人)?.model).toBe(
            "gpt-6-luna",
        );
        // 面板已关闭
        await waitUntil(
            async () => ui!.eval<number>(`document.querySelectorAll('${sel(uri)}').length`),
            (n) => n === 0,
            {
                label: "换绑后面板自动关闭",
            },
        );
    });

    it("人物条目的提示是 viewport fixed 浮层，不被列表的 overflow 裁掉（滚到底的最后一项也完整）", async () => {
        // 2026-10-03 统一：提示改由 App 的全局 tooltip 委托渲染成 **fixed 浮层**（读 data-tip），
        // 不再用 daisyUI 的 `.tooltip`/`.tooltip-content`（那种绝对定位元素贴着 overflow 容器底边会被裁）。
        // 这里把列表滚到底、对最后一项派发 mouseover，量浮层是否完整落在视口内。
        const uri = await setupTask("tooltip裁剪任务");
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await openPanel(uri);

        const r = await waitUntil(
            async () =>
                ui!.eval<{ visible: number; full: number; text: string; inView: boolean } | null>(`(() => {
                    const d = document.querySelector('${sel(uri)}');
                    if (!d) return null;
                    const wraps = [...d.querySelectorAll('[data-tip]')];
                    if (wraps.length === 0) return null;
                    const list = wraps[0].parentElement;
                    list.scrollTop = list.scrollHeight;           // 滚到底：最后一项最贴近容器下沿
                    const last = wraps[wraps.length - 1];
                    last.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                    const tip = [...document.querySelectorAll('div')].find((x) =>
                        (x.className || '').includes('z-[200]'),
                    );
                    if (!tip) return { visible: 0, full: 0, text: '', inView: false };
                    const tr = tip.getBoundingClientRect();
                    const visible = Math.round(Math.min(tr.bottom, window.innerHeight) - Math.max(tr.top, 0));
                    return {
                        visible,
                        full: Math.round(tr.height),
                        text: tip.textContent ?? '',
                        inView: tr.top >= 0 && tr.bottom <= window.innerHeight,
                    };
                })()`),
            (v) => !!v && v.full > 0,
            { label: "量出全局 tooltip 浮层" },
        );
        expect(r!.text).toBe("双击选择此人物");
        expect(r!.full).toBeGreaterThan(0);
        expect(r!.visible).toBe(r!.full); // 完整可见（fixed 浮层不受列表 overflow 裁剪）
        expect(r!.inView).toBe(true);
    });

    it("双击**已在本任务在用**的人物：绑定原样，也照常关面板", async () => {
        const 名 = uniq("已在用");
        const id = await addPersona(名, "gpt-6-luna");
        const uri = await setupTask("重复双击任务");
        await fx.sh.run(`./diy.sh task edit ${uri} --persona ${id}`);
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await openPanel(uri);

        expect(
            await ui!.eval<string | null>(
                `document.querySelector('${sel(uri)}')?.getAttribute('data-bound') ?? null`,
            ),
        ).toBe(id);
        await ui!.dblclickSelector(`${sel(uri)} [aria-label="人物 ${名}"]`);
        await waitUntil(
            async () => ui!.eval<number>(`document.querySelectorAll('${sel(uri)}').length`),
            (n) => n === 0,
            {
                label: "双击在用人物也关面板",
            },
        );
        expect(personaOf(uri)).toBe(id); // 绑定没被动
    });

    it("影响面是**面板内的 info 提示条**（在 view bar 下方），不在按钮旁边", async () => {
        // 需求原文：「'改上面的属性'应该作为 info 提示 bar 存在于视图 bar 的下面……而不是把提示词显示到
        // '设为缺省人物'旁，歧义」。这句话描述的是**整个右侧区域**的后果，挨着动作按钮会被读成
        // "这个按钮会影响 N 个任务" —— 所以位置本身就是契约：必须在头部之下、主从区之上。
        const id = await addPersona(uniq("影响面条"), "gpt-6-luna");
        const uri = await setupTask("影响面任务");
        await fx.sh.run(`./diy.sh task edit ${uri} --persona ${id}`);
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await openPanel(uri);

        const bar = await waitUntil(
            async () =>
                ui!.eval<{ text: string; aboveList: boolean } | null>(`(() => {
                    const d = document.querySelector('${sel(uri)}');
                    const bar = d?.querySelector('[data-testid="persona-impact-bar"]');
                    if (!bar) return null;
                    const list = d.querySelector('[data-tip]')?.parentElement;
                    return {
                        text: bar.innerText,
                        // 在列表**之上**（否则就是"贴着底栏按钮"那个歧义形态）
                        aboveList: !!list && bar.getBoundingClientRect().bottom <= list.getBoundingClientRect().top + 1,
                    };
                })()`),
            (v) => !!v,
            { label: "info 提示条上屏" },
        );
        expect(bar!.text).toContain("改右侧属性 = 影响 1 个任务（下一轮生效）");
        expect(bar!.aboveList).toBe(true);

        // 新建态不显示（那时还没有"会影响谁"可言，显示了像在说别人的事）
        await clickIn(`${sel(uri)} [aria-label="新建人物"]`);
        await waitUntil(
            async () =>
                ui!.eval<boolean>(
                    `!document.querySelector('${sel(uri)} [data-testid="persona-impact-bar"]')`,
                ),
            (v) => v === true,
            { label: "新建态不显示影响面条" },
        );
    });

    it("「缺省」按钮挂在**每个条目右侧**（hover 显形），与「缺省」标签同色系", async () => {
        // 需求原文：「设为缺省人物按钮直接放到每个选项人物的右侧对齐……hover 时出现」
        //         +「缺省的 tag 颜色和按钮颜色要一致或一个系列，更浅些」。
        // 三件事一起锁：① 挂在条目内（不是页脚那个"作用于当前编辑人物"的位置）
        // ② 默认隐藏、hover 条目才显形 ③ 按钮 btn-secondary、标签 badge-secondary badge-soft（同色系更浅）
        const 名 = uniq("缺省按钮");
        const id = await addPersona(名, "gpt-6-luna");
        const uri = await setupTask("缺省按钮任务");
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await openPanel(uri);

        const st = await waitUntil(
            async () =>
                ui!.eval<{
                    inRow: boolean;
                    btnCls: string | null;
                    hidden: string;
                    badgeCls: string | null;
                    footerGone: boolean;
                } | null>(`(() => {
                    const d = document.querySelector('${sel(uri)}');
                    const item = d?.querySelector('[aria-label="人物 ${名}"]');
                    const btn = item?.parentElement?.querySelector('[aria-label="设人物 ${名} 为缺省"]');
                    if (!item || !btn) return null;
                    const badge = [...d.querySelectorAll('.badge')].find(b => b.textContent.trim() === '缺省');
                    return {
                        inRow: !!item.parentElement.contains(btn),
                        btnCls: btn.className,
                        hidden: getComputedStyle(btn).opacity,
                        badgeCls: badge?.className ?? null,
                        footerGone: !d.querySelector('[aria-label="设为缺省人物"]'),
                    };
                })()`),
            (v) => !!v,
            { label: "条目右侧的缺省按钮已渲染" },
        );
        expect(st!.inRow).toBe(true);
        expect(st!.btnCls).toContain("btn-secondary");
        expect(st!.btnCls).not.toContain("btn-ghost");
        expect(st!.hidden).toBe("0"); // 默认不显示，hover 才显形
        expect(st!.footerGone).toBe(true); // 页脚那个已撤掉（不留两个入口）
        // 标签与按钮同一色系（secondary），标签取 soft 变体更浅
        expect(st!.badgeCls).toContain("badge-secondary");
        expect(st!.badgeCls).toContain("badge-soft");
    });

    it("面板里不再有「用于本任务」按钮（换绑只有双击这一条路）", async () => {
        const uri = await setupTask("无按钮任务");
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await openPanel(uri);
        const labels = await ui!.eval<string[]>(`(() => {
            const d = document.querySelector('${sel(uri)}');
            return Array.from(d.querySelectorAll('button')).map(b => b.getAttribute('aria-label') ?? '');
        })()`);
        expect(labels.filter((l) => l.includes("用于本任务"))).toEqual([]);
    });
});
