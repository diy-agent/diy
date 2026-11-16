// examples.scenario.test.ts — 真进程剧本（examples/demo/scenario.ts）跑一遍，逐条认主张。
//
// 为什么要在单测里再跑一次：剧本自己会 `check()` 抛错，但那要求**人**去跑它。
// 这条测试让 CI 记住「九条主张今天仍然成立」—— 尤其是掉线（unknown）与重启恢复这两条，
// 进程内用例永远造不真。
//
// 代价：一个约 1.5 秒、会起 3 个子进程的用例（不是单元测试，但它是这条链路上唯一诚实的证据）。

import { spawn } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const pkgRoot = path.resolve(import.meta.dirname, '..');

interface Run {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

function runScenario(): Promise<Run> {
    return new Promise<Run>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', path.join(pkgRoot, 'examples/demo/scenario.ts')], {
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

describe('真进程剧本：三条进程 + socket + kill -9', () => {
    it('九条主张全成立（幂等 / 三态名册 / 掉线 / 崩溃重启 / 事件补历史）', async () => {
        const run = await runScenario();
        const lines = run.stdout.split('\n').map((line) => line.trim());

        expect(run.code, `剧本退出码非 0：\n${run.stderr}`).toBe(0);
        expect(run.stderr, '节点把日志写到了 stdout（那是帧的地盘）').not.toContain('!stdout');

        const contains = (pattern: RegExp) => lines.some((line) => pattern.test(line));

        // ② 写：命令回了 done，且回执里带位置
        expect(contains(/✔ post → n=1 seq=e\d+/)).toBe(true);
        // ③ 读：消息只有一条
        expect(contains(/✔ read → messages=1/)).toBe(true);
        // ④ 幂等：同一个 commandId 重发，消息数不动、位置也不动
        expect(contains(/✔ 重发 → messages=1 seq 相同=true/)).toBe(true);
        // ⑤ 扇出：两个成员在两个**进程**里，一次查询问到两边
        expect(contains(/✔ roster → peer-a=running peer-b=idle/)).toBe(true);
        // ⑥ 掉线：kill -9 之后它还在名册里，带得出原因；整体仍是 ok
        expect(contains(/✔ roster → peer-a=running peer-b=unknown\(E_UNAVAILABLE\)（整体 ok=true）/)).toBe(true);
        // ⑦ 崩溃重启：同一个数据目录，状态回得来
        expect(contains(/✔ 重启后 read → messages=1/)).toBe(true);
        // ⑧ 已知空洞：跨重启幂等没做 ⇒ 同一个 commandId 写了第二条
        expect(contains(/✔ 重发 → messages=2/)).toBe(true);
        // ⑨ 事件流：重启前后的事件在同一个 seq 空间里补得出来
        expect(contains(/✔ posted×2/)).toBe(true);
        expect(lines).toContain('全部主张成立（九步）');
    }, 120_000);
});
