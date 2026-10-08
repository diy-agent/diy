// tests/cli.intent.agent-local.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 agent.local —— 本地自定义 agent（ai-sdk 块协议）意图验证
//
// 块协议 G 的需求定义：
//   1. Op 流即 JSONL：start/delta/patch/stop 四类行，wire = 存储 = 渲染输入
//   2. history 重放返回完整 Op 日志；clear 清日志；cancel 无在途返回 false
//   3. 真实对话（zen/go + OPENCODE_ZEN_API_KEY）：turn/user/text 块 + usage
//   4. 工具链路：tool 块带 args/output/status（toolCallId = 块 id）
//
// 无网络部分恒跑；**真实 LLM 用例默认不跑**（需 DIY_LLM_E2E=1 + key）：
//   · 依赖外部模型 → 放默认套件里必然非确定（实测：模型偶尔不回 text delta，断言假红）
//   · 一次全量会打真实请求、耗时 2~3 分钟
// 联调：DIY_LLM_E2E=1 npx vitest run tests/cli.intent.agent-local.test.ts
//
// 真发用例**指定 `mimo-v2.6-flash`**（全表最便宜的带工具能力模型，见仓库根 AGENTS.md
// 「本地 agent 测试用什么模型」）：这些用例只验协议链路，与模型强弱无关，
// 不显式指定模型也不必担心浪费（缺省已是最便宜的 mimo-v2.6-flash，用户 2026-10-06 改的），
// 但显式写出来更稳：缺省值将来若变，这些用例不会悄悄换成贵模型。
// exceptions：responses 面那条**必须**用 gpt-5.6-luna —— 它测的就是"responses-only
// 模型不能打到 chat 面"，换模型就测不到那个 api 面。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ShellTest, Session } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";

// 真实 LLM 用例：默认关闭（见文件头）。缺 key 时即使开了开关也跳过。
const RUN_LLM = process.env.DIY_LLM_E2E === "1" && !!process.env.OPENCODE_ZEN_API_KEY;

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
        sh: new ShellTest({
            cwd: join(__dirname, "..", "..", ".."),
            env: { HOME, DIY_HOME: HOME },
        }),
    };
});

afterAll(async () => {
    await fx?.electron?.stop();
});

async function setup(taskTitle: string): Promise<string> {
    const repo = `${fx.HOME}/local-${Date.now()}`;
    const r = await fx.sh.getJson(`./diy.sh project create ${repo} --label 本地实验`);
    const pid = String(
        ((r.data as Record<string, unknown>)?.data as Record<string, unknown>)?.id ?? "",
    );
    await fx.sh.run(`./diy.sh task create ${taskTitle} ${pid}`);
    return `projects/${pid}/tasks/1`;
}

/** keyOf 文件名带 sha 后缀（防 a/b 与 a:b 碰撞）；find（允许缺）/path（必存在）/has 分离 */
function findOpsFile(taskUri: string): string | undefined {
    const dir = join(fx.HOME, "local");
    const prefix = taskUri.replace(/[^\w.-]+/g, "_");
    return existsSync(dir)
        ? readdirSync(dir).find((f) => f.startsWith(`${prefix}-`) && f.endsWith(".ops.jsonl"))
        : undefined;
}
function opsPath(taskUri: string): string {
    const hit = findOpsFile(taskUri);
    if (!hit) throw new Error(`未找到 ops 日志：${taskUri}`);
    return join(fx.HOME, "local", hit!);
}
function hasOpsFile(taskUri: string): boolean {
    return findOpsFile(taskUri) !== undefined;
}

/**
 * 会话文件 basename 的完整键（可读前缀 + sha256 前 12 位）。
 * ⚠️ 这里是 keyOf 的**测试副本**：本套件通过 CLI 子进程验证（不 import 重依赖的 local-agent），
 * 拿不到那个实现。复制的唯一目的是「种一份历史对话」；一旦算法变了，文件找不到会**响亮报错**，
 * 不会静默漏测 —— 与产品路径共用同一套语义仍由 findOpsFile 的 readdir 断言兜底。
 */
