// static.ts —— 生产模式：同一个进程既提供 /api，也提供 vite build 出来的 UI。
//
// 为什么不让 UI 另起一个 server：全局命令 `diy2` 要"一条命令开一个地址"，
// 双进程（vite preview + api）还得处理端口/代理，用户装完 npm 包根本不想配这些。
//
// 开发时由 app 显式传 `webDir: null`（页面与 HMR 交给挂进同一个 server 的 vite，同源无代理），
// 这里拿到 undefined，静态服务关掉。
//
// 全程异步（##554 后续）：这里是**每个请求**都会走的路 —— 一次 `statSync` 挡住的不是这一个
// 请求，而是同一事件循环里所有 RPC、事件流推送、agent turn。启动期问一次目录，请求期只 await 文件。

import { createReadStream } from 'node:fs';
import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
};

function sendFile(file: string, res: ServerResponse): void {
    const ext = extname(file).toLowerCase();
    // index.html 永远不缓存：升级后用户不该拿到旧壳子配新资源
    const cache = file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable';
    res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'cache-control': cache,
    });
    createReadStream(file).pipe(res);
}

/** `stat` 的「拿不到就是 null」版（ENOENT / EACCES 都算没有，别为一条静态资源抛） */
async function statOf(file: string): Promise<Stats | null> {
    try {
        return await stat(file);
    } catch {
        return null;
    }
}

/** 静态处理器：`true` = 已经接管这个响应（含回退到 index.html），调用方不要再写 */
export type StaticHandler = (pathname: string, res: ServerResponse) => Promise<boolean>;

/**
 * 建一个静态处理器；webDir 不存在（开发模式 / 没 build 过）时返回 undefined。
 * 命中文件就发；否则回退 `index.html`（SPA 路由）。
 *
 * 存在性判断放在**建的时候**（进程生命周期内产物目录不会出现/消失 —— 换了产物要重启，
 * 这也是 `--web-dir` 存在的理由）；请求期只查具体文件。
 */
export async function createStaticHandler(webDir: string | undefined): Promise<StaticHandler | undefined> {
    if (webDir === undefined || webDir === '') return undefined;
    const root = resolve(webDir);
    const dirStat = await statOf(root);
    if (dirStat === null || !dirStat.isDirectory()) return undefined;
    const index = join(root, 'index.html');

    return async (pathname, res) => {
        let rel: string;
        try {
            rel = decodeURIComponent(pathname);
        } catch {
            rel = pathname; // 坏编码按原样处理，走回退
        }
        const file = resolve(join(root, rel));
        // 防目录穿越：解析后必须仍在 webDir 里
        if (file === root || file.startsWith(root + sep)) {
            const st = await statOf(file);
            if (st !== null && st.isFile()) {
                sendFile(file, res);
                return true;
            }
        }
        const indexStat = await statOf(index);
        if (indexStat !== null && indexStat.isFile()) {
            sendFile(index, res);
            return true;
        }
        return false;
    };
}
