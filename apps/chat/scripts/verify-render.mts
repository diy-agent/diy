// verify-render.mts — 用 CDP 实测 ##468 的七条判据（人不用手点也能验）。
//
// 判据（编号照任务 body）：
//   1 界面与裸 DOM 版等价：会话列表 / 消息流 / 输入框 / 模型选择器都在
//   2 发消息不闪：连发 5 条，消息列表新增的 DOM 节点只有「新那几条」的量（不整表重绘）
//   3 滚动不跳：滚到中间后新来一条消息，scrollTop 不动
//   4 输入框不丢焦点：等待回复期间打的草稿，回复到达后还在、焦点还在
//   5 切会话：.chat-list 外壳元素不重建（身份不变），只有行整批换
//   6 两版可切：data-renderer 标记与 --expect 一致（切 import 重新 build 后跑本脚本）
//   7 静态检查：./sha.sh check 由外层跑（这里只负责 1–6）
//
// 用法：./sha.sh verify-render            # 期望 diui
//       RENDERER=dom ./sha.sh verify-render  # 期望裸 DOM（切回 import 后验对照组）
//
// 前置：./sha.sh build（产物在 build/<variant>）+ 仓库根 ./sha.sh sync（真 model.yaml）。

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { chromium, type Browser, type Page } from 'playwright-core';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(pkgDir, '..', '..');
const variant = process.env['DIY_VARIANT'] ?? 'lab';
const expect = (process.env['RENDERER'] ?? 'diui') as 'diui' | 'dom';
const entry = join(pkgDir, 'build', variant, 'main', 'index.mjs');
const home = join(repo, 'build', variant, 'home');
const port = 9600 + Math.floor(Math.random() * 200);

if (!existsSync(entry)) {
    console.error(`✗ 产物不存在：${entry}（先跑 ./sha.sh build）`);
    process.exit(1);
}
if (!existsSync(join(home, 'model.yaml'))) {
    console.error(`✗ 数据根缺 model.yaml：${home}（先跑仓库根 ./sha.sh sync）`);
    process.exit(1);
}

let child: ChildProcess | null = null;
let browser: Browser | null = null;
let logs = '';

const fail = (message: string): never => {
    console.error(`✗ ${message}`);
    if (logs) console.error(logs.slice(-4000));
    child?.kill('SIGKILL');
    void browser?.close();
    process.exit(1);
};