function localKey(taskUri: string): string {
    const readable = taskUri.replace(/[^\w.-]+/g, "_").slice(0, 64);
    const sum = createHash("sha256").update(taskUri).digest("hex").slice(0, 12);
    return `${readable}-${sum}`;
}

/** 造一轮的 op（user 文本 + 一个 bash 工具；outText 缺省给 n 行） */
function turnOps(turnId: string, userText: string, outText: string): Array<Record<string, unknown>> {
    const t = turnId;
    return [
        { op: "start", id: t, kind: "turn" },
        { op: "start", id: `${t}_u`, kind: "text", parent: t, meta: { role: "user" } },
        { op: "delta", id: `${t}_u`, fields: { content: userText } },
        { op: "stop", id: `${t}_u` },
        { op: "start", id: `${t}_r`, kind: "tool", parent: t, meta: { tool: "bash" } },
        { op: "patch", id: `${t}_r`, fields: { args: { command: "rg x" }, status: "running", title: "rg x" } },
        { op: "delta", id: `${t}_r`, fields: { output: outText } },
        { op: "patch", id: `${t}_r`, fields: { status: "done" } },
        { op: "stop", id: `${t}_r` },
        { op: "stop", id: t },
    ];
}

/**
 * 写**配置真源** `auto-compact.yaml` 的 policy（配置 / 历史分离后，投递口径 = **当前配置**）。
 * 【用户 2026-10-07】改预算本轮即生效 —— 不再靠"写一次压缩事件"来生效。
 *
 * ⚠️ 形状必须是**决策树**（`{ mode:"budget", modeData:{ budgetBytes, toolResult }, summary }`）：
 * `AutoCompactConfigSchema` 是严格解析，扁平旧形状（顶层 `budgetBytes`）会被读侧拒 → 回默认配置。
 */
function setConfigPolicy(budgetBytes: number, toolResult: Record<string, unknown> = { render: "asis" }): void {
    const cfg = {
        mode: "notify",
        triggers: { systemContextChanged: true, cacheExpired: true, contextWindowOver: 0.8 },
        policy: { mode: "budget", modeData: { budgetBytes, toolResult }, summary: false },
    };
    writeFileSync(join(fx.HOME, "auto-compact.yaml"), JSON.stringify(cfg), "utf-8");
}

/** 种一份 ops 日志（模拟「已有历史对话」，供无网络的压缩用例验证） */
function seedOps(taskUri: string, ops: Array<Record<string, unknown>>): string {
    const dir = join(fx.HOME, "local");
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, `${localKey(taskUri)}.ops.jsonl`);
    writeFileSync(fp, ops.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf-8");
    return fp;
}

// ─── 插话（steer）：对话中插嘴 ───────────────────────
//
// 入队走 `chat --mode`（唯一的提交入口）：给出 --mode 只入队、不启动轮次；不带则开一轮。
// 必须持久化（进程重启/切 Electron/serve 模式后队列仍在）—— 插话是"已提交但模型还没看见的
// 用户输入"，丢了就是用户白打。存储与聊天草稿同文件（任务目录 .diy/drafts.yaml 的 steers）。

/** 取 CLI JSON 的 data 字段（getJson 返回 Record<string, unknown>，这里按用例收窄） */
async function cliData<T>(cmd: string): Promise<T> {
  const r = await fx.sh.getJson(cmd);
  return r.data as T;
}

/** 入队一条插话：走 chat --mode，命令退出即已落盘（队列路径不产 op） */
async function enqueueSteer(uri: string, mode: string, text: string): Promise<void> {
  await fx.sh.run(`./diy.sh agent local chat ${uri} ${JSON.stringify(text)} --mode ${mode}`);
}

interface SteerRow {
  id: string;
  mode: string;
  text: string;
}

