// tests/cli.intent.ui-traffic-log-clean.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 「流量日志清理界面」的**行为**契约（##324）
//
// 需求原文：「系统应提供一个清理缓存界面：列出日志文件、显示占用、可删旧文件（如只留最近 N 天）」
//
// 契约（用户能看见 / 摸得着的行为）：
//   1. 流量页「日志 X · N 个文件」旁有「清理…」→ 点开面板，**列出日志文件 + 各自占用**
//   2. 今天（正在写入）的文件**置灰、不可勾选**（Writer 持着 fd，删了会让后续记录写进已删 inode）
//   3. 「只留最近 N 天」把更早的勾上；点「删除选中」→ **应用内二次确认**（ConfirmDialog，不是原生 confirm）
//   4. 取消 → 文件一个不动；确认 → 旧文件真从磁盘消失、今天的文件还在
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;

const LOG_DIR = "log/network";
const OLD_A = "2020-01-01"; // 远早于「最近 7 天」→ 应被清理
const OLD_B = "2020-01-02";

/** 本地日期 YYYY-MM-DD（与落盘文件名一致） */
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const TODAY = todayStr();

const absLog = (date: string) => join(fx.HOME, LOG_DIR, `${date}.jsonl`);
/** 面板行 data-file 里的相对路径（与 core/traffic-log.ts 的 LogLoc.file 同形） */
const relLog = (date: string) => `${LOG_DIR}/${date}.jsonl`;
/** 行集合里是否含某日期（⚠️ `Array.includes` 是元素相等，不是子串 —— 必须 some + includes） */
const hasDate = (files: string[], date: string) => files.some((f) => f.includes(date));

/**
 * 造一个按天日志文件（一行记录）。
 *
 * 必须写**真实形状**（resHeaders / 各计数字段齐备）：流量列表渲染时会读 `resHeaders`
 * 等字段（`mimeType()`），缺字段会抛错 → ViewBoundary 兜住整个 view，列表整个消失
 * （实测踩过：只写 url/status 时页面显示「view「traffic.list」渲染失败」）。
 */
function makeLog(date: string): void {
  mkdirSync(join(fx.HOME, LOG_DIR), { recursive: true });
  const rec = {
    _fmt: "1.0",
    ts: Date.parse(`${date}T12:00:00`) || Date.now(),
    kind: "llm",
    method: "POST",
    url: `https://${date}.example/v1/chat`,
    host: `${date}.example`,
    path: "/v1/chat",
    status: 200,
    reqHeaders: { "content-type": "application/json" },
    resHeaders: { "content-type": "application/json" },
    reqBody: { head: "{}", tail: "" },
    resBody: { head: "{}", tail: "" },
    reqBytes: 12,
    resBytes: 34,
    ms: 42,
    attempt: 1,
    model: "test/model",
    provider: "test",
    taskUri: null,
    turnId: null,
    traceId: null,
    err: null,
  };
  appendFileSync(absLog(date), JSON.stringify(rec) + "\n");
}

/** 面板里列出的文件行 */
const rowFiles = () =>
  ui.query<string[]>(
    `Array.from(document.querySelectorAll('[data-testid="traffic-log-file"]')).map(el => el.getAttribute('data-file'))`,
  );
/** 今天那行的 checkbox 是否禁用 */
const todayDisabled = () =>
  ui.query<boolean>(`(() => {
    const row = document.querySelector('[data-testid="traffic-log-file"][data-today="1"]');
    const cb = row?.querySelector('input[type=checkbox]');
    return !!cb && cb.disabled;
  })()`);
/** 已勾选的文件（data-file） */
const checkedFiles = () =>
  ui.query<string[]>(`(() => {
    return Array.from(document.querySelectorAll('[data-testid="traffic-log-file"]'))
      .filter(el => el.querySelector('input[type=checkbox]')?.checked)
      .map(el => el.getAttribute('data-file'));
  })()`);
/** 二次确认弹窗（ConfirmDialog）的文本；没有弹窗时为空串 */
const confirmText = () =>
  ui.query<string>(`document.querySelector('.max-w-sm')?.textContent?.trim() ?? ""`);

const panelOpen = () => ui.query<boolean>(`!!document.querySelector('[data-testid="traffic-log-cleanup"]')`);

