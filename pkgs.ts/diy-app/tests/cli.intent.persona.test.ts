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
    ui = await makeUiDriver(electron.cdpUrl, a11yTree);
});

afterAll(async () => {
    ui?.close();
    await fx?.electron?.stop();
});

/**
 * 建一个项目 + 一个任务，返回任务 URI（每次新项目：任务号从 1 起，避免猜 id）。
 *
 * 不在用例间删项目（与既有 UI 意图测试一致）：实测删掉"当前打开的 tab 所指的项目"后，
 * 后续 `ui tab open` 会失效（renderer 停在已删任务的 tab 上，新的 open 不见效）。
 * 隔离靠**每次新项目 + 人物名带用例标识**，不靠删除 —— 这样也不必和 tab 系统较劲。
 */
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

describe("UI：人物面板（主从视图）—— 选、改、换绑都在这里", () => {
    /**
     * 打开面板：点会话页的人物按钮（真实命中测试的点击，不是 el.click()）。
     * 就绪判据用**面板独有的元素**（"用于本任务"按钮）——不能拿 "agent 人物" 这类文字：
     * 会话页按钮自己的 aria-label 里就有这几个字，会导致"还没打开就判成功"。
     */
    async function openPanel(): Promise<void> {
        await ui!.clickSelector('[aria-label="打开 agent 人物面板"]');
        await waitUntil(
            async () => ui!.eval<boolean>(`!!document.querySelector('[aria-label="用于本任务"]')`),
            (v) => v === true,
            { label: "面板已打开（出现面板内元素）" },
        );
        // 模型清单是异步拉的：未就绪时模型下拉是 disabled，改值不会触发 onChange
        await waitUntil(
            async () => ui!.eval<boolean>(`(() => {
                const s = Array.from(document.querySelectorAll('select')).find(s => s.options.length > 1);
                return !!s && !s.disabled;
            })()`),
            (v) => v === true,
            { label: "模型下拉可用" },
        );
    }

    it("面板是主从视图：左列人物（带引用数）、右侧可直接改的属性", async () => {
        await fx.sh.run(`./diy.sh agent persona set 面板人物 --model mimo-v2.6-flash --desc 面板测试用`);
        const uri = await setupTask("面板测试任务");
        await fx.sh.run(`./diy.sh task edit ${uri} --persona 面板人物`);
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);

        await openPanel();
        const text = await a11yText();
        // 左：人物列表 + 引用面（改之前先看见会影响谁）
        expect(text).toContain("面板人物");
        expect(text).toContain("本任务");
        expect(text).toMatch(/\d+ 个任务在用|暂无任务在用/);
        // 右：四项属性都是**直接可改**的控件（不是只读展示）
        expect(text).toContain("模型");
        expect(text).toContain("思考级别");
        expect(text).toContain("口气");
        // 动作按钮存在即可 —— 文案会随状态变（未绑定时「用于本任务」、已绑定时「本任务正在用」），
        // 所以按 aria-label 判定（a11y 的 text 取的是可见文案，会随状态漂移）
        expect(await ui!.eval<boolean>(`!!document.querySelector('[aria-label="用于本任务"]')`)).toBe(true);
        // 右侧默认编辑的必须是**本任务绑定的人物**，且下拉显示的值要与它一致。
        // 后半句不是废话：options 异步到达时 Solid 的 value 属性会失效（浏览器回落第一个选项），
        // 表现为"选中 mimo 却显示 GPT 5.6 Luna" —— 看着一个模型、改另一个人物的配置。
        const drawer = await ui!.eval<{ editing: string | null; bound: string | null; sels: string }>(`(() => {
            const d = document.querySelector('[data-testid="persona-drawer"]');
            return {
                editing: d?.getAttribute('data-editing') ?? null,
                bound: d?.getAttribute('data-bound') ?? null,
                sels: Array.from(document.querySelectorAll('select')).map(s => s.value).join(','),
            };
        })()`);
        expect(drawer.editing).toBe("面板人物");
        expect(drawer.bound).toBe("面板人物");
        expect(drawer.sels).toContain("mimo-v2.6-flash");
    });

    it("在面板里改模型 → 落盘 personas.yaml（改完即存）", async () => {
        await fx.sh.run(`./diy.sh agent persona set 改模型人物 --model mimo-v2.6-flash`);
        const uri = await setupTask("改模型任务");
        await fx.sh.run(`./diy.sh task edit ${uri} --persona 改模型人物`);
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await openPanel();
        // 等右侧编辑的是目标人物（按模型值判断：面板默认选中本任务绑定的人物）
        await waitUntil(
            async () => ui!.eval<string>(`(() => {
                const sel = Array.from(document.querySelectorAll('select')).find(s => Array.from(s.options).some(o => o.value === 'mimo-v2.6-flash'));
                return sel ? sel.value : '';
            })()`),
            (v) => v === "mimo-v2.6-flash",
            { label: "右侧编辑的是目标人物" },
        );

        // 真实交互：选中「模型」select 并改值 + 派发 change（与 ui.task-list 改 priority 同一手法 ——
        // 原生 select 的弹层由 OS 绘制，CDP 点不进选项，但 change 事件走的是页面自己的 handler）
        const ok = await ui!.eval<boolean>(`(() => {
            const sels = Array.from(document.querySelectorAll('select'));
            const sel = sels.find(s => Array.from(s.options).some(o => o.value === 'gpt-6-luna'));
            if (!sel) return false;
            sel.value = 'gpt-6-luna';
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        })()`);
        expect(ok, "应找到模型下拉").toBe(true);

        // 落盘事实（不是只看 DOM）：personas.yaml 里该人物的模型真的变了
        const changed = await waitUntil(
            async () => {
                const r = await fx.sh.getJson(`./diy.sh agent persona list`);
                const d = r.data as { personas: Array<{ name: string; model: string }> };
                return d.personas.find((p) => p.name === "改模型人物")?.model;
            },
            (m) => m === "gpt-6-luna",
            { label: "personas.yaml 里的模型已改" },
        );
        expect(changed).toBe("gpt-6-luna");
    });

    it("「用于本任务」= 换绑本任务（只改引用，不改任何人物配置）", async () => {
        await fx.sh.run(`./diy.sh agent persona set 候选人 --model gpt-6-luna`);
        const uri = await setupTask("换绑任务");
        await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
        await openPanel();

        // 等左列加载出「候选人」（清单是异步拉的），再真实点击选中它
        await waitUntil(
            async () => ui!.eval<boolean>(`!!document.querySelector('[aria-label="人物 候选人"]')`),
            (v) => v === true,
            { label: "左列出现候选人" },
        );
        // 在左列点中「候选人」，再点「用于本任务」（都是真实点击）
        await ui!.clickSelector('[aria-label="人物 候选人"]');
        await waitUntil(
            async () => ui!.eval<string>(`(() => {
                const s = Array.from(document.querySelectorAll('select')).find(s => Array.from(s.options).some(o => o.value === 'gpt-6-luna'));
                return s ? s.value : '';
            })()`),
            (v) => v === "gpt-6-luna",
            { label: "右侧切到候选人" },
        );
        await ui!.clickSelector('[aria-label="用于本任务"]');

        // 落盘事实：任务 frontmatter 的 persona 改了；且候选人的配置一点没动
        await waitUntil(
            async () => personaOf(uri),
            (v) => v === "候选人",
            { label: "任务已换绑" },
        );
        expect(personaOf(uri)).toBe("候选人");
        const r = await fx.sh.getJson(`./diy.sh agent persona list`);
        const d = r.data as { personas: Array<{ name: string; model: string }> };
        expect(d.personas.find((p) => p.name === "候选人")?.model).toBe("gpt-6-luna");
    });
});

