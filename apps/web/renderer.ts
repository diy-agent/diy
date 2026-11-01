// renderer.ts — 浏览器入口：**未登录 ⇒ 创建主用户 / Passkey 登录页**，**已登录 ⇒ 工作台（chat-page）**。
//
// 页面代码一行不改：这里只 registerPage(chatPageView) + mountWorkbench(host, gateway)，
// 与 apps/chat 的 renderer 入口同形 —— 差别只有 gateway 是 HTTP/WS 版（gateway.ts），
// 不是 electron 的 `window.workbench`。
//
// 两条登录路径（##496 起并存，旧的没删）：
//   ① **Passkey**（主路径）：/webauthn/* 的 HTTP 接口。会话 = HttpOnly cookie（7 天），
//      浏览器自动带上 —— 之后连 WebSocket 时 cookie 随升级请求一起发，服务端认它（handlers.ts
//      的 requireClient），所以进工作台**不需要**再拿 token；
//   ② 旧式 token 授权（web.auth.*）：请求连接 → 副方确认 → token 存 sessionStorage。
//      判据要求「旧的原样保留、两条路并存」，这里只把它降级成登录页上的一个入口。
//
// Passkey 的「谁来弹 Touch ID」由浏览器决定：这里只做 fetch 参数 → startRegistration /
// startAuthentication → 回传响应，验签全在服务端（webauthn.ts）。

