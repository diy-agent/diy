// tool-output-read.ts —— 读库外的工具输出原文（`data.output.ref`）。
//
// 为什么需要端到端一个 HTTP 端点（账本 read-path）：外置之后条目里只剩 ref + 头尾预览，
// 人要「看全文」、模型要「read 回来」都得能真拿到文件。模型侧已有绝对路径（投递层 marker
// 的 `resume`），但**人点不开** —— 浏览器不能读本地路径，只能走 HTTP。
//
// 安全边界（**这是本文件存在的全部理由**）：外部传进来的只有 `ref` 字符串，
// 绝不能让 `?ref=../../etc/passwd` 变成任意文件读。三道闸：
//   1. 必须落在 `<home>/runs/tool/` 下（只认这一个目录 —— 不是「任意 home 下的文件」）；
//   2. 规范化后仍在根内（`..` / 绝对路径 / 符号链接穿越都挡掉）；
//   3. 只读普通文件。
//
// Range：31MB 的输出整份读进内存再吐，峰值就是两份 31MB。支持 `bytes=` 后浏览器／
// `curl -r` 能分段取，也让「只看最后 1000 行」这类请求不必拉全文。

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 只认这个前缀 —— 与 `output-store.toolOutputRelPath` 落盘位置一致 */
const ALLOWED_PREFIX = 'runs/tool/';

/**
 * `ref` → 绝对路径；不安全就返回 undefined（调用方回 400，不做「猜他想读哪个」）。
 *
 * 注意 `resolve` 之后还要再比一次前缀：`normalize('runs/tool/../../x')` 会变成 `../x`，
 * 光看 normalize 的结果不够，必须比绝对路径。
 */
export function safeOutputPath(home: string, ref: string): string | undefined {
    if (ref === '' || isAbsolute(ref)) return undefined;
    const normalized = normalize(ref).split(sep).join('/');
    if (!normalized.startsWith(ALLOWED_PREFIX)) return undefined;
    const root = resolve(home, ALLOWED_PREFIX);
    const file = resolve(home, normalized);
    if (file !== root && !file.startsWith(root + sep)) return undefined;
    return file;
}

/**
 * 解析 `Range: bytes=start-end`。
 *
 * 三种结果，**别把后两种混为一谈**：
 *   · `undefined` —— 没带 Range / 语法认不出 ⇒ 发整份（HTTP 允许忽略 Range）；
 *   · `'invalid'` —— 语法对但**不可满足**（起点越界 / 起止颠倒）⇒ 调用方回 416，
 *     并带上 `content-range: bytes *\/总长`（这是 Range 的规矩，不能退化成 200 全量：
 *     客户端按 Range 解析会被整份内容噎住）。
 *   · `{ start, end }` —— 正常闭区间。
 */
export function parseRange(
    header: string | undefined,
    size: number,
): { start: number; end: number } | 'invalid' | undefined {
    if (header === undefined) return undefined;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (match === null) return undefined;
    const [, rawStart, rawEnd] = match;
    // `bytes=-N` = 最后 N 字节
    if (rawStart === '') {
        if (rawEnd === '' || rawEnd === undefined) return undefined;
        const tail = Number(rawEnd);
        if (!Number.isFinite(tail) || tail <= 0) return 'invalid';
        return { start: Math.max(0, size - tail), end: size - 1 };
    }
    const start = Number(rawStart);
    if (!Number.isFinite(start) || start < 0 || start >= size) return 'invalid';
    const end = rawEnd === '' || rawEnd === undefined ? size - 1 : Math.min(Number(rawEnd), size - 1);
    if (!Number.isFinite(end) || end < start) return 'invalid';
    return { start, end };
}

/**
 * 处理 `GET /api/tool-output?ref=...`。
 *
 * 回 404 而不是 403 给「文件不存在」；回 400 给「ref 不合法」—— 后者是调用方写错了，
 * 不该被当成「这条输出没了」（那会让人以为数据丢了）。
 */
export async function serveToolOutput(options: {
    home: string;
    req: IncomingMessage;
    res: ServerResponse;
    ref: string;
}): Promise<void> {
    const { home, req, res, ref } = options;
    const file = safeOutputPath(home, ref);
    if (file === undefined) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'ref 必须指向 runs/tool/ 下' }));
        return;
    }

    let info: Awaited<ReturnType<typeof stat>>;
    try {
        info = await stat(file);
    } catch {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '原文文件不存在（可能已按保留策略清理）' }));
        return;
    }
    if (!info.isFile()) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '不是一个文件' }));
        return;
    }

    const size = info.size;
    const range = parseRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, size);
    if (range === 'invalid') {
        res.writeHead(416, { 'content-range': `bytes */${String(size)}` });
        res.end();
        return;
    }
    // 纯文本：浏览器直接显示（不下载）。`nosniff` 防被当成 HTML 执行。
    const headers: Record<string, string | number> = {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'accept-ranges': 'bytes',
    };

    if (range === undefined) {
        res.writeHead(200, { ...headers, 'content-length': size });
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        createReadStream(file).pipe(res);
        return;
    }

    res.writeHead(206, {
        ...headers,
        'content-range': `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`,
        'content-length': range.end - range.start + 1,
    });
    if (req.method === 'HEAD') {
        res.end();
        return;
    }
    createReadStream(file, { start: range.start, end: range.end }).pipe(res);
}
