// task-detail-smoke.mjs — 任务内容三块 + 悬停覆盖层 的 UI 冒烟（真实事件 + 隔离 Electron）
//
// 需求：① 悬停任务 → 行右侧出现「对话」按钮（= 打开任务对话页）；点任务名链接 =
//       任务管理表格里点任务名（选中它、看详情）；任务名 hover 显示 daisyUI tooltip「打开任务」。
//       ② 任务内容分三块（属性 / 父子树 / 正文），各自可折叠、默认展开；容器窄 → 一列，
//       宽 → 两列（正文靠右）；任务管理详情里的 FAB 文案为「对话」。
//
// 用法：node scripts/ui-smoke/task-detail-smoke.mjs
// 依赖：已 `./sha.sh build`；playwright 用 PLAYWRIGHT_MODULE 指定（默认 bun 全局安装）。
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const PW_MODULE = process.env.PLAYWRIGHT_MODULE ?? "/Users/ccc/.bun/install/global/node_modules/playwright/index.mjs";
const { chromium } = await import(PW_MODULE);

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP = join(REPO, "pkgs.ts/diy-app");
const ELECTRON = join(REPO, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const home = mkdtempSync(join(tmpdir(), "diy-taskdetail-"));
const env = { ...process.env, HOME: home, DIY_HOME: home, PATH: join(REPO, "node_modules/.bin") + ":" + process.env.PATH };
delete env.DIY_PORT;
const port = 9470 + Math.floor(Math.random() * 400);
const proc = spawn(ELECTRON, ["out/main/index.mjs", `--remote-debugging-port=${port}`], { cwd: APP, env, stdio: "ignore", detached: true });
const diy = (args) => JSON.parse(execFileSync("tsx", ["src/cli/index.ts", ...args], { cwd: APP, env, encoding: "utf8" }));

let ok = false, step = "boot";
const fail = [];
const need = (cond, label) => { if (!cond) fail.push(label); return cond; };

try {
  await sleep(9000);
  step = "fixture";
  const pid = diy(["project", "create", join(home, "p"), "--label", "内容项目"]).data.id;
  const A = diy(["task", "create", "祖父任务", String(pid)]).data.uri;
  const B = diy(["task", "create", "父亲任务", String(pid)]).data.uri;
  const C = diy(["task", "create", "孙儿任务", String(pid)]).data.uri;
  diy(["task", "move", B, A]);
  diy(["task", "move", C, B]);
  diy(["task", "edit", B, "--body", "## 正文\n\n这是**正文**内容。"]);

  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const pg = b.contexts()[0].pages()[0];
  const errors = [];
  pg.on("console", (m) => m.type() === "error" && errors.push(`[${step}] ${m.text()}`));
  pg.on("pageerror", (e) => errors.push(`[${step}] ${String(e)}`));
  await pg.reload(); await sleep(3000);

  // ── 任务管理页：选中「父亲任务」→ 详情面板 ──
  step = "① 任务管理详情";
  await pg.evaluate(() => {
    const r = [...document.querySelectorAll("tbody tr")].find((x) => x.innerText.includes("祖父任务"));
    const btn = [...r.querySelectorAll("button")].find((x) => ["›", "⌄"].includes(x.textContent.trim()));
    btn && btn.click();
  });
  await sleep(700);
  await pg.locator("span.diy-link", { hasText: "父亲任务" }).first().click({ timeout: 15000 });
  await sleep(1200);

  const panelReport = await pg.evaluate(() => {
    const panel = document.querySelector("div.card.bg-base-100");
    if (!panel) return null;
    const grid = panel.querySelector(".task-flow-grid");
    const blocks = [...panel.querySelectorAll(".task-flow-left > section, .task-flow-body > section")];
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; };
    return {
      blocks: blocks.map((s) => s.querySelector("button span:nth-child(2)")?.textContent?.trim()),
      gridCols: grid && getComputedStyle(grid).flexDirection,
      body: grid?.querySelector(".task-flow-body > section") ? rect(grid.querySelector(".task-flow-body > section")) : null,
      attrs: blocks[0] ? rect(blocks[0]) : null,
      fab: [...panel.querySelectorAll("button")].map((b) => b.innerText.replace(/\s+/g, "") + "|" + b.title).filter((s) => s.includes("对话") || s.includes("开始") || s.includes("继续")),
      panelW: Math.round(panel.getBoundingClientRect().width),
    };
  });
  console.log("① 任务管理详情:", JSON.stringify(panelReport));
  need(panelReport, "① 详情面板存在");
  if (panelReport) {
    need(JSON.stringify(panelReport.blocks) === JSON.stringify(["任务属性", "任务树", "任务内容"]), "① 三块齐全 " + panelReport.blocks);
    need(panelReport.gridCols === "row", "① 宽容器两列（flex row） " + panelReport.gridCols);
    need(panelReport.body && panelReport.attrs && panelReport.body.x > panelReport.attrs.x, "① 正文在右列");
    need(panelReport.body && Math.abs(panelReport.body.y - panelReport.attrs.y) < 4, "① 正文与属性块同顶");
    need(panelReport.fab.some((s) => s.startsWith("💬对话|")), "① FAB 文案=对话 " + JSON.stringify(panelReport.fab));
    need(!panelReport.fab.some((s) => s.includes("开始") || s.includes("继续")), "① FAB 不再写「开始/继续」");
  }

  // ── ①b 属性字段逐行（不是 flex-wrap 横排挤在一起） ──
  step = "①b 属性竖排";
  const attrRows = await pg.evaluate(() => {
    const sec = [...document.querySelectorAll("section")].find((x) => x.querySelector("button")?.innerText.includes("任务属性"));
    const pick = (t) => [...sec.querySelectorAll("span")].find((n) => n.textContent.trim() === t);
    const rect = (el) => { const r = el.getBoundingClientRect(); return { y: Math.round(r.y), x: Math.round(r.x), w: Math.round(r.width) }; };
    return {
      labels: ["状态", "类型", "模块", "优先级"].map((t) => { const n = pick(t); return n ? { t, ...rect(n) } : { t, missing: true }; }),
      // 控件右缘应当基本对齐成一条线（justify-between 的效果）
      controlRights: [...sec.querySelectorAll("select, input, button.btn-outline")].map((el) => Math.round(el.getBoundingClientRect().right)),
      sectionW: Math.round(sec.getBoundingClientRect().width),
    };
  });
  console.log("①b 属性字段:", JSON.stringify(attrRows));
  const ys = attrRows.labels.filter((l) => !l.missing).map((l) => l.y);
  need(ys.length === 4, "①b 四个字段都在 " + JSON.stringify(attrRows.labels));
  need(new Set(ys).size === 4, "①b 四个字段各占一行（y 互不相同） " + JSON.stringify(ys));
  const drift = attrRows.controlRights.length > 1 ? Math.max(...attrRows.controlRights) - Math.min(...attrRows.controlRights) : 0;
  need(drift < 30, "①b 控件右缘对齐（差 " + drift + "px）");

  // ── ①c 「◀ 当前」紧跟标题、操作按钮右对齐 ──
  step = "①c 行内对齐";
  const rowAlign = await pg.evaluate(() => {
    const row = [...document.querySelectorAll(".group")].find((g) => g.innerText.includes("当前"));
    if (!row) return null;
    const r = row.getBoundingClientRect();
    const link = row.querySelector("button.diy-link");
    const cur = [...row.querySelectorAll("span")].find((n) => n.textContent.includes("当前"));
    const btn = [...row.querySelectorAll("button")].find((b) => b.innerText.includes("对话"));
    const rb = (el) => el.getBoundingClientRect();
    return {
      titleRight: Math.round(rb(link).right),
      curX: Math.round(rb(cur).x),
      gapTitleToCur: Math.round(rb(cur).x - rb(link).right),
      rowRight: Math.round(r.right),
      btnRight: Math.round(rb(btn).right),
      gapBtnToRowRight: Math.round(r.right - rb(btn).right),
    };
  });
  console.log("①c 行内对齐:", JSON.stringify(rowAlign));
  need(rowAlign, "①c 找到带「当前」的行");
  if (rowAlign) {
    need(rowAlign.gapTitleToCur >= 0 && rowAlign.gapTitleToCur <= 12, "①c「当前」紧跟标题（gap " + rowAlign.gapTitleToCur + "px）");
    need(rowAlign.curX < rowAlign.btnRight, "①c「当前」在标题侧、按钮在右");
    need(rowAlign.gapBtnToRowRight <= 8, "①c 对话按钮右对齐（距行右缘 " + rowAlign.gapBtnToRowRight + "px）");
  }

  // ── ①d 两列：左列固定宽 + 拖宽手柄真的能改宽并落盘 ──
  step = "①d 左列宽度";
  const handle = ".task-flow-handle";
  const geo = () => pg.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const r = (el) => el.getBoundingClientRect();
    const grid = q(".task-flow-grid");
    const left = q(".task-flow-left");
    const body = q(".task-flow-body");
    const h = q(".task-flow-handle");
    const cs = getComputedStyle(h);
    return {
      gridW: Math.round(r(grid).width),
      flexDir: getComputedStyle(grid).flexDirection,
      leftW: Math.round(r(left).width),
      bodyW: Math.round(r(body).width),
      handleDisplay: cs.display,
      handleX: Math.round(r(h).x + r(h).width / 2),
      leftRight: Math.round(r(left).right),
      stored: localStorage.getItem("diy_task_detail_left_width"),
    };
  });
  const g0 = await geo();
  console.log("①d 两列几何:", JSON.stringify(g0));
  need(g0.flexDir === "row", "①d 宽容器两列 row " + g0.flexDir);
  need(g0.handleDisplay !== "none", "①d 宽容器显示拖宽手柄");
  need(Math.abs(g0.handleX - g0.leftRight) <= 2, "①d 手柄压在左列右缘");
  need(g0.leftW <= 320 && g0.leftW >= 260, "①d 左列固定宽（默认 280）实宽 " + g0.leftW);
  need(!(g0.leftW === g0.bodyW), "①d 左列与正文不同宽（左列固定、正文吃剩余）");

  // 真实鼠标拖 handle +80px → 左列变宽、正文等比变窄、值落盘
  const hb = await pg.locator(handle).boundingBox();
  await pg.mouse.move(hb.x + hb.width / 2, hb.y + 40);
  await pg.mouse.down();
  for (let i = 1; i <= 8; i++) { await pg.mouse.move(hb.x + hb.width / 2 + (80 * i) / 8, hb.y + 40); await sleep(60); }
  await pg.mouse.up();
  await sleep(400);
  const g1 = await geo();
  console.log("①d 拖动 +80 后:", JSON.stringify(g1));
  need(g1.leftW - g0.leftW > 60, `①d 左列跟随拖动变宽（${g0.leftW} → ${g1.leftW}）`);
  need(g0.bodyW - g1.bodyW > 60, `①d 正文等比变窄（${g0.bodyW} → ${g1.bodyW}）`);
  need(Number(g1.stored) === g1.leftW, `①d 宽度落盘（stored=${g1.stored} 实宽=${g1.leftW}）`);

  // 双击手柄复位
  await pg.locator(handle).dblclick();
  await sleep(400);
  const g2 = await geo();
  console.log("①d 复位后:", JSON.stringify(g2));
  need(g2.leftW === g0.leftW, `①d 双击复位（${g2.leftW} vs ${g0.leftW}）`);
  need(g2.stored === null, "①d 复位清掉存储值");

  // ── 折叠：点标题条 → 内容收起；再点 → 回来 ──
  step = "② 折叠";
  const collapse = await pg.evaluate(async () => {
    const panel = document.querySelector("div.card.bg-base-100");
    const sec = [...panel.querySelectorAll("section")].find((s) => s.querySelector("button")?.innerText.includes("任务树"));
    const head = sec.querySelector("button");
    const bodyText = () => sec.innerText.replace(/\s+/g, "");
    const before = bodyText().length;
    head.click(); await new Promise((r) => setTimeout(r, 300));
    const closed = bodyText().length;
    head.click(); await new Promise((r) => setTimeout(r, 300));
    return { before, closed, reopened: bodyText().length, arrow: head.innerText.trim()[0] };
  });
  console.log("② 折叠:", JSON.stringify(collapse));
  need(collapse.closed < collapse.before && collapse.reopened >= collapse.before, "② 折叠/展开");

  // ── 任务执行页左栏：同三块，容器窄 → 一列 ──
  step = "③ 执行页左栏";
  await pg.locator("button[title*='打开对话']").first().click({ timeout: 15000 });
  await sleep(2000);
  const runReport = await pg.evaluate(() => {
    const side = [...document.querySelectorAll("aside,div")].find((d) => d.className.includes?.("h-full") && d.innerText.startsWith("任务详情"));
    const grid = document.querySelector(".task-flow-grid");
    const blocks = [...document.querySelectorAll(".task-flow-left > section, .task-flow-body > section")];
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; };
    const handle = document.querySelector(".task-flow-handle");
    return {
      sideBar: !!side,
      dir: grid && getComputedStyle(grid).flexDirection,
      handleDisplay: handle ? getComputedStyle(handle).display : "missing",
      y: blocks.map((x) => rect(x).y),
      blocks: blocks.map((s) => s.querySelector("button span:nth-child(2)")?.textContent?.trim()),
      sideText: document.body.innerText.includes("任务详情"),
    };
  });
  console.log("③ 执行页左栏:", JSON.stringify(runReport));
  need(runReport.dir === "column", "③ 窄容器单列（flex column） " + runReport.dir);
  need(runReport.handleDisplay === "none", "③ 窄容器不显示拖宽手柄");
  need(runReport.y[1] > runReport.y[0] && runReport.y[2] > runReport.y[1], "③ 顺序一列 " + JSON.stringify(runReport.y));

  // ── ④a hover 任务树标题 → 只开一层 drawer，贴执行页详情 view 右缘 ──
  step = "④a 任务树标题 hover drawer";
  const treeTitle = pg.locator("[data-task-side-view] .group button.diy-link").first();
  await treeTitle.hover();
  await sleep(350);
  let previewDebug = await pg.evaluate(() => ({
    sides: [...document.querySelectorAll("[data-task-side-view]")].map((x) => x.getBoundingClientRect().toJSON()),
    asides: [...document.querySelectorAll('aside[aria-label^="任务详情"]')].map((x) => x.getAttribute("aria-label")),
    title: [...document.querySelectorAll("[data-task-side-view] .group button.diy-link")].map((x) => x.innerText),
  }));
  console.log("④a hover dispatch check:", JSON.stringify(previewDebug));
  await pg.waitForSelector('aside[aria-label^="任务详情"]', { timeout: 5000 });
  const drawerReport = await pg.evaluate(() => {
    const side = document.querySelector("[data-task-side-view]");
    const drawer = document.querySelector('aside[aria-label^="任务详情"]');
    if (!side || !drawer) return null;
    const a = side.getBoundingClientRect();
    const b = drawer.getBoundingClientRect();
    return {
      sideRight: Math.round(a.right),
      drawerLeft: Math.round(b.left),
      sideWidth: Math.round(a.width),
      drawerWidth: Math.round(b.width),
      title: drawer.querySelector("h3")?.innerText ?? "",
      body: drawer.innerText.slice(0, 120),
      count: document.querySelectorAll('aside[aria-label^="任务详情"]').length,
    };
  });
  console.log("④a 任务树标题 hover drawer:", JSON.stringify(drawerReport));
  need(drawerReport, "④a hover drawer 出现");
  if (drawerReport) {
    need(drawerReport.drawerLeft === drawerReport.sideRight, "④a drawer 紧贴详情 view 右缘");
    need(drawerReport.drawerWidth === drawerReport.sideWidth, "④a drawer 宽度复用详情 view 宽度");
    need(drawerReport.title.includes("祖父任务"), "④a drawer 显示悬停任务内容");
    need(drawerReport.count === 1, "④a 只显示一层 drawer");
  }
  // drawer 内仍有任务树标题，但 hover 不再递归打开第二层。
  await pg.locator('aside[aria-label^="任务详情"] .group button.diy-link').first().hover();
  await sleep(300);
  need(await pg.locator('aside[aria-label^="任务详情"]').count() === 1, "④a drawer 内 hover 不递归弹第二层");
  // 注意：落点必须避开左侧 nav —— nav 是 hover 展开的，鼠标压上去会让主区整体右移，
  // 后续用「先算坐标再 move」的步骤就会全部落空。这里挪到主区右下角的空白处。
  await pg.mouse.move(760, 700);
  await sleep(350);
  need(await pg.locator('aside[aria-label^="任务详情"]').count() === 0, "④a 离开后 drawer 收起");

  // ── 悬停任务名 → daisyUI tooltip「打开任务」；行右侧出现「对话」按钮 ──
  step = "④ 树行的链接/tooltip/对话按钮";
  const linkReport = await pg.evaluate(() => {
    const link = [...document.querySelectorAll("button.diy-link")].find((b) => b.innerText.includes("祖父任务"));
    if (!link) return null;
    const wrap = link.closest("span.tooltip");
    const row = link.closest(".group");
    const btn = [...row.querySelectorAll("button")].find((b) => b.innerText.includes("对话"));
    return {
      isLink: link.classList.contains("diy-link"),
      dataTip: wrap?.getAttribute("data-tip"),
      tipContent: wrap ? getComputedStyle(wrap, "::before").content : null,
      tipDisplay: wrap ? getComputedStyle(wrap).display : null,
      chatBtnBeforeOpacity: getComputedStyle(btn).opacity,
      chatBtnTitle: btn.title,
    };
  });
  console.log("④ 链接/tooltip/对话:", JSON.stringify(linkReport));
  need(linkReport?.dataTip === "打开任务", "④ tooltip 文案");
  need(!!linkReport && linkReport.tipContent.includes("打开任务"), "④ tooltip ::before 内容 " + linkReport?.tipContent);
  need(linkReport?.chatBtnBeforeOpacity === "0", "④ 对话按钮平时不显示");

  // 真实鼠标 hover 该行 → 对话按钮显形（opacity:0 的元素在 a11y 树里是隐藏的，必须真 hover）
  // hover 目标必须是**标题链接本身**：行的中心点现在可能落在标题右侧的空白里
  // （标题不再 flex-1 撑满），落在那儿不会触发链接上的 tooltip。
  const rowBox = await pg.evaluate(() => {
    const link = [...document.querySelectorAll("button.diy-link")].find((b) => b.innerText.includes("祖父任务"));
    const r = link.getBoundingClientRect();
    const btn = [...link.closest(".group").querySelectorAll("button")].find((b) => b.innerText.includes("对话"));
    const br = btn.getBoundingClientRect();
    return {
      x: r.x + r.width / 2, y: r.y + r.height / 2,
      btnX: br.x + br.width / 2, btnY: br.y + br.height / 2,
    };
  });
  await pg.mouse.move(rowBox.x, rowBox.y, { steps: 8 });
  await sleep(600);
  const hoverReport = await pg.evaluate(() => {
    const row = [...document.querySelectorAll(".group")].find((g) => g.innerText.includes("祖父任务"));
    const btn = [...row.querySelectorAll("button")].find((b) => b.innerText.includes("对话"));
    const link = [...row.querySelectorAll("button.diy-link")][0];
    const tip = link.closest("span.tooltip");
    return {
      btnOpacity: getComputedStyle(btn).opacity,
      tipVisible: getComputedStyle(tip, "::before").opacity,
      hit: document.elementFromPoint(btn.getBoundingClientRect().x + 4, btn.getBoundingClientRect().y + 4)?.closest("button")?.innerText?.trim(),
    };
  });
  console.log("④ hover 后:", JSON.stringify(hoverReport));
  need(parseFloat(hoverReport.btnOpacity) > 0.5, "④ hover 显示对话按钮 " + hoverReport.btnOpacity);
  need(parseFloat(hoverReport.tipVisible) > 0.5, "④ hover 显示 tooltip " + hoverReport.tipVisible);
  need(hoverReport.hit?.includes("对话"), "④ 对话按钮可被鼠标命中 " + hoverReport.hit);

  // ── 点对话按钮 → 打开/聚焦该任务的对话 tab ──
  step = "⑤ 点对话按钮";
  await pg.mouse.click(rowBox.btnX, rowBox.btnY);
  await sleep(1500);
  const afterChat = await pg.evaluate(() => ({ tabs: JSON.parse(localStorage.getItem("diy_tabs_opened") || "[]").map((t) => t.ctx) }));
  console.log("⑤ 打开的 tab:", JSON.stringify(afterChat.tabs));
  need(afterChat.tabs.includes(A), "⑤ 对话按钮打开祖父任务的 tab");

  // ── 点任务名链接 → 回到任务管理并选中该任务 ──
  step = "⑥ 点任务名链接";
  await pg.evaluate(() => {
    const link = [...document.querySelectorAll("button.diy-link")].find((b) => b.innerText.includes("父亲任务"));
    link.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await sleep(1500);
  const afterOpen = await pg.evaluate(() => ({
    onTaskPage: !!document.querySelector("tbody tr"),
    selected: document.querySelector("div.card.bg-base-100 .diy-link")?.innerText ?? "",
    uri: JSON.parse(localStorage.getItem("diy_tabs_active") || '""'),
  }));
  console.log("⑥ 点击后:", JSON.stringify(afterOpen));
  need(afterOpen.onTaskPage && afterOpen.selected.includes("父亲任务"), "⑥ 点链接=选中该任务并回到任务管理");

  const real = errors.filter((e) => !e.includes("Client disposed"));
  need(real.length === 0, "console 无错");
  for (const e of real) console.log("  console/pageerror:", e);
  ok = fail.length === 0;
} catch (e) {
  console.error(`异常(${step}):`, e?.message ?? e);
} finally {
  // 收尾必须**确认它真的死了**：只发一次 TERM 就退出，被 timebox 打断或 Electron
  // 卡在退出流程时，会留下没人管的实例（实测残留过 —— 跑几轮攒出十几个各占 ~300MB
  // 的 app，把内存吃光）。TERM 整组 → 等 → 仍在则 KILL 整组 → 再报错给人。
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  try { process.kill(-proc.pid, "SIGTERM"); } catch { }
  for (let i = 0; i < 20 && alive(proc.pid); i++) await sleep(150);
  if (alive(proc.pid)) {
    try { process.kill(-proc.pid, "SIGKILL"); } catch { }
    await sleep(400);
  }
  console.log(alive(proc.pid) ? `⚠ 未能终止测试实例 pid=${proc.pid}（请手动清理）` : "测试实例已清理");
}
console.log("\n结果:", ok ? "PASS" : "FAIL", fail.length ? "失败项=" + fail.join(", ") : "");
process.exit(ok ? 0 : 1);
