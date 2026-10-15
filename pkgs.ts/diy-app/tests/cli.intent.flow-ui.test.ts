// tests/cli.intent.flow-ui.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 泳道视图页（##320）的**行为**契约 —— 真实 UI（隔离 Electron + CDP）+ 真实数据（flow 实例）
//
// 契约（用户能看见的行为）：
//   1. 页面可打开（`ui tab open flow:<uri>` / 任务执行页的 🛤 按钮），吃**真实例**数据（无实例则直说）
//   2. **未进入**：图上是空舞台（不编造折线）；参数表单**可编辑**并可落盘（`flow params set`）
//   3. **已进入**：折线每步一张卡（同一泳道可二次驻留 = 打回）、连线数 = 驻留数 − 1、
//      打回那条是**红虚线**；参数表单转**只读** + 说明（换配置 = 另起一次运行）
//   4. **节点详情**：hint 原文 / guard 逐条（标「不可观测」）/ actor / art 三段链
//      （##341 起 dev 定义升级为 7 节点、入口 = clarify：折线与泳道断言按新形状更新，**意图不变**）
//   5. **产物区**（##337）：**逐驻留一张卡**，且每个驻留显示**它自己那次**的产物（review1 P1-1）；
//      命令未合入 ⇒ 如实写「待接入」（占位也要逐驻留、逐字对得上）；合入后 ⇒ 断言**渲染出的内容**
//      （不是「有元素就算」—— P3-1：两态取一等于永远绿灯）
//   6. **像素判据**（##166 §14.5 / §14.8）：连线**真的画出来了且没被泳道底纹盖住** ——
//      A/B 对照：正常态红/蓝像素可数；把连线层置底 + 底纹改不透明（复现「被盖住」）⇒ 归零。
//      「截图无报错」不算证据：首帧抛错时截图照样出图，只是图上什么都没有。
//   7. **层叠一次性画清**：背景(0) → 连线(2) → 节点(3)，且 `#wires` 是 `pointer-events:none`
//
// 每个用例自建 project / task，自删；共享的只有隔离 Electron 基础设施。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";
import { countPixels, decodePng, isBlue, isRed } from "./png-pixels";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;

beforeAll(async () => {
    const electron = await startElectronTest();
    const HOME = electron.home;
    fx = {
        electron,
        HOME,
        sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
    };
    ui = await makeUiDriver(fx.electron.cdpUrl, () => a11y());
});

afterAll(async () => {
    ui?.close();
    await fx?.electron?.stop();
});

async function a11y(): Promise<A11yNode | undefined> {
    const r = await fx.sh.getJson("./diy.sh ui inspect");
    return (r.data as Record<string, unknown>)?.data as A11yNode | undefined;
}

/** 建「项目 + 一条任务 + dev 工作流实例」，返回任务 URI */
async function freshInstance(name: string, started = true): Promise<string> {
    const repo = `${fx.HOME}/flow-ui-${name}`;
    const res = await fx.sh.getJson(`./diy.sh project create ${repo}`);
    const pid = String(((res.data as Record<string, unknown>)?.data as Record<string, unknown>)?.id);
    await fx.sh.run(`./diy.sh task create 泳道视图任务 ${pid}`);
    const uri = `projects/${pid}/tasks/1`;
    if (started) await fx.sh.run(`./diy.sh flow start ${uri} --workflow dev`);
    return uri;
}

/** 打开泳道视图页并等它渲染出舞台（无舞台 = 页面没挂上） */
async function openFlowPage(uri: string): Promise<void> {
    await fx.sh.getJson(`./diy.sh ui tab open flow:${uri}`);
    await waitUntil(
        () => ui.query<number>(`document.querySelectorAll('[data-flow-stage]').length`),
        (n) => n === 1,
        { label: "泳道页挂载（stage 出现）", timeoutMs: 10000 },
    );
}

/**
 * CLI 侧推进 / 打回。
 *
 * **`--to` 必填**：宿主对 `to` 是**运行期闸门**（`main/services/api-impl.ts` 的
 * `flow.advance` / `flow.bounce` 都先查 `if (!input.to) throw "缺 --to <节点 id>"`），
 * 虽然 api-def 的入参写着 `optional` —— 运行期不给就报错（实测）。既有 `cli.intent.flow`
 * 的用例也都显名给 `--to`。
 */