beforeAll(async () => {
  const electron = await startElectronTest();
  const HOME = electron.home;
  fx = {
    electron,
    HOME,
    sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
  };
  ui = await makeUiDriver(fx.electron.cdpUrl, () => a11y());

  // 先铺好「旧文件 + 今天的文件」，再切到流量页
  makeLog(OLD_A);
  makeLog(OLD_B);
  makeLog(TODAY);

  await fx.sh.getJson("./diy.sh ui page navigate traffic");
  const ready = await waitUntil(
    () => ui.query<boolean>(`!!document.querySelector('[data-testid="traffic-log-clean-open"]')`),
    (v) => v,
    { label: "流量页渲染出「清理…」按钮", timeoutMs: 10000 },
  );
  expect(ready).toBe(true);
});

async function a11y(): Promise<A11yNode | undefined> {
  const r = await fx.sh.getJson("./diy.sh ui inspect");
  return (r.data as any)?.data?.tree as A11yNode | undefined;
}

describe("流量日志清理界面（##324）", () => {
  it("「清理…」打开面板，列出日志文件与占用", async () => {
    expect(await panelOpen()).toBe(false);
    await ui.clickSelector('[data-testid="traffic-log-clean-open"]');
    await waitUntil(panelOpen, (v) => v, { label: "清理面板打开" });

    const files = await waitUntil(
      rowFiles,
      (f) => hasDate(f, OLD_A) && hasDate(f, OLD_B) && hasDate(f, TODAY),
      { label: "面板列出三个日志文件" },
    );
    expect(files.length).toBeGreaterThanOrEqual(3);

    // 占用：每行都显示字节数（不是「—」/空）
    const sizes = await ui.query<string[]>(
      `Array.from(document.querySelectorAll('[data-testid="traffic-log-file"]')).map(el => el.textContent)`,
    );
    expect(sizes.every((t) => /\d+(\.\d+)?\s?(B|KB|MB|GB)/.test(t))).toBe(true);
  });

  it("今天（正在写入）的文件置灰、不可勾选", async () => {
    expect(await todayDisabled()).toBe(true);
  });

  it("「只留最近 N 天」勾上更早的文件（今天那个不参与）", async () => {
    await ui.clickSelector('[data-testid="traffic-log-select-old"]');
    const picked = await waitUntil(checkedFiles, (f) => f.length >= 2, { label: "更早的文件被勾上" });
    expect(picked).toContain(relLog(OLD_A));
    expect(picked).toContain(relLog(OLD_B));
    expect(picked).not.toContain(relLog(TODAY));
  });

  it("「删除选中」弹**应用内**二次确认（非原生 confirm），取消则文件一个不动", async () => {
    await ui.clickSelector('[data-testid="traffic-log-delete-selected"]');
    const text = await waitUntil(confirmText, (t) => t.includes("删除"), { label: "二次确认弹窗出现" });
    expect(text).toContain("不可恢复");
    // 弹窗只是确认，还没删
    expect(existsSync(absLog(OLD_A))).toBe(true);
    expect(existsSync(absLog(OLD_B))).toBe(true);

    // 取消（ConfirmDialog 的「取消」是焦点默认项）
    await ui.clickSelector('.max-w-sm button.btn-xs:not(.btn-error)');
    await waitUntil(confirmText, (t) => !t.includes("不可恢复"), { label: "取消后弹窗关闭" });
    expect(existsSync(absLog(OLD_A))).toBe(true);
  });

  it("确认后旧文件真被删除，今天的文件仍在", async () => {
    await ui.clickSelector('[data-testid="traffic-log-delete-selected"]');
    await waitUntil(confirmText, (t) => t.includes("不可恢复"), { label: "再次弹确认" });
    await ui.clickSelector(".max-w-sm button.btn-error");

    await waitUntil(async () => !existsSync(absLog(OLD_A)) && !existsSync(absLog(OLD_B)), (v) => v, {
      label: "旧日志文件从磁盘消失",
      timeoutMs: 8000,
    });
    expect(existsSync(absLog(TODAY))).toBe(true); // 今天正在写入的不动

    // 面板随之刷新：旧文件行消失，今天的行还在
    const files = await waitUntil(rowFiles, (f) => !hasDate(f, OLD_A) && !hasDate(f, OLD_B), {
      label: "面板刷新掉已删文件",
    });
    expect(files).toContain(relLog(TODAY));
  });
});