describe("人物暂不提供删除（有意的能力缺位）", () => {
    it("没有 remove 子命令 —— 改人物而非删人物", async () => {
        // 删掉一个人物会让所有引用它的任务**静默回落**到缺省人物（换模型不打招呼）。
        // 要下线一个人物就改它的模型/口气（引用者原地跟随）；真需要删除时，
        // 得先设计"引用迁移"（把这 N 个任务改绑到别处）一起做。
        const r = await fx.sh.run(`./diy.sh agent persona remove 大副`);
        expect(r.code).not.toBe(0);
    });

    it("list 回传引用计数（改人物前先看见影响面）", async () => {
        await fx.sh.run(`./diy.sh agent persona set 统计人物167 --model gpt-6-luna`);
        const uri = await setupTask("被统计的任务");
        await fx.sh.run(`./diy.sh task edit ${uri} --persona 统计人物167`);

        const r = await fx.sh.getJson(`./diy.sh agent persona list`);
        const d = r.data as { personas: Array<{ name: string; taskCount: number }> };
        expect(d.personas.find((p) => p.name === "统计人物167")?.taskCount).toBe(1);
        // 没人在用的缺省人物（本用例里已被改绑走）计数为 0，而不是缺失
        expect(typeof d.personas.find((p) => p.name === "大副")?.taskCount).toBe("number");
    });
});