async function launch(): Promise<Page> {
    child = spawn(electronPath as unknown as string, [entry, `--remote-debugging-port=${port}`], {
        env: { ...process.env, DIY_VARIANT: variant, DIY_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (buf: Buffer) => (logs += buf.toString()));
    child.stderr?.on('data', (buf: Buffer) => (logs += buf.toString()));
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        try {
            if ((await fetch(`${endpoint}/json/version`)).ok) break;
        } catch {
            // 还没起来
        }
        if (child.exitCode !== null) fail(`electron 提前退出（code ${String(child.exitCode)}）`);
        await new Promise((r) => setTimeout(r, 200));
    }
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0] ?? fail('CDP 没有 default context');
    const deadline2 = Date.now() + 20_000;
    while (Date.now() < deadline2) {
        const page = context.pages().find((p) => p.url().startsWith('file:') || p.url() === 'about:blank');
        if (page) {
            await page.waitForSelector('.chat-app', { timeout: 20_000 });
            return page;
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    return fail('没等到页面');
}

/** 消息行数 */
const rows = (page: Page): Promise<number> => page.locator('.chat-row').count();

/** 发一条消息并等回复落地（行数 +2）。 */
async function send(page: Page, text: string): Promise<void> {
    const before = await rows(page);
    const input = page.locator('.chat-input');
    await input.fill(text);
    await input.press('Enter');
    await page.waitForFunction((n) => document.querySelectorAll('.chat-row').length >= n, before + 2, {
        timeout: 120_000,
    });
}

/** 等「新来一条消息」时给消息列表挂 MutationObserver 数新增元素（含自身）。 */
async function startCount(page: Page): Promise<void> {
    await page.evaluate(() => {
        const list = document.querySelector('.chat-list')!;
        const win = window as unknown as { __added: number; __obs?: MutationObserver };
        win.__added = 0;
        win.__obs?.disconnect();
        const obs = new MutationObserver((records) => {
            for (const record of records) {
                for (const node of Array.from(record.addedNodes)) {
                    if (!(node instanceof Element)) continue;
                    win.__added += 1 + node.querySelectorAll('*').length;
                }
            }
        });
        obs.observe(list, { childList: true, subtree: true });
        win.__obs = obs;
    });
}

async function takeCount(page: Page): Promise<number> {
    return page.evaluate(() => {
        const win = window as unknown as { __added: number };
        return win.__added;
    });
}

async function main(): Promise<void> {
    const page = await launch();
    const ok = (label: string): void => console.log(`✓ ${label}`);

    // ── 判据 1：界面等价 ──
    const marker = await page.locator('.chat-page').getAttribute('data-renderer');
    if (marker !== expect) fail(`data-renderer=${String(marker)}，期望 ${expect}（判据 6：切 import 需重新 build）`);
    for (const sel of [
        '.chat-sessions',
        '.chat-session-list',
        '.chat-header',
        '.chat-model',
        '.chat-list',
        '.chat-input',
        '.chat-send',
    ]) {
        if ((await page.locator(sel).count()) === 0) fail(`缺元素 ${sel}`);
    }
    ok(`判据 1：会话列表 / 模型选择器 / 消息流 / 输入框齐全（renderer=${expect}）`);

    // 先等 snapshot 落地（多会话能力 = 左栏不再 hidden、模型选择器有候选）
    await page.waitForFunction(() => !document.querySelector('.chat-sessions')?.hasAttribute('hidden'), undefined, {
        timeout: 30_000,
    });
    await page.waitForFunction(() => document.querySelectorAll('.chat-model option').length > 0, undefined, {
        timeout: 30_000,
    });

    // 建一个会话（左栏「新建」，用模型选择器当前选中的便宜模型）
    await page.locator('.chat-new').click();
    await page.waitForFunction(() => document.querySelectorAll('.chat-session').length > 0, undefined, {
        timeout: 30_000,
    });
    if ((await page.locator('.chat-model option').count()) === 0) fail('模型选择器没有 option');
    ok('新建会话 + 模型选择器有候选');

    // 对照组（裸 DOM 版）：判据 2/3/4 本来就不过 —— 只记录它的量，不判失败
    if (expect === 'dom') {
        const added: number[] = [];
        for (let i = 1; i <= 5; i++) {
            await startCount(page);
            await send(page, `对照组 第 ${i} 条`);
            added.push(await takeCount(page));
        }
        console.log(`· 对照组（裸 DOM）：5 次发送新增节点 = ${added.join(',')}（整表重绘 ⇒ 逐次变多）`);
        ok('判据 6：renderer=dom（同一脚本、同一份 wire，对照组行为不同是预期）');
        child?.kill('SIGKILL');
        await browser?.close();
        process.exit(0);
    }

    // ── 判据 2：连发 5 条，DOM 新增节点只有新消息那点量 ──
    const firstRow = page.locator('.chat-row').first();
    const added: number[] = [];
    for (let i = 1; i <= 5; i++) {
        await startCount(page);
        await send(page, `判据2 第 ${i} 条`);
        added.push(await takeCount(page));
    }
    if ((await rows(page)) !== 10) fail(`发完 5 条应有 10 行，实得 ${await rows(page)}`);
    // 一条消息 = li + role + text = 3 个节点；整表重绘的话第 5 次会到 27+
    const worst = Math.max(...added);
    if (worst > 6) fail(`单次发送新增 DOM 节点 ${worst}（>6 ⇒ 整表重绘）：${added.join(',')}`);
    // 旧行必须是同一批真实元素（身份不变 ⇒ 没被重建）
    if (expect === 'diui') {
        const same = await page.evaluate(
            (el) => {
                const first = document.querySelector('.chat-row');
                return first === el;
            },
            await firstRow.elementHandle(),
        );
        if (!same) fail('发消息后第一行 DOM 元素被替换（说明整表重绘了）');
    }
    ok(`判据 2：5 次发送新增节点 = ${added.join(',')}（每条约 3 个，旧行复用）`);

    // ── 判据 3：滚动不跳 ──
    // 把消息区压到 200px 高，保证内容溢出（只是量测需要，不改渲染逻辑）
    await page.evaluate(() => {
        const list = document.querySelector('.chat-list') as HTMLElement;
        list.style.flex = 'none';
        list.style.height = '200px';
    });
    while (
        await page.evaluate(() => {
            const l = document.querySelector('.chat-list')!;
            return l.scrollHeight < l.clientHeight + 120;
        })
    ) {
        await send(page, '判据3 填高度');
    }
    const scrollTop = await page.evaluate(() => {
        const l = document.querySelector('.chat-list')!;
        l.scrollTop = Math.floor((l.scrollHeight - l.clientHeight) / 2);
        return l.scrollTop;
    });
    if (scrollTop < 20) fail('滚动测试没造出可滚动的中间位置');
    await send(page, '判据3 新来一条');
    const after = await page.evaluate(() => document.querySelector('.chat-list')!.scrollTop);
    if (Math.abs(after - scrollTop) > 1) fail(`滚动位置被拽走：${scrollTop} → ${after}`);
    ok(`判据 3：滚到中间（scrollTop=${scrollTop}）后新消息到达，位置不变`);

    // ── 判据 4：输入框不丢焦点、草稿不丢 ──
    let focusOk = false;
    for (let attempt = 1; attempt <= 3 && !focusOk; attempt++) {
        const before = await rows(page);
        const input = page.locator('.chat-input');
        await input.click();
        await input.fill('判据4 触发一条回复');
        await input.press('Enter');
        await input.fill('草稿还在吗');
        await page.waitForFunction((n) => document.querySelectorAll('.chat-row').length >= n, before + 2, {
            timeout: 120_000,
        });
        const state = await page.evaluate(() => {
            const el = document.querySelector('.chat-input') as HTMLInputElement | null;
            return { value: el?.value ?? '', focused: document.activeElement === el };
        });
        focusOk = state.focused && state.value === '草稿还在吗';
        if (!focusOk) await input.fill('');
    }
    if (!focusOk) fail('回复到达后输入框丢了焦点或草稿（判据 4）');
    ok('判据 4：回复到达时焦点仍在输入框，草稿原样保留');

    // ── 判据 5：切会话，外壳不重建 ──
    await page.evaluate(() => {
        const win = window as unknown as { __list?: Element };
        win.__list = document.querySelector('.chat-list');
    });
    await page.locator('.chat-new').click();
    await page.waitForFunction(() => document.querySelectorAll('.chat-session').length >= 2, undefined, {
        timeout: 30_000,
    });
    // 切到「当前没选中」的那个会话（新建的那个往往是排头且已选中，点它等于不切）
    await page.locator('.chat-session[data-active="false"]').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.chat-row').length > 0, undefined, { timeout: 30_000 });
    const shellKept = await page.evaluate(() => {
        const win = window as unknown as { __list?: Element };
        return win.__list === document.querySelector('.chat-list');
    });
    if (expect === 'diui' && !shellKept) fail('切会话后 .chat-list 外壳被重建（判据 5）');
    ok('判据 5：切会话后消息行整批替换，外壳元素身份不变');

    ok(`判据 6：renderer=${expect}（切 import 重新 build 即另一版）`);
    console.log('\n全部通过（判据 7 由 ./sha.sh check 验）。');
    child?.kill('SIGKILL');
    await browser?.close();
    process.exit(0);
}

void main().catch((cause: unknown) => fail(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)));