async function cliAdvance(uri: string, to: string): Promise<void> {
    await fx.sh.run(`./diy.sh flow advance ${uri} --to ${to}`);
}
async function cliBounce(uri: string, to: string): Promise<void> {
    await fx.sh.run(`./diy.sh flow bounce ${uri} --to ${to}`);
}
/** 从入口走到 `implement`（##341 起入口是 `clarify`：折线上先过 clarify / design 两跳） */
async function cliToImplement(uri: string): Promise<void> {
    for (const node of ["clarify", "design", "implement"]) await cliAdvance(uri, node);
}

/** 把某元素滚进它所在滚动容器的可视区（真人会滚；不滚就是点一个点不到的坐标） */
async function scrollIntoView(selector: string): Promise<void> {
    await ui.query<boolean>(
        `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.scrollIntoView({ block: "center" }); return true; })()`,
    );
    await new Promise((r) => setTimeout(r, 150));
}

/** 点「⟳ 刷新」（页面数据只在显式刷新 / 保存后重取；没有实时推送） */
async function refresh(): Promise<void> {
    await ui.clickSelector("[data-flow-refresh]");
}

/**
 * 舞台区域（视口坐标 ∩ 视口），含 devicePixelRatio —— 像素采样的坐标基准。
 *
 * `scrollIntoView` 连**内层**滚动容器一起滚，而舞台就贴在容器顶（内容只有它）—— 于是它等于把
 * 容器 `scrollTop` 打回 0。##341 起折线变长（7 节点定义的入口链 + 打回 = 5 次驻留），打回线落在
 * 容器可视区之外，采样区采不到红线，故这里**先存后还**：定位到舞台顶是给外层页面用的，
 * 内层滚动归调用方（像素用例）自己控制。
 */
async function stageRect(): Promise<{ x: number; y: number; w: number; h: number; dpr: number }> {
    return await ui.query<{ x: number; y: number; w: number; h: number; dpr: number }>(`(() => {
        const el = document.querySelector('[data-flow-stage]');
        const sc = el.parentElement;
        const keep = sc ? sc.scrollTop : 0;
        el.scrollIntoView({ block: 'start', inline: 'start' });
        if (sc) sc.scrollTop = keep;
        const r = el.getBoundingClientRect();
        // 取样区还要 ∩ **滚动容器的可视盒**：舞台比容器高时它的 rect 会伸到容器外
        // （底部被裁掉、顶部滚到负 y），只用 rect ∩ 视口会把容器外的东西（顶部工具条上的
        // 红/蓝徽章）算进来 —— B 对照里那些像素不会消失，判据就假红。
        const c = sc ? sc.getBoundingClientRect() : r;
        const x = Math.max(0, r.x, c.x);
        const y = Math.max(0, r.y, c.y);
        const w = Math.max(0, Math.min(r.right, c.right, window.innerWidth) - x);
        const h = Math.max(0, Math.min(r.bottom, c.bottom, window.innerHeight) - y);
        return { x, y, w, h, dpr: window.devicePixelRatio || 1 };
    })()`);
}

/** 数舞台区域内的红/蓝像素（真截图 → 解码 → 计数） */
async function stagePixels(): Promise<{ red: number; blue: number; w: number; h: number }> {
    const rect = await stageRect();
    const png = decodePng(await ui.screenshot());
    const region = { x: rect.x * rect.dpr, y: rect.y * rect.dpr, w: rect.w * rect.dpr, h: rect.h * rect.dpr };
    return {
        red: countPixels(png, region, isRed),
        blue: countPixels(png, region, isBlue),
        w: Math.round(region.w),
        h: Math.round(region.h),
    };
}

/** 注入一段临时样式（像素对照用；测完必须移除） */
async function injectStyle(css: string, id: string): Promise<void> {
    await ui.query(`(() => {
        document.getElementById(${JSON.stringify(id)})?.remove();
        const s = document.createElement('style');
        s.id = ${JSON.stringify(id)};
        s.textContent = ${JSON.stringify(css)};
        document.head.appendChild(s);
        return true;
    })()`);
}
async function removeStyle(id: string): Promise<void> {
    await ui.query(`(() => { document.getElementById(${JSON.stringify(id)})?.remove(); return true; })()`);
}

