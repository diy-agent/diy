// renderer.ts — 浏览器入口：**未授权 ⇒ 登录页**，**已授权 ⇒ 工作台（chat-page）**。
//
// 页面代码一行不改：这里只 registerPage(chatPageView) + mountWorkbench(host, gateway)，
// 与 apps/chat 的 renderer 入口同形 —— 差别只有 gateway 是 HTTP/WS 版（gateway.ts），
// 不是 electron 的 `window.workbench`。
//
// 授权状态机（对应 ##485 body 的 ①–⑤）：
//   未连接 → [请求连接] → 等待副方确认 → 已连接（进工作台）
//   已连接 → 副方 revoke ⇒ 下一次调用 UNAUTHENTICATED ⇒ 回「未连接」，**不自动重试、不自动重连**
//
// token 存哪：副方 store（`$DIY_HOME/web/auth.json`，判据 7）；主方这里只用 **sessionStorage**
// 暂存一份，图的是「刷新页面不用重新配对」。不用 localStorage —— 它是跨标签页、跨会话的长期凭据，
// 而主方的凭据应当随标签页关闭而消失（副方随时可以 revoke，主方没有「永久记住」的理由）。

import { mountWorkbench, registerPage, type WorkbenchFrame, type WorkbenchGateway } from '@diy-agent/workbench-ui';
import { chatPageView } from '@diy-agent/chat-page/renderer-diui';
import { connectWeb, isUnauthenticated, type WebConnection } from './gateway.js';

/** 主方暂存 token 的键（sessionStorage，见文件头） */
const TOKEN_KEY = 'diy-web/token';

/** 轮询「副方确认了吗」的间隔 */
const POLL_MS = 1000;

/** 等待确认的上限：到点就停，让用户自己决定要不要重发（不自动重发） */
const WAIT_TIMEOUT_MS = 3 * 60 * 1000;

/** `GET /ping` 里我们用到的字段 */
interface PingView {
    readonly id: string;
    readonly displayName: string;
    readonly variant: string;
    readonly address: string;
}

