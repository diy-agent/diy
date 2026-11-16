// examples.hello.test.ts — 两个入门范例（examples/hello-*.ts）跑一遍。
//
// 为什么值得在单测里跑脚本：范例是给**人**读的第一份代码，最容易烂 —— 改个 API 名、挪个文件，
// 人不会发现，读到的人只会以为协议坏了。这两个文件各自只有 40 行左右，跑起来不到 1 秒。

import { spawn } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const pkgRoot = path.resolve(import.meta.dirname, '..');

function runExample(file: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', path.join(pkgRoot, 'examples', file)], {
            cwd: pkgRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
}

describe('入门范例', () => {
    it('入门一：单进程，三个动词都通，结局写死在输出里', async () => {
        const run = await runExample('hello-inproc.ts');
        expect(run.code, run.stderr).toBe(0);
        expect(run.stdout).toContain('cmd   → { ok: true, accepted: false, data: { n: 2 }');
        expect(run.stdout).toContain('watch → added { by: 2, n: 2 }');
        expect(run.stdout, '入门一结尾那行没了 = 脚本半路退出').toContain('入门一 ✔');
    }, 60_000);

    it('入门二：两个进程一条 socket，同样的三个动词', async () => {
        const run = await runExample('hello-net.ts');
        expect(run.code, run.stderr).toBe(0);
        // 服务端是子进程，它的日志也在 stdout 里 —— 顺带证明了两边都起来了
        expect(run.stdout).toContain('[server] 在听');
        expect(run.stdout).toContain('cmd   → { ok: true, accepted: false, data: { n: 3 }');
        expect(run.stdout).toContain('watch → added { by: 3, n: 3 }');
        expect(run.stdout).toContain('入门二 ✔');
    }, 60_000);
});
