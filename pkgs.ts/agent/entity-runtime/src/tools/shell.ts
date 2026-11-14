// tools/shell.ts —— bash 工具（精简移植版）。
//
// 判据（与 @diy-agent/tools 一致的那部分）：
//   · 命令没跑起来（spawn 失败）→ 抛错
//   · 命令跑了但退出码非零 → **返回结果**（退出码 + 输出是数据，模型据此改命令）
//   · 超时 / 取消 → 杀整个进程组，照样返回已收到的输出
//   · 输出超上限 → 截断并注明

import { spawn } from 'node:child_process';

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';


const OUTPUT_MAX = 100_000;

export function bashTool(cwd: string, defaultTimeoutMs = 120_000): ToolSet[string] {
    return tool({
        description:
            '在房间目录执行 bash 命令并返回输出（查文件、跑命令、看系统信息）。' +
            `缺省超时 ${Math.round(defaultTimeoutMs / 1000)}s，到点杀整个进程组并返回已收到的输出。` +
            'stdin 已接 /dev/null，不会挂住等输入；相对路径按房间目录解析。',
        inputSchema: z.object({
            command: z.string().describe('要执行的命令'),
            timeout: z.number().optional().describe('超时毫秒（缺省用房间默认值）'),
        }),
        execute: async ({ command, timeout }) => {
            const limit = timeout ?? defaultTimeoutMs;
            return await new Promise<string>((resolveResult, reject) => {
                const child = spawn('bash', ['-lc', command], {
                    cwd,
                    detached: true,
                    stdio: ['ignore', 'pipe', 'pipe'],
                });

                let out = '';
                const collect = (chunk: Buffer): void => {
                    if (out.length < OUTPUT_MAX) out += chunk.toString('utf8');
                };
                child.stdout?.on('data', collect);
                child.stderr?.on('data', collect);

                let timedOut = false;
                const timer =
                    limit > 0
                        ? setTimeout(() => {
                              timedOut = true;
                              try {
                                  if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
                              } catch {
                                  child.kill('SIGKILL');
                              }
                          }, limit)
                        : undefined;

                child.on('error', (error) => {
                    if (timer !== undefined) clearTimeout(timer);
                    reject(new Error(`[bash] 命令没跑起来：${error.message}`));
                });

                child.on('close', (code, signal) => {
                    if (timer !== undefined) clearTimeout(timer);
                    const status = timedOut ? 'timed_out' : signal !== null ? `killed(${signal})` : `exit: ${code ?? '?'}`;
                    const body = out.length > OUTPUT_MAX ? `${out.slice(0, OUTPUT_MAX)}\n…（输出已截断）` : out;
                    resolveResult(`${status}\n---\n${body.trimEnd()}`);
                });
            });
        },
    });
}