describe("agent.local — 插话 steer（无网络）", () => {
  it("chat --mode 入队 → list 可见 → cancel 取消", async () => {
    const uri = await setup("插话任务");
    await enqueueSteer(uri, "next-step", "插到下一步");
    const list = await cliData<SteerRow[]>(`./diy.sh agent local steer list ${uri}`);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ mode: "next-step", text: "插到下一步" });

    const after = await cliData<SteerRow[]>(`./diy.sh agent local steer cancel ${uri} ${list[0]!.id}`);
    expect(after).toEqual([]);
    await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
  });

  it("id 形如 steer/N（实体/序号）：CLI 里能直接手敲，不必复制粘贴随机串", async () => {
    const uri = await setup("id 格式");
    await enqueueSteer(uri, "next-turn", "第一条");
    await enqueueSteer(uri, "next-turn", "第二条");
    const list = await cliData<SteerRow[]>(`./diy.sh agent local steer list ${uri}`);
    expect(list.map((i) => i.id)).toEqual(["steer/1", "steer/2"]);
    // 用这个 id 取消（id 会进 shell，含 "/" 也没问题：它只做字符串匹配，不当路径解析）
    const after = await cliData<SteerRow[]>(`./diy.sh agent local steer cancel ${uri} steer/1`);
    expect(after.map((i) => i.id)).toEqual(["steer/2"]);
    await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
  });

  it("两种模式各自记住（next-step / next-turn 并存，FIFO 顺序即提交顺序）", async () => {
    const uri = await setup("两种插话");
    await enqueueSteer(uri, "next-step", "第一步插话");
    await enqueueSteer(uri, "next-turn", "下一轮插话");
    const list = await cliData<SteerRow[]>(`./diy.sh agent local steer list ${uri}`);
    expect(list.map((i) => [i.mode, i.text])).toEqual([
      ["next-step", "第一步插话"],
      ["next-turn", "下一轮插话"],
    ]);
    await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
  });

  it("取消不存在的 id 幂等（重复点 ✕ 不该报错）", async () => {
    const uri = await setup("幂等取消");
    const r = await cliData<SteerRow[]>(`./diy.sh agent local steer cancel ${uri} nope`);
    expect(r).toEqual([]);
    await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
  });

  it("空内容被拒（不落空插话：投进去只会污染提示词）", async () => {
    const uri = await setup("空插话");
    const r = await fx.sh.run(`./diy.sh agent local chat ${uri} "   " --mode next-step`);
    expect(r.code).not.toBe(0);
    const list = await cliData<SteerRow[]>(`./diy.sh agent local steer list ${uri}`);
    expect(list).toEqual([]);
    await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
  });

  it("非法 mode 被契约拒绝（不许静默放行）", async () => {
    const uri = await setup("非法模式");
    const r = await fx.sh.run(`./diy.sh agent local chat ${uri} "内容" --mode next`);
    expect(r.code).not.toBe(0);
    await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
  });

  it("落盘在任务目录 .diy/drafts.yaml（与聊天草稿同文件，可被 CLI 直接观察）", async () => {
    const uri = await setup("落盘检查");
    await enqueueSteer(uri, "next-turn", "持久化的话");
    const fp = join(fx.HOME, uri, ".diy", "drafts.yaml");
    expect(existsSync(fp)).toBe(true);
    const raw = readFileSync(fp, "utf-8");
    expect(raw).toContain("steers");
    expect(raw).toContain("持久化的话");
    // 取消后队列空、字段也空 → 文件删除（不留空壳）
    const list = await cliData<SteerRow[]>(`./diy.sh agent local steer list ${uri}`);
    await fx.sh.getJson(`./diy.sh agent local steer cancel ${uri} ${list[0]!.id}`);
    expect(existsSync(fp)).toBe(false);
    await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
  });

  it("与聊天草稿同文件互不干扰（清草稿不动插话）", async () => {
    const uri = await setup("共存检查");
    await enqueueSteer(uri, "next-step", "排队的插话");
    await fx.sh.getJson(`./diy.sh task drafts set ${uri} --agent_input "打到一半的草稿"`);
    // 清空草稿字段：插话队列必须还在（"清空输入框" ≠ "放弃排队中的插话"）
    await fx.sh.getJson(`./diy.sh task drafts clear ${uri}`);
    const list = await cliData<SteerRow[]>(`./diy.sh agent local steer list ${uri}`);
    expect(list.map((i) => i.text)).toEqual(["排队的插话"]);
    await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
  });
});