function wsUrl(): string {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${location.host}/rpc`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className !== undefined) node.className = className;
    return node;
}

function messageOf(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

/** 未连接时问一次 `/ping`：给用户看「我要连的是谁」（连不上不挡路，只标注） */
async function readPing(): Promise<PingView | null> {
    try {
        const response = await fetch('/ping', { headers: { accept: 'application/json' } });
        if (!response.ok) return null;
        return (await response.json()) as PingView;
    } catch {
        return null;
    }
}

async function main(): Promise<void> {
    const host = document.getElementById('app');
    if (host === null) throw new Error('index.html 缺 #app 挂载点');
    // 注册「怎么画」；有没有这个页面仍由主进程的插件清单决定（与 apps/chat 同构）
    registerPage(chatPageView);

    const saved = sessionStorage.getItem(TOKEN_KEY);
    if (saved === null) {
        showLogin(host, null);
        return;
    }

    // 有暂存 token：**只试一次**。失败（revoke / 过期 / 服务端重启后 token 不在）就清掉回登录页。
    try {
        const connection = await connectWeb(wsUrl());
        await connection.client.web.auth.login({ token: saved });
        await showChat(host, connection);
    } catch (error) {
        sessionStorage.removeItem(TOKEN_KEY);
        showLogin(
            host,
            isUnauthenticated(error)
                ? '上次的授权已被副方撤销或已过期（401）：请重新请求授权'
                : `连不上：${messageOf(error)}`,
        );
    }
}

/** 登录页：地址 + 身份 + 一个「请求连接」按钮 */
function showLogin(host: HTMLElement, notice: string | null): void {
    host.replaceChildren();
    const box = el('div', 'login');
    const title = el('h1');
    title.textContent = '连接这台 diy';
    const peer = el('div', 'peer');
    peer.textContent = `${location.origin}（读取 /ping…）`;
    const status = el('div', 'status');

    const label = el('label');
    label.textContent = '你的身份（主方）';
    const subject = el('input');
    subject.value = `guest@${location.hostname}/diy-chat.lab`;
    label.append(subject);

    const submit = el('button');
    submit.type = 'button';
    submit.textContent = '请求连接';

    const note = el('div', 'note');
    note.textContent =
        '请求会发到副方（这台机器）的确认面；副方确认后凭它签发的 token 进入界面。副方随时可断开，' +
        '断开后本页面不会自动重连。';

    box.append(title, peer, label, submit, status, note);
    host.append(box);

    if (notice !== null) {
        status.dataset['tone'] = 'bad';
        status.textContent = notice;
    }

    void readPing().then((ping) => {
        peer.textContent =
            ping === null
                ? `${location.origin}（/ping 不通）`
                : `${ping.address}  ·  ping ${location.origin}/ping  ·  id ${ping.id}`;
    });

    submit.addEventListener('click', () => {
        submit.disabled = true;
        void startPairing(host, subject.value.trim(), status).catch((error: unknown) => {
            submit.disabled = false;
            status.dataset['tone'] = 'bad';
            status.textContent = `请求失败：${messageOf(error)}`;
        });
    });
}

/** ① 发请求 → ② 等副方确认 → ③ 拿 token → ④ 登录 → 进工作台 */
async function startPairing(host: HTMLElement, subject: string, status: HTMLElement): Promise<void> {
    status.dataset['tone'] = 'warn';
    status.replaceChildren();
    const spinner = el('span', 'spinner');
    const text = el('span');
    text.textContent = '正在建立连接…';
    status.append(spinner, text);

    const connection = await connectWeb(wsUrl());
    const created = await connection.client.web.auth.request({ subject });

    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    text.textContent = `已请求 ${created.address} 授权，等待副方确认…`;

    // 轮询：只是问「确认了吗」，不是重试授权
    for (;;) {
        if (Date.now() > deadline) {
            connection.close();
            status.dataset['tone'] = 'bad';
            status.textContent = '等待超时（副方一直没确认）。可以再点一次「请求连接」。';
            return;
        }
        const state = await connection.client.web.auth.status({ requestId: created.requestId });
        if (state.status === 'denied') {
            connection.close();
            status.dataset['tone'] = 'bad';
            status.textContent = '副方拒绝了这次连接。';
            return;
        }
        if (state.status === 'approved' && state.token !== null) {
            await connection.client.web.auth.login({ token: state.token });
            sessionStorage.setItem(TOKEN_KEY, state.token);
            await showChat(host, connection);
            return;
        }
        await new Promise((done) => setTimeout(done, POLL_MS));
    }
}

/** 已授权：挂工作台（chat-page 原样），并接管「被断开」 */
async function showChat(host: HTMLElement, connection: WebConnection): Promise<void> {
    host.replaceChildren();
    let frame: WorkbenchFrame | null = null;
    let lost = false;

    // 门口那道闸：任何 UNAUTHENTICATED（revoke / 过期）⇒ 回登录页，只回一次
    const lostTo = (error: unknown): void => {
        if (lost) return;
        lost = true;
        sessionStorage.removeItem(TOKEN_KEY);
        frame?.dispose();
        connection.close();
        showLogin(
            host,
            isUnauthenticated(error)
                ? '副方已断开本次连接（401）：需要重新授权，本页不会自动重连'
                : `连接中断：${messageOf(error)}`,
        );
    };

    const gateway: WorkbenchGateway = {
        listPages: () =>
            connection.gateway.listPages().catch((error: unknown) => {
                lostTo(error);
                throw error;
            }),
        invoke: (pageId, method, args) =>
            connection.gateway.invoke(pageId, method, args).catch((error: unknown) => {
                lostTo(error);
                throw error;
            }),
    };

    connection.onClose(() => lostTo(new Error('RPC 连接已关闭')));
    frame = await mountWorkbench(host, gateway, { title: 'diy web' });
}

void main();
