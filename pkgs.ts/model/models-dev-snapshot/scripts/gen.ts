// 生成包内快照：拉 models.dev 的全量规格写到 data/models.dev.json。
//
// 为什么不进 git：6.5 MB / 一万条模型，每次发版都由这个文件重新生成；仓里存一份
// 只会长期过期。opencode 也是每次发版前跑 update-models-snapshot 重写包内文本。
//
// 条件请求：接口给 ETag，带上 If-None-Match 通常回 304（几十字节），不必每次拉 6.5 MB。
// 一天内的快照直接复用（本地 mtime 判），避免 npm install / 每次起 dev 都摸网。
//
// 失败策略：有旧快照就留着、只警告（离线也能用）；一份都没有且 MODELS_DEV_STRICT=1
// （prepack）才报错 —— 不能把没有快照的包发出去。

import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const distDir = fileURLToPath(new URL('../dist/', import.meta.url));
const target = join(distDir, 'models.dev.json');
const etagFile = join(distDir, 'etag.txt');
const url = process.env['MODELS_DEV_URL'] ?? 'https://models.dev/api.json';
const strict = process.env['MODELS_DEV_STRICT'] === '1';
// `./sha.sh gen-models --force` 透传：绕过 24h 复用，强制重拉
const force = process.env['MODELS_DEV_FORCE'] === '1';
const freshMs = 24 * 60 * 60 * 1000;

function touch(path: string): void {
    const now = new Date();
    utimesSync(path, now, now);
}

function fresh(): boolean {
    return existsSync(target) && Date.now() - statSync(target).mtimeMs < freshMs;
}

if (!force && fresh()) {
    console.log('[models-dev] 快照在一天内，跳过');
} else {
    const headers: Record<string, string> = {};
    if (existsSync(etagFile)) headers['If-None-Match'] = readFileSync(etagFile, 'utf8').trim();
    try {
        const response = await fetch(url, { headers });
        if (response.status === 304) {
            if (existsSync(target)) {
                touch(target);
                console.log('[models-dev] 服务端未变更（304），续期本地快照');
            } else {
                throw new Error('服务端返回 304，但本地没有快照');
            }
        } else if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        } else {
            const text = await response.text();
            const parsed: unknown = JSON.parse(text); // 坏了就别落盘
            if (typeof parsed !== 'object' || parsed === null) throw new Error('快照不是对象');
            mkdirSync(distDir, { recursive: true });
            writeFileSync(target, text);
            const etag = response.headers.get('etag');
            if (etag !== null) writeFileSync(etagFile, etag);
            console.log(`[models-dev] 写入 ${(text.length / 1024 / 1024).toFixed(1)} MB 快照`);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (strict) {
            // 发包时必须有快照 —— 不能把一个空壳包发出去
            console.error(`[models-dev] 拉快照失败：${message}`);
            process.exitCode = 1;
        } else {
            // 开发安装时离线不该让 npm install 整体失败；测试会守住「快照必须存在」
            if (existsSync(target)) {
                console.warn(`[models-dev] 拉快照失败（${message}），沿用已有快照`);
                touch(target);
            } else {
                console.warn(`[models-dev] 没有本地快照且拉不到：${message}（目录会暂时是空的）`);
            }
        }
    }
}