describe("agent.local — 控制面（无网络）", () => {
    it("models 列出 zen/go 子集", async () => {
        const r = await fx.sh.getJson(`./diy.sh agent local models`);
        const list = r.data as Array<{ id: string }>;
        expect(list.some((m) => m.id === "mimo-v2.6-flash")).toBe(true);
    });

    it("history 空会话 = 空数组；cancel 无在途 = false", async () => {
        const uri = await setup("控制面任务");
        const h = await fx.sh.getJson(`./diy.sh agent local history ${uri}`);
        expect(h.data).toEqual([]);
        const c = await fx.sh.getJson(`./diy.sh agent local cancel ${uri}`);
        expect(c.data).toEqual({ cancelled: false });
        await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
    });

    // 任务 194：UI 判"这一轮是否还活着"必须问 main（agent.local.running），
    // 而不是靠自己的私有 running —— 别人（CLI/另一窗口）正在跑的轮次它看不见。
    it("running 给出运行态真值：无在途时是空表（结构即契约）", async () => {
        const r = await fx.sh.getJson(`./diy.sh agent local running`);
        expect(r.data).toEqual({ active: [] });
    });

    it("clear 幂等删除（不存在也可清）", async () => {
        const uri = await setup("清理任务");
        const c = await fx.sh.getJson(`./diy.sh agent local clear ${uri}`);
        expect(c.data).toEqual({ cleared: true });
        expect(hasOpsFile(uri)).toBe(false);
        await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
    });
});