/**
 * 产物命令（##337：`flow view` / `flow artifact put`）是否已接入本分支。
 * 判据取**CLI 自身的退出码**（真源），不看 UI 文案。
 */
async function artifactCommandsReady(uri: string): Promise<boolean> {
    const r = await fx.sh.run(`./diy.sh flow view ${uri}`);
    return r.code === 0;
}

/** 放一份**已知**产物进袋（内容 JSON 化 ⇒ 可按内容断言），`--seq` 指定是哪次驻留的 */
async function putArtifact(uri: string, node: string, seq: number, content: unknown): Promise<void> {
    const file = join(fx.HOME, `artifact-${node}-${seq}.json`);
    writeFileSync(file, JSON.stringify(content), "utf-8");
    const r = await fx.sh.run(`./diy.sh flow artifact put ${uri} --node ${node} --seq ${seq} --file ${file}`);
    expect(r.code, `放产物失败（${node}#${seq}）：${r.stdout}${r.stderr}`).toBe(0);
}

/** 产物区各卡（key = `data-flow-artifact`）的文本 —— 判据看的是**卡上的内容** */
async function artifactCards(): Promise<Record<string, string>> {
    return await ui.query<Record<string, string>>(
        `Object.fromEntries([...document.querySelectorAll('[data-flow-artifact]')].map(e => [e.dataset.flowArtifact, e.textContent]))`,
    );
}