import { mountWorkbench, registerPage, type WorkbenchFrame, type WorkbenchGateway } from '@diy-agent/workbench-ui';
import { chatPageView } from '@diy-agent/chat-page/renderer-diui';
import {
    startAuthentication,
    startRegistration,
    type PublicKeyCredentialCreationOptionsJSON,
    type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { connectWeb, isUnauthenticated, type WebConnection } from './gateway.js';

/** 旧式 token 暂存键（sessionStorage，见上：Passkey 那条路用 HttpOnly cookie，不碰这里） */
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

/** `GET /webauthn/me` —— `rpID` 是服务端**从 Host 头**推的（= 浏览器的 location.hostname） */
interface MeView {
    readonly hasUser: boolean;
    readonly user: { readonly id: string; readonly displayName: string } | null;
    readonly rpID: string;
    /** 还没主用户时服务端给的建议用户名（= 系统用户名）；有用户则 null */
    readonly suggestedUsername: string | null;
}

/**
 * 部署前缀（= 页面挂在哪：根上给 `''`，挂在 `/diy/` 给 `/diy`）。
 *
 * 不写死 `/rpc` 也不写死 `/webauthn/*`：反代今天把根路径也转到本服务，将来根路径让给别人
 * 就必须能挂在子路径下。规则：取 `location.pathname`，末段带 `.` 就当文件丢弃（`/diy/index.html`）。
 */
function basePath(): string {
    const pathname = location.pathname;
    if (pathname === '' || pathname === '/') return '';
    const trimmed = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
    const last = trimmed.slice(trimmed.lastIndexOf('/') + 1);
    return last.includes('.') ? trimmed.slice(0, trimmed.lastIndexOf('/')) : trimmed;
}

/** 本页面自己的根（`''` 或 `/diy`）：所有 fetch / WebSocket 路径都从它拼出来 */
const BASE = basePath();

/** 站内路径：`path` 必须以 `/` 开头 */
function url(path: string): string {
    return `${BASE}${path}`;
}

function wsUrl(): string {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${location.host}${url('/rpc')}`;
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

/** Passkey 相关的失败换成用户看得懂的一句话（浏览器抛的是 DOMException） */
function passkeyMessageOf(error: unknown): string {
    const name = (error as { name?: unknown }).name;
    if (name === 'NotAllowedError') return 'Touch ID 被取消或超时，请再点一次';
    if (name === 'InvalidStateError') return '这台设备上的凭据已经注册过了';
    return messageOf(error);
}

async function getJson<T>(path: string): Promise<T> {
    const response = await fetch(url(path), { headers: { accept: 'application/json' }, credentials: 'same-origin' });
    const text = await response.text();
    const parsed = text === '' ? null : (JSON.parse(text) as unknown);
    if (!response.ok) {
        const message = (parsed as { message?: unknown } | null)?.message;
        throw new Error(typeof message === 'string' ? message : `${response.status} ${response.statusText}`);
    }
    return parsed as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(url(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
    });
    const text = await response.text();
    const parsed = text === '' ? null : (JSON.parse(text) as unknown);
    if (!response.ok) {
        const message = (parsed as { message?: unknown } | null)?.message;
        throw new Error(typeof message === 'string' ? message : `${response.status} ${response.statusText}`);
    }
    return parsed as T;
}

/** 未登录时问一次 `/ping`：给用户看「我在连谁」（连不上不挡路，只标注） */
async function readPing(): Promise<PingView | null> {
    try {
        return await getJson<PingView>('/ping');
    } catch {
        return null;
    }
}

async function main(): Promise<void> {
    const host = document.getElementById('app');
    if (host === null) throw new Error('index.html 缺 #app 挂载点');
    // 注册「怎么画」；有没有这个页面仍由主进程的插件清单决定（与 apps/chat 同构）
    registerPage(chatPageView);

    // ① 旧式 token 还在：先按老路试一次（两条路并存，不因为加了 Passkey 就把老的踢掉）
    const saved = sessionStorage.getItem(TOKEN_KEY);
    if (saved !== null) {
        try {
            const connection = await connectWeb(wsUrl());
            await connection.client.web.auth.login({ token: saved });
            await showChat(host, connection);
            return;
        } catch {
            sessionStorage.removeItem(TOKEN_KEY);
        }
    }

    // ② Passkey 状态：没用户 ⇒ 创建；有用户没会话 ⇒ 登录；有会话 ⇒ 直接进工作台
    let me: MeView;
    try {
        me = await getJson<MeView>('/webauthn/me');
    } catch (error) {
        showUnavailable(host, `读不到 Passkey 状态：${messageOf(error)}`);
        return;
    }
    // 客户端一致性校验：服务端的 RP ID 必须就是本页面的 hostname（= location.hostname）。
    // 不等就说明页面被换过 host 打开（凭证会验不过）——早报错比让用户对着 Touch ID 弹窗发懵强。
    if (me.rpID !== location.hostname) {
        showUnavailable(host, `RP ID 不符：服务端算出 ${me.rpID}，本页面是 ${location.hostname}`);
        return;
    }
    if (me.user !== null) {
        await enterChat(host, null);
        return;
    }
    if (!me.hasUser) {
        showCreate(host, me);
        return;
    }
    showPasskeyLogin(host, me, null);
}

/** 已登录（cookie 会话或 token）：连 WS 进工作台 */
async function enterChat(host: HTMLElement, notice: string | null): Promise<void> {
    try {
        const connection = await connectWeb(wsUrl());
        await showChat(host, connection);
    } catch (error) {
        showPasskeyLogin(host, await readMe(), notice ?? `连不上：${messageOf(error)}`);
    }
}

/** 重新读一次 /webauthn/me（失败按「没有用户」处理：宁可让用户重新登录） */
async function readMe(): Promise<MeView> {
    try {
        return await getJson<MeView>('/webauthn/me');
    } catch {
        return { hasUser: false, user: null, rpID: location.hostname, suggestedUsername: null };
    }
}

/** 页面外壳：标题 + 一行副标题（这台机器是谁、RP ID 是什么） */
function frame(host: HTMLElement, title: string): { box: HTMLDivElement; status: HTMLDivElement } {
    host.replaceChildren();
    const box = el('div', 'login');
    const heading = el('h1');
    heading.textContent = title;
    const peer = el('div', 'peer');
    peer.textContent = `${location.origin}（读取 /ping…）`;
    const status = el('div', 'status');
    box.append(heading, peer, status);
    host.append(box);
    void readPing().then((ping) => {
        peer.textContent =
            ping === null
                ? `${location.origin}（/ping 不通）`
                : `${ping.address}  ·  ping ${location.origin}/ping  ·  id ${ping.id}`;
    });
    return { box, status };
}

function setStatus(status: HTMLElement, tone: 'good' | 'warn' | 'bad', text: string): void {
    status.dataset['tone'] = tone;
    status.textContent = text;
}

/** 判据 1/2：没有用户 ⇒ 「创建主用户」。创建成功后**不发会话**（刷新仍是登录页，判据 4） */
function showCreate(host: HTMLElement, me: MeView): void {
    const { box, status } = frame(host, '创建主用户');
    const note = el('div', 'note');
    note.textContent = `本机还没有任何用户。创建一次即可 —— 之后注册入口永久关闭（RP ID：${me.rpID}）。`;

    // 用户名会写进通行密钥（凭它就能在系统钥匙串 / iPhone 里认出这条）—— 默认系统用户名，用户可改
    const label = el('label');
    label.textContent = '用户名（显示在系统钥匙串里）';
    const input = el('input');
    input.value = me.suggestedUsername ?? '';
    input.maxLength = 80;
    input.placeholder = '系统用户名';
    label.append(input);
    const hint = el('div', 'note');
    hint.textContent = 'Touch ID 弹窗里会用这个名字 —— 默认取本机系统用户名，不满意可以直接改。';

    const submit = el('button');
    submit.type = 'button';
    submit.textContent = '创建（Touch ID）';

    box.append(note, label, hint, submit);

    submit.addEventListener('click', () => {
        submit.disabled = true;
        setStatus(status, 'warn', '正在请求 Touch ID…');
        void (async () => {
            const name = input.value.trim();
            const { options } = await postJson<{ options: PublicKeyCredentialCreationOptionsJSON }>(
                '/webauthn/register/options',
                // 用户名与显示名同义（单 owner 没有区分它们的需求），两个都给，后端各自取缺省
                { username: name, displayName: name },
            );
            const response = await startRegistration({ optionsJSON: options });
            const created = await postJson<{ user: { displayName: string } }>('/webauthn/register/verify', {
                response,
                credentialName: 'Mac Touch ID',
            });
            showCreated(host, created.user.displayName);
        })().catch((error: unknown) => {
            submit.disabled = false;
            setStatus(status, 'bad', `创建失败：${passkeyMessageOf(error)}`);
        });
    });
}

/** 判据 2：指纹通过后页面显示「已创建」；下一个动作是「用 Passkey 登录」 */
function showCreated(host: HTMLElement, displayName: string): void {
    const { box, status } = frame(host, '已创建');
    setStatus(status, 'good', `主用户「${displayName}」已创建，公钥已写入服务端（私钥在系统钥匙串）。`);
    const go = el('button');
    go.type = 'button';
    go.textContent = '用 Passkey 登录';
    go.addEventListener('click', () => {
        void readMe().then((me) => showPasskeyLogin(host, me, null));
    });
    box.append(go);
}

/** 判据 4/5：有用户 ⇒ 「用 Passkey 登录」；点登录 → Touch ID → 进工作台 */
function showPasskeyLogin(host: HTMLElement, me: MeView, notice: string | null): void {
    const { box, status } = frame(host, '登录这台 diy');
    if (notice !== null) setStatus(status, 'bad', notice);
    else setStatus(status, 'warn', `本机已注册 ${me.user?.displayName ?? 'owner'}（RP ID：${me.rpID}）`);

    const submit = el('button');
    submit.type = 'button';
    submit.textContent = '用 Passkey 登录';

    const legacy = el('button');
    legacy.type = 'button';
    legacy.className = 'link';
    legacy.textContent = '使用旧式 token 授权';

    const note = el('div', 'note');
    note.textContent = '登录会弹 Touch ID（发现式凭证：不用先输用户名）。登录后 7 天内免认证。';

    box.append(submit, note, legacy);
    legacy.addEventListener('click', () => showPairing(host, null));

    submit.addEventListener('click', () => {
        submit.disabled = true;
        setStatus(status, 'warn', '正在请求 Touch ID…');
        void (async () => {
            const { options } = await postJson<{ options: PublicKeyCredentialRequestOptionsJSON }>(
                '/webauthn/login/options',
                {},
            );
            const response = await startAuthentication({ optionsJSON: options });
            await postJson('/webauthn/login/verify', { response });
            await enterChat(host, null);
        })().catch((error: unknown) => {
            submit.disabled = false;
            setStatus(status, 'bad', `登录失败：${passkeyMessageOf(error)}`);
        });
    });
}

/** 连不上 Passkey 接口时的兜底页：只留旧式授权入口 */
function showUnavailable(host: HTMLElement, notice: string): void {
    const { box, status } = frame(host, '连接这台 diy');
    setStatus(status, 'bad', notice);
    const legacy = el('button');
    legacy.type = 'button';
    legacy.textContent = '使用旧式 token 授权';
    legacy.addEventListener('click', () => showPairing(host, null));
    box.append(legacy);
}

/** 旧式授权页（web.auth.*，##485 原样保留）：地址 + 身份 + 一个「请求连接」按钮 */
function showPairing(host: HTMLElement, notice: string | null): void {
    const { box, status } = frame(host, '连接这台 diy');
    setStatus(status, 'warn', notice ?? '');

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

    box.append(label, submit, note);

    submit.addEventListener('click', () => {
        submit.disabled = true;
        void startPairing(host, subject.value.trim(), status).catch((error: unknown) => {
            submit.disabled = false;
            setStatus(status, 'bad', `请求失败：${messageOf(error)}`);
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
            setStatus(status, 'bad', '等待超时（副方一直没确认）。可以再点一次「请求连接」。');
            return;
        }
        const state = await connection.client.web.auth.status({ requestId: created.requestId });
        if (state.status === 'denied') {
            connection.close();
            setStatus(status, 'bad', '副方拒绝了这次连接。');
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

    // 门口那道闸：任何 UNAUTHENTICATED（revoke / 过期 / cookie 失效）⇒ 回登录页，只回一次
    const lostTo = (error: unknown): void => {
        if (lost) return;
        lost = true;
        sessionStorage.removeItem(TOKEN_KEY);
        frame?.dispose();
        connection.close();
        showPasskeyLogin(
            host,
            { hasUser: true, user: null, rpID: location.hostname, suggestedUsername: null },
            isUnauthenticated(error) ? '登录已失效：请重新用 Passkey 登录' : `连接中断：${messageOf(error)}`,
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