describe("agent.local — 真实对话（zen/go）", () => {
    it.skipIf(!RUN_LLM)(
        "纯文本轮：Op 流四动词齐全 + usage + 落盘重放一致",
        async () => {
            const uri = await setup("纯文本任务");
            const r = await fx.sh.run(
                `./diy.sh agent local chat ${uri} "只用两个字回答：你好" --model mimo-v2.6-flash`,
                180_000,
            );
            if (r.code !== 0) throw new Error(`cli exit=${r.code}\n${r.stderr}`);
            const lines = r.stdout.split("\n").filter((l) => l.trim().startsWith('{"op"'));
            expect(lines.length).toBeGreaterThan(3);
            const ops = lines.map((l) => JSON.parse(l));
            // 结构断言：turn 起、user 块在、text 块有内容、turn 收、usage 回填
            expect(ops[0]).toMatchObject({ op: "start", kind: "turn" });
            expect(
                ops.some((o) => o.op === "start" && o.kind === "text" && o.meta?.role === "user"),
            ).toBe(true);
            expect(
                ops.some(
                    (o) =>
                        o.op === "delta" &&
                        typeof o.fields?.content === "string" &&
                        o.fields.content,
                ),
            ).toBe(true);
            expect(ops.at(-1)).toMatchObject({ op: "stop" });
            expect(ops.some((o) => o.op === "patch" && o.fields?.usage)).toBe(true);
            // 存储 = 传输：jsonl 与流一致
            const fileOps = readFileSync(opsPath(uri), "utf-8")
                .split("\n")
                .filter(Boolean)
                .map((l) => JSON.parse(l));
            expect(fileOps.length).toBe(ops.length);
            const h = await fx.sh.getJson(`./diy.sh agent local history ${uri}`);
            expect((h.data as unknown[]).length).toBe(ops.length);
            // LLM 侧日志含 user 与 assistant
            const llm = readFileSync(opsPath(uri).replace(".ops.", ".llm."), "utf-8")
                .split("\n")
                .filter(Boolean)
                .map((l) => JSON.parse(l));
            expect(llm.some((m) => m.role === "assistant" || m.role === "tool")).toBe(true);
            await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
        },
        200_000,
    );

    it.skipIf(!RUN_LLM)(
        "responses 面模型（gpt-5.6-luna）可用：不再 503，Op 流与 usage 正常",
        async () => {
            // 需求（projects/4/tasks/145）：responses-only 模型打到 /chat/completions 一律 503
            // 「Endpoint is unavailable」；按 api 面分派后必须能正常出文本。
            const uri = await setup("responses 面任务");
            const r = await fx.sh.run(
                `./diy.sh agent local chat ${uri} "只用两个字回答：你好" --model gpt-5.6-luna`,
                180_000,
            );
            if (r.code !== 0) throw new Error(`cli exit=${r.code}\n${r.stderr}`);
            const ops = r.stdout
                .split("\n")
                .filter((l) => l.trim().startsWith('{"op"'))
                .map((l) => JSON.parse(l));
            // 失败形态是 turn 里挂一个 error 块（source=llm）—— 它就是本 bug 的指纹
            expect(ops.some((o) => o.op === "start" && o.kind === "error")).toBe(false);
            expect(
                ops.some(
                    (o) => o.op === "delta" && typeof o.fields?.content === "string" && o.fields.content,
                ),
            ).toBe(true);
            expect(ops.some((o) => o.op === "patch" && o.fields?.usage)).toBe(true);
            await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
        },
        200_000,
    );

    it.skipIf(!RUN_LLM)(
        "工具轮：tool 块 args/output/status 完整（toolCallId=块 id）",
        async () => {
            const uri = await setup("工具任务");
            const r = await fx.sh.run(
                `./diy.sh agent local chat ${uri} "用 bash 执行 echo hello-local，然后用一句话告诉我输出" --model mimo-v2.6-flash`,
                240_000,
            );
            if (r.code !== 0) throw new Error(`cli exit=${r.code}\n${r.stderr}`);
            const ops = r.stdout
                .split("\n")
                .filter((l) => l.trim().startsWith('{"op"'))
                .map((l) => JSON.parse(l));
            const toolStart = ops.find((o) => o.op === "start" && o.kind === "tool");
            expect(toolStart, "应有 tool 块").toBeTruthy();
            const id = toolStart.id;
            expect(
                ops.some(
                    (o) =>
                        o.op === "patch" &&
                        o.id === id &&
                        o.fields?.status === "running" &&
                        o.fields?.args?.command?.includes?.("echo hello-local"),
                ),
            ).toBe(true);
            expect(
                ops.some(
                    (o) =>
                        o.op === "delta" &&
                        o.id === id &&
                        String(o.fields?.output).includes("hello-local"),
                ),
            ).toBe(true);
            expect(
                ops.some((o) => o.op === "patch" && o.id === id && o.fields?.status === "done"),
            ).toBe(true);
            // llm 日志含工具链路（assistant tool-call + tool result）
            const llm = readFileSync(opsPath(uri).replace(".ops.", ".llm."), "utf-8")
                .split("\n")
                .filter(Boolean)
                .map((l) => JSON.parse(l));
            const flat = JSON.stringify(llm);
            expect(flat.includes("tool-call") || flat.includes("tool-result")).toBe(true);
            await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
        },
        260_000,
    );

    // 任务 194 的根因通路：renderer 过去无从知道"别人（CLI/另一窗口）正在这个任务上跑"
    // —— main 内存里明明有 activeTurns，却没有查询口。这条用例钉住这个口子：
    // 一轮真在跑时 running 必须报出来，收尾后必须消失（否则 UI 会一直显示"停止"或误报中断）。
    it.skipIf(!RUN_LLM)(
        "CLI 起一轮期间 running 报该任务活跃；收尾后消失（UI 真值来源）",
        async () => {
            const uri = await setup("运行态任务");
            // 独立会话跑 chat（不 await）：模拟"另一端在跑"，主测试进程继续查真值
            const chat = new Session({
                cwd: join(__dirname, "..", "..", ".."),
                env: { HOME: fx.HOME, DIY_HOME: fx.HOME },
            });
            const running = chat.run(
                `./diy.sh agent local chat ${uri} "用 bash 执行 sleep 20，然后一句话说明结果"`,
                240_000,
            );
            try {
                const activeUris = async () => {
                    const r = await fx.sh.getJson(`./diy.sh agent local running`);
                    return ((r.data as { active?: Array<{ taskUri: string }> })?.active ?? []).map((t) => t.taskUri);
                };
                // 轮询（不给固定 sleep：上游首 token 往返时长不定）
                let seen = false;
                for (let i = 0; i < 40 && !seen; i++) {
                    seen = (await activeUris()).includes(uri);
                    if (!seen) await new Promise((r) => setTimeout(r, 500));
                }
                expect(seen, `running 应报 ${uri} 活跃`).toBe(true);

                // 停止入口走的就是这个 RPC：对别人发起的轮次同样有效
                const c = await fx.sh.getJson(`./diy.sh agent local cancel ${uri}`);
                expect(c.data).toEqual({ cancelled: true });
                await running;

                // 收尾后必须不再活跃（UI 据此把按钮收回发送态）
                expect(await activeUris()).not.toContain(uri);
            } finally {
                await fx.sh.run(`./diy.sh agent local cancel ${uri}`).catch(() => undefined);
                chat.close();
                await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
            }
        },
        260_000,
    );
});