describe("泳道视图页（##320）", () => {
    it("打开页面：未进入 ⇒ 空舞台（不编造折线）+ 参数表单可编辑", async () => {
        const uri = await freshInstance("open");
        await openFlowPage(uri);

        expect(await ui.query<string>(`document.querySelector('[data-flow-position]').textContent.trim()`)).toContain("未进入");
        expect(await ui.query<number>(`document.querySelectorAll('[data-flow-lane]').length`)).toBe(0);
        expect(await ui.query<number>(`document.querySelectorAll('[data-flow-visit]').length`)).toBe(0);
        // 参数表单：未进入 ⇒ 可编辑（有保存按钮），且控件在
        expect(await ui.query<number>(`document.querySelectorAll('[data-flow-params-save]').length`)).toBe(1);
        expect(await ui.query<number>(`document.querySelectorAll('[data-flow-param-input]').length`)).toBeGreaterThan(0);
        // 节点详情：art 三段链区在（未接入时写「待接入」）
        expect(await ui.query<number>(`document.querySelectorAll('[data-flow-detail]').length`)).toBe(1);
    });

    it("参数表单落盘：改值 → 保存 → CLI 读回同一个值（权威 = flow/state.json）", async () => {
        const uri = await freshInstance("params");
        await openFlowPage(uri);

        // 改 `review.reviewers` = 3（真实输入路径：聚焦 → 全选 → 键入）
        await ui.clickSelector('[data-flow-param-input="review.reviewers"]');
        await ui.press("Meta+A");
        await ui.type("3");
        // 参数区挂在 inspector 下部的滚动容器里（`max-h-[45%] overflow-auto`，见 FlowPage.tsx）：
        // ##341 定义升级成 7 节点后参数多一组（`merge.*`），保存按钮落到**容器可视区之外** ——
        // 坐标点不到（`elementFromPoint` 返回 null，点击静默落空）。真人会先滚动，故这里也滚。
        await scrollIntoView("[data-flow-params-save]");
        await ui.clickSelector("[data-flow-params-save]");

        // 以 CLI 读回（UI 说什么不算数，落盘才算）
        const got = await waitUntil(
            async () => {
                const r = await fx.sh.getJson(`./diy.sh flow params get ${uri}`);
                const values = ((r.data as Record<string, unknown>)?.values ?? {}) as Record<string, Record<string, unknown>>;
                return values["review"]?.["reviewers"];
            },
            (v) => v === 3,
            { label: "参数落盘读回 3", timeoutMs: 8000 },
        );
        expect(got).toBe(3);
        // 表单本身也反映了新值
        expect(await ui.query<string>(`document.querySelector('[data-flow-param-input="review.reviewers"]').value`)).toBe("3");
    });

    it("推进与打回：折线每步一张卡、连线数 = 驻留数 − 1、打回是红虚线；参数表单转只读", async () => {
        const uri = await freshInstance("trace");
        // UI 上点「进入入口」—— 证明按钮真的能推进（不是只有 CLI 能走）；
        // 按钮自带目标（`to` 必填，UI 不给宿主就没得推）
        await openFlowPage(uri);
        await ui.clickSelector("[data-flow-enter]");
        await waitUntil(
            () => ui.query<number>(`document.querySelectorAll('[data-flow-visit]').length`),
            (n) => n === 1,
            { label: "进入入口节点（1 次驻留）", timeoutMs: 8000 },
        );

        // 余下几跳用 CLI（正路同一条；UI 的下拉交互不在这里重复测）
        await cliAdvance(uri, "design"); // clarify → design
        await cliAdvance(uri, "implement"); // design → implement
        await cliAdvance(uri, "review"); // implement → review
        await cliBounce(uri, "implement"); // review → implement（打回，不新建节点）
        await refresh();
        await waitUntil(
            () => ui.query<number>(`document.querySelectorAll('[data-flow-visit]').length`),
            (n) => n === 5,
            { label: "折线 5 次驻留", timeoutMs: 8000 },
        );

        // 泳道 = 折线里出现过的节点 ∪ **当前节点**的出边目标（数据缺口：`FlowView` 没有节点全表）。
        // 此刻当前位置是 implement（打回回来），出边只有 → review ⇒ 图上就是折线里那 4 条泳道
        // （`ci` / `approve` / `merge` 要等 review 当当前节点时才看得见 —— 真数据的边界，不编造）。
        expect(
            await ui.query<string[]>(`[...document.querySelectorAll('[data-flow-lane]')].map((e) => e.dataset.flowLane)`),
        ).toEqual(["clarify", "design", "implement", "review"]);
        // 折线：5 次驻留、4 条线（3 蓝 1 红）；同一节点二次驻留标「第 2 次」
        expect(await ui.query<number>(`document.querySelectorAll('path[data-wire-kind="next"]').length`)).toBe(3);
        expect(await ui.query<number>(`document.querySelectorAll('path[data-wire-kind="bounce"]').length`)).toBe(1);
        expect(await ui.query<number>(`document.querySelectorAll('[data-flow-seq="2"]').length`)).toBe(1);

        // **线真的画出来了**（§14.8 的教训：path 数为 0 / 长度为 0 = 白画）
        const lens = await ui.query<number[]>(`[...document.querySelectorAll('[data-flow-wires] path[data-wire-kind]')].map(p => p.getTotalLength())`);
        expect(lens.length).toBe(4);
        for (const l of lens) expect(l).toBeGreaterThan(20);

        // 打回 = 红虚线；推进 = 蓝实线（两色，订正 6 的收窄）
        const styles = await ui.query<Array<{ kind: string; stroke: string; dash: string }>>(`[
            ...document.querySelectorAll('[data-flow-wires] path[data-wire-kind]')
        ].map(p => ({ kind: p.dataset.wireKind, stroke: getComputedStyle(p).stroke, dash: p.getAttribute('stroke-dasharray') || '' }))`);
        const bounce = styles.find((s) => s.kind === "bounce")!;
        const next = styles.find((s) => s.kind === "next")!;
        expect(bounce.stroke).toBe("rgb(239, 68, 68)");
        expect(bounce.dash).toBe("6 5");
        expect(next.stroke).toBe("rgb(59, 130, 246)");
        expect(next.dash).toBe("");

        // 已进入 ⇒ 参数表单只读 + 说明（订正 5）
        expect(await ui.query<number>(`document.querySelectorAll('[data-flow-params-readonly]').length`)).toBe(1);
        expect(await ui.query<number>(`document.querySelectorAll('[data-flow-params-save]').length`)).toBe(0);
        expect(await ui.query<number>(`document.querySelectorAll('[data-flow-params-note]').length`)).toBe(1);
        // 详情面板：guard 逐条标「不可观测」；hint 原文可见
        expect(await ui.query<number>(`document.querySelectorAll('[data-flow-guard]').length`)).toBeGreaterThan(0);
        expect(await ui.query<string>(`document.querySelector('[data-flow-guard]').textContent`)).toContain("不可观测");
        expect(await ui.query<string>(`document.querySelector('[data-flow-detail-hint]').textContent.length`)).toBeGreaterThan(0);
    });

    it("层叠一次性画清：背景(0) → 连线(2) → 节点(3)，`wires` 是 pointer-events:none", async () => {
        const uri = await freshInstance("z");
        await cliToImplement(uri);
        await openFlowPage(uri);
        await waitUntil(
            () => ui.query<number>(`document.querySelectorAll('[data-flow-visit]').length`),
            (n) => n >= 1,
            { label: "折线就绪", timeoutMs: 8000 },
        );
        const z = await ui.query<{ lane: number; wire: number; node: number; pe: string }>(`(() => {
            const lane = document.querySelector('[data-flow-lanes]');
            const wire = document.querySelector('[data-flow-wires]');
            const node = document.querySelector('[data-flow-nodes]');
            return {
                lane: Number(getComputedStyle(lane).zIndex),
                wire: Number(getComputedStyle(wire).zIndex),
                node: Number(getComputedStyle(node).zIndex),
                pe: getComputedStyle(wire).pointerEvents,
            };
        })()`);
        expect(z.lane).toBeLessThan(z.wire);
        expect(z.wire).toBeLessThan(z.node);
        expect(z.pe).toBe("none"); // 连线不抢卡片点击
        // 节点卡确实可点（点击卡片 → 选中态出现）
        await ui.clickSelector("[data-flow-visit]");
        await waitUntil(
            () => ui.query<number>(`document.querySelectorAll('[data-flow-selected="1"]').length`),
            (n) => n >= 1,
            { label: "选中节点卡", timeoutMs: 5000 },
        );
    });

    it("像素判据 A/B：红线蓝线可见，且被底纹盖住时归零（不是「截图无报错」）", async () => {
        const uri = await freshInstance("pixel");
        await cliToImplement(uri); // 入口链 → implement
        await cliAdvance(uri, "review"); // → review
        await cliBounce(uri, "implement"); // → implement（打回红线）
        await openFlowPage(uri);
        await waitUntil(
            () => ui.query<number>(`document.querySelectorAll('path[data-wire-kind="bounce"]').length`),
            (n) => n === 1,
            { label: "打回线就绪", timeoutMs: 8000 },
        );

        // 只留「泳道底纹 + 连线」两层：
        //  · 节点层隐藏 —— 卡片自带红/蓝（actor 色条、按钮）会干扰计数；
        //  · **泳道标题也隐掉** —— 它的颜色是 `ACTOR_COLOR.agent` = `#3b82f6`，与 next 线**同色**，
        //    留着会在 B 对照里被当成「蓝线还看得见」（实测 A/B 都数到 ~800 蓝像素，正是这行字）。
        // A/B 两态共用这段，**只允许底纹与层叠这一个变量不同**。
        const ONLY_WIRES = `[data-flow-nodes]{display:none!important}
             [data-flow-lane] > div{visibility:hidden!important}`;
        await injectStyle(ONLY_WIRES, "__t320_pixel_layer");
        // 滚到舞台底部：采样区 = 视口 ∩ 舞台，而容器只看得见前 2 行多 —— ##341 定义升级后折线
        // 有 5 次驻留（clarify/design/implement/review/implement），**打回线在第 4→5 行**，
        // 不滚下去就只采得到前两条蓝线、红线恒 0（这正是本用例先前红的原因）。
        // 滚到底后同一屏里既有「implement → review」的蓝线（第 3→4 行）也有打回红线 —— 两色一次采到。
        await ui.query<number>(`(() => { const sc = document.querySelector('[data-flow-stage]').parentElement; sc.scrollTop = sc.scrollHeight; return sc.scrollTop; })()`);
        const a = await stagePixels();
        expect(a.w).toBeGreaterThan(100); // 舞台真的截到了
        expect(a.h).toBeGreaterThan(100);
        expect(a.red, `A 态红像素=${a.red}（打回红线；舞台 ${a.w}×${a.h}）`).toBeGreaterThan(20);
        expect(a.blue, `A 态蓝像素=${a.blue}（推进蓝线；舞台 ${a.w}×${a.h}）`).toBeGreaterThan(50);

        // B：复现 ##166 §14.5 的缺陷现场 —— 连线层沉到不透明底纹之下 ⇒ 一条线都看不见
        await injectStyle(
            `${ONLY_WIRES}
             [data-flow-lanes]{background:#ffffff!important}
             [data-flow-lane]{background-color:#ffffff!important}
             [data-flow-wires]{z-index:-1!important}`,
            "__t320_pixel_hidden",
        );
        const b = await stagePixels();
        expect(b.red, `B 态红像素=${b.red}（被底纹盖住应≈0；A 态 ${a.red}）`).toBeLessThanOrEqual(Math.max(2, a.red * 0.1));
        expect(b.blue, `B 态蓝像素=${b.blue}（被底纹盖住应≈0；A 态 ${a.blue}）`).toBeLessThanOrEqual(Math.max(2, a.blue * 0.1));

        // 实测数字留在日志里：判据要能被**复核**，不能只有一句「绿了」（##166 §14.8 的立场）
        console.error(
            `[##320 像素判据] 舞台 ${a.w}×${a.h}：A（只看底纹+连线）红=${a.red} 蓝=${a.blue}` +
                ` · B（连线层沉到不透明底纹下）红=${b.red} 蓝=${b.blue}`,
        );

        await removeStyle("__t320_pixel_layer");
        await removeStyle("__t320_pixel_hidden");
    });

    /**
     * 产物区的**确定态**判据（P3-1：不认「有元素就算」，只认**渲染出的内容**）+ **逐驻留**（P1-1）。
     *
     * 造一条**同节点二次驻留**的折线（implement#1 → review#1 → implement#2 → review#2），
     * 然后按 ##337 是否接入分两支，两支都是**精确**断言：
     *  · 未接入 ⇒ 4 次驻留 ⇒ **4 张卡**，key 逐一对得上，且卡上**逐字**写着未接入的原因；
     *  · 已接入 ⇒ 给 review 的两次驻留**各放一份已知产物**，断言 `review#1` 显示 `REVIEW_ONE`、
     *    `review#2` 显示 `REVIEW_TWO`，且**互不串台** —— 这正是 review1 P1-1 的回归判据
     *    （旧实现：两次都拿「最后一次驻留」的产物 ⇒ review#1 显示 REVIEW_TWO）。
     *
     * 「未接入」支不是跳过：它照样证明**产物区按驻留数画够了卡**（画不出来 = 页面坏了）。
     */
    it("产物区：逐驻留一张卡；##337 接入后各驻留各显示各的（P1-1 回归）", async () => {
        const uri = await freshInstance("artifact");
        await cliToImplement(uri);
        await cliAdvance(uri, "review");
        await cliBounce(uri, "implement");
        await cliAdvance(uri, "review"); // review 二次驻留（seq=2）—— P1-1 的必要条件

        const ready = await artifactCommandsReady(uri);
        if (ready) {
            await putArtifact(uri, "review", 1, { columns: ["项", "结论"], rows: [["轮次", "REVIEW_ONE"]] });
            await putArtifact(uri, "review", 2, { columns: ["项", "结论"], rows: [["轮次", "REVIEW_TWO"]] });
        }

        await openFlowPage(uri);
        await waitUntil(
            () => ui.query<number>(`document.querySelectorAll('[data-flow-artifact]').length`),
            (n) => n >= 6,
            { label: "产物区出现（6 次驻留 ⇒ 6 张卡）", timeoutMs: 10000 },
        );
        const cards = await artifactCards();
        // 逐驻留：key 是 `节点#序号`，6 次驻留（入口链 clarify/design + implement 两次 + review 两次）各一张卡
        expect(Object.keys(cards).sort()).toEqual([
            "clarify#1",
            "design#1",
            "implement#1",
            "implement#2",
            "review#1",
            "review#2",
        ]);

        if (ready) {
            expect(cards["review#1"], `review#1 卡：${cards["review#1"]}`).toContain("REVIEW_ONE");
            expect(cards["review#2"], `review#2 卡：${cards["review#2"]}`).toContain("REVIEW_TWO");
            // P1-1 的正题：早前驻留**不许**显示后一次的产物
            expect(cards["review#1"]).not.toContain("REVIEW_TWO");
        } else {
            // 未接入：占位要说得准（逐驻留同一原因），且不许悄悄变成「无产物」
            expect(cards["review#1"]).toContain("待接入");
            expect(cards["review#2"]).toContain("##337");
        }
        console.error(
            `[##320 产物区] ##337 ${ready ? "已接入" : "未接入"} ⇒ 各卡文本：${JSON.stringify(cards)}`,
        );
    });
});
