// static.ts —— 生产模式：同一个进程既提供 /api，也提供 vite build 出来的 UI。
//
// 为什么不让 UI 另起一个 server：全局命令 `diy2` 要"一条命令开一个地址"，
// 双进程（vite preview + api）还得处理端口/代理，用户装完 npm 包根本不想配这些。
//
// 开发时由 app 显式传 `webDir: null`（页面与 HMR 交给挂进同一个 server 的 vite，同源无代理），
// 这里拿到 undefined，静态服务关掉。

import { createReadStream, existsSync, statSync } from 'node:fs';
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

/**
 * 返回一个静态处理器；webDir 不存在（开发模式）时返回 undefined。
 * 命中文件就发；否则回退 `index.html`（SPA 路由）。
 */
export function createStaticHandler(
    webDir: string | undefined,
): ((pathname: string, res: ServerResponse) => boolean) | undefined {
    if (webDir === undefined || webDir === '' || !existsSync(webDir)) return undefined;
    const root = resolve(webDir);
    const index = join(root, 'index.html');

    return (pathname, res) => {
        let rel: string;
        try {
            rel = decodeURIComponent(pathname);
        } catch {
            rel = pathname; // 坏编码按原样处理，走回退
        }
        const file = resolve(join(root, rel));
        // 防目录穿越：解析后必须仍在 webDir 里
        if ((file === root || file.startsWith(root + sep)) && existsSync(file) && statSync(file).isFile()) {
            sendFile(file, res);
            return true;
        }
        if (existsSync(index)) {
            sendFile(index, res);
            return true;
        }
        return false;
    };
}