// ─── 压缩 compact（无网络，种历史对话）────────────────────────
//
// 目标式预算（##271）后，压缩只有**一个**旋钮 `budgetBytes`（0 = 清零）。这里验证三条意图：
//   ① 压缩不删历史（旧 ops 文件仍在、一字不变）
//   ② 投递口径 = **当前配置**（改预算本轮即生效，与压缩事件无关）；history 始终全量
//   ③ 压缩事件是**不可变快照**（算法 + 过滤器表达），可撤销、可审计
describe("agent.local — 压缩 compact（无网络）", () => {
    /** 三轮历史；返回 uri（每轮一个工具输出，便于验证裁剪） */
    async function seededSession(title: string): Promise<string> {
        const uri = await setup(title);
        const big = Array.from({ length: 200 }, (_, i) => `row ${i}`).join("\n");
        seedOps(uri, [
            ...turnOps("t1000", "第一轮", "a\nb"),
            ...turnOps("t2000", "第二轮", big),
            ...turnOps("t3000", "第三轮", "最后一个输出"),
        ]);
        return uri;
    }

    it("契约①：compact（预算=0 清零）→ 旧 ops 文件仍在且**一字不变**；事件快照记 budget", async () => {
        const uri = await seededSession("压缩保留历史");
        const fp = opsPath(uri);
        const before = readFileSync(fp, "utf-8");

        const rec = (await fx.sh.getJson(`./diy.sh agent local compact ${uri} --budget-bytes 0`)).data as {
            boundary: { keptFromTurnId: string | null; keepFromOpIndex: number };
            policy: { mode?: string; modeData?: { budgetBytes?: number } };
            size: { keptTurns: number; droppedTurns: number; before: { bytes: number }; after: { bytes: number } };
        };
        // 预算 0 = 清零：一条历史都不留 → 无保留起点；事后仍更小
        expect(rec.policy.mode).toBe("budget");
        expect(rec.policy.modeData?.budgetBytes).toBe(0);
        expect(rec.boundary.keptFromTurnId).toBeNull();
        expect(rec.size.keptTurns).toBe(0);
        expect(rec.size.droppedTurns).toBe(3);
        expect(rec.size.after.bytes).toBeLessThan(rec.size.before.bytes);

        // 契约①：**未删任何历史**（同一文件、同一内容）
        expect(existsSync(fp)).toBe(true);
        expect(readFileSync(fp, "utf-8")).toBe(before);

        // 契约③：**事件快照**（取代旧的"分代"）—— 一条 compact，带算法 + 过滤器
        const events = (await fx.sh.getJson(`./diy.sh agent local compactEvents ${uri}`)).data as Array<{
            kind: string;
            id?: string;
            policy?: { mode?: string };
            size?: { before?: { turns: number }; after?: { turns: number } };
        }>;
        const compacts = events.filter((e) => e.kind === "compact");
        expect(compacts).toHaveLength(1);
        expect(compacts[0]!.policy?.mode).toBe("budget");
        expect(compacts[0]!.size?.after?.turns).toBe(0);

        // 契约①：历史页始终全显（压缩不隐藏历史）
        const hist = (await fx.sh.getJson(`./diy.sh agent local history ${uri}`)).data as unknown[];
        expect(JSON.stringify(hist)).toContain("第一轮");
        await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
    });

    it("契约②：投递口径 = **当前配置**（改预算本轮即生效）；history 始终全量", async () => {
        const uri = await seededSession("配置驱动投递");
        // 历史页（ops）**始终全量** —— 压缩不隐藏历史
        const hist = (await fx.sh.getJson(`./diy.sh agent local history ${uri}`)).data as unknown[];
        const asText = JSON.stringify(hist);
        expect(asText).toContain("第一轮");
        expect(asText).toContain("第三轮");

        // 配置：预算 = 0 → 投递不带任何历史轮（=清零）；但**没写过任何压缩事件**
        setConfigPolicy(0);
        const rv0 = (await fx.sh.getJson(`./diy.sh agent local requestView ${uri}`)).data as { messages: unknown[] };
        const m0 = JSON.stringify(rv0.messages);
        expect(m0).not.toContain("第一轮");
        expect(m0).not.toContain("第三轮");

        // 配置：预算撑满 → 历史回归投递（改预算**本轮即生效**，无需压缩事件）
        setConfigPolicy(1024 * 1024);
        const rv1 = (await fx.sh.getJson(`./diy.sh agent local requestView ${uri}`)).data as { messages: unknown[] };
        expect(JSON.stringify(rv1.messages)).toContain("第三轮");
        await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
    });

    it("工具输出裁剪：headtail 后投递里的工具结果带「中间省略」标记（预算撑满 + 裁）", async () => {
        const uri = await setup("压缩裁工具输出");
        const big = Array.from({ length: 200 }, (_, i) => `row ${i}`).join("\n");
        seedOps(uri, [...turnOps("t9000", "只这一轮", big)]);
        const rec = (await fx.sh.getJson(
            `./diy.sh agent local compact ${uri} --budget-bytes 1048576 --tool-result headtail`,
        )).data as { details?: { clipped?: unknown[] } };
        // 被裁明细在 details.clipped（预算撑满 → 工具结果被保留，但按 headtail 裁）
        expect(rec.details?.clipped && rec.details.clipped.length).toBeGreaterThan(0);

        const hist = (await fx.sh.getJson(`./diy.sh agent local history ${uri}`)).data as unknown[];
        // history 是 ops（原始，不裁）；裁剪只影响**投递**
        expect(JSON.stringify(hist)).toContain("row 199"); // ops 原文仍在
        await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
    });

    it("摘要：compactPreview 勾选 summary → mod 请求首条消息是 <summary> 骨架；compact 落账保留摘要", async () => {
        const uri = await seededSession("摘要落账");
        // 勾选 summary（尚未生成）→ 预览里出现占位骨架（预算 0 → 全部轮被丢弃，摘要针对它们）
        const pv = (await fx.sh.getJson(
            `./diy.sh agent local compactPreview ${uri} --budget-bytes 0 --summary`,
        )).data as { modRequest: { messages: unknown[] } };
        const first = JSON.stringify(pv.modRequest.messages[0] ?? "");
        expect(first).toContain("<summary");
        expect(first).toContain("{{summary.conclusions}}"); // 占位里带变量名

        // 执行压缩并带一段摘要文本 → 账本里摘要可查，投递首条即该摘要
        await fx.sh.getJson(
            `./diy.sh agent local compact ${uri} --budget-bytes 0 --summary --summary-text ${JSON.stringify('<summary turns="3">\n关键结论：\n- 已定稿\n</summary>')}`,
        );
        const rv = (await fx.sh.getJson(`./diy.sh agent local requestView ${uri}`)).data as { messages: unknown[] };
        expect(JSON.stringify(rv.messages[0] ?? "")).toContain("关键结论");
        await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
    });

    it("预算 = 0（清零）→ 投递不带历史；有历史消息时也不投（配置驱动，与事件无关）", async () => {
        const uri = await setup("清零投递");
        seedOps(uri, [
            ...turnOps("t1000", "旧1", "x"),
            ...turnOps("t2000", "旧2", "x"),
            ...turnOps("t3000", "旧3", "x"),
        ]);
        setConfigPolicy(0);
        const rv = (await fx.sh.getJson(`./diy.sh agent local requestView ${uri}`)).data as { messages: unknown[] };
        const m = JSON.stringify(rv.messages);
        expect(m).not.toContain("旧1");
        expect(m).not.toContain("旧3");
        // 历史页（ops）仍全显（不销毁、不隐藏）
        expect(JSON.stringify((await fx.sh.getJson(`./diy.sh agent local history ${uri}`)).data)).toContain("旧1");
        await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
    });

    it("compactPreview 只算不写：after<before 且不产生 compact 账本文件", async () => {
        const uri = await seededSession("压缩预览");
        const pv = (await fx.sh.getJson(
            `./diy.sh agent local compactPreview ${uri} --budget-bytes 0`,
        )).data as { before: { bytes: number }; after: { bytes: number } };
        expect(pv.after.bytes).toBeLessThan(pv.before.bytes);
        const dir = join(fx.HOME, "local");
        const hasCompact = readdirSync(dir).some((f) => f.startsWith(localKey(uri)) && f.endsWith(".compact.jsonl"));
        expect(hasCompact).toBe(false); // 预览不落账
        await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
    });

    it("undoCompact：标记某次压缩作废（append-only，事件留痕可审计）", async () => {
        const uri = await seededSession("压缩撤销");
        const rec = (await fx.sh.getJson(`./diy.sh agent local compact ${uri} --budget-bytes 0`)).data as { id: string };
        const u = (await fx.sh.getJson(`./diy.sh agent local undoCompact ${uri} ${rec.id}`)).data as { undone: boolean };
        expect(u.undone).toBe(true);
        // 事件账里出现一条 undo（不删原 compact 行 —— append-only、可审计）
        const events = (await fx.sh.getJson(`./diy.sh agent local compactEvents ${uri}`)).data as Array<{
            kind: string;
            ref?: string;
        }>;
        expect(events.some((e) => e.kind === "undo" && e.ref === rec.id)).toBe(true);
        expect(events.some((e) => e.kind === "compact" && (e as { id?: string }).id === rec.id)).toBe(true);
        // 原文一字未删
        expect(JSON.stringify((await fx.sh.getJson(`./diy.sh agent local history ${uri}`)).data)).toContain("第一轮");
        await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
    });

    it("clear 是「彻底删除」：连同 compact 账本一起清（与 compact 的正交语义）", async () => {
        const uri = await seededSession("压缩与彻底删除");
        await fx.sh.getJson(`./diy.sh agent local compact ${uri} --budget-bytes 0`);
        const dir = join(fx.HOME, "local");
        const key = localKey(uri);
        expect(readdirSync(dir).some((f) => f.startsWith(key) && f.endsWith(".compact.jsonl"))).toBe(true);

        await fx.sh.getJson(`./diy.sh agent local clear ${uri}`);
        expect(hasOpsFile(uri)).toBe(false);
        // 账本也删干净（否则删除后仍能查到本会话的压缩史）
        expect(readdirSync(dir).some((f) => f.startsWith(key) && f.endsWith(".compact.jsonl"))).toBe(false);
        // 清后：压缩事件账也没了（本会话的压缩史查不到）
        const events = (await fx.sh.getJson(`./diy.sh agent local compactEvents ${uri}`)).data as unknown[];
        expect(events).toEqual([]);
        await fx.sh.run(`./diy.sh project remove ${uri.split("/")[1]}`);
    });
});
