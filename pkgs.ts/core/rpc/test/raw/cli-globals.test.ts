/**
 * cli-globals.test.ts — 全局选项（进程级 flag）
 *
 * 全局选项与 procedure 的 input 是**两回事**：前者只在 CLI 进程里消费（输出格式/颜色/路径基准），
 * 后者才进 RPC。设计约束与取舍见 `CliConfig.globalOptions` 与 `_parser.ts` 的 scanGlobalOptions。
 *
 * 这里压三件事：
 *   1. 位置自由：命令段之前或之后都接受（`--json task list` ≡ `task list --json`）
 *   2. 剥离时不动其它 token 的顺序（命令侧零改动，靠这条成立）
 *   3. help 与解析同源 —— 声明了就一定出现在 Options 段（老 `--json` 漏列就是没同源）
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { CliApp } from '../../src/cli/index.js';
import { RpcSchema } from '../../src/core/rpc.js';
import type { ClientBinding } from '../../src/core/server-binding.js';

const apiDef = RpcSchema.group({
  children: {
    task: RpcSchema.group({
      desc: '任务管理',
      children: {
        list: RpcSchema.unary({
          desc: '列出任务',
          input: { subject: z.string().optional().cliOption({ desc: '按 subject 筛选' }) },
          output: z.object({ ok: z.boolean() }),
        }),
      },
    }),
  },
});

const globalOptions = z.object({
  json: z.boolean().default(false).cliOption({ short: 'j', desc: 'Output JSON' }),
  color: z.enum(['auto', 'always', 'never']).default('auto').cliOption({ desc: 'Colorize output' }),
  cwd: z.string().optional().cliOption({ short: 'C', desc: 'Run as if started in <dir>' }),
});

/** 记录被调用方法的 transport 桩：全局选项不该影响它 */
function makeTransport() {
  const calls: { method: string; params: unknown }[] = [];
  const t = {
    invoke: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params });
      return { ok: true };
    }),
    serverStream: vi.fn(),
    clientStream: vi.fn(),
    bidiStream: vi.fn(),
    dispose: vi.fn(),
  } as unknown as ClientBinding;
  return { t, calls };
}

class CliExit extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

async function run(argv: string[]) {
  const { t, calls } = makeTransport();
  const out: string[] = [];
  const err: string[] = [];
  let code = 0;
  try {
    await new CliApp({
      name: 'diy',
      version: '1.0.0',
      router: apiDef,
      rpcPrefix: '',
      transport: t,
      globalOptions,
      out: (l) => void out.push(l),
      err: (l) => void err.push(l),
      exit: (c: number): never => {
        code = c;
        throw new CliExit(c);
      },
    }).parse(argv);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
  }
  return { code, out, err, text: out.join('\n'), calls };
}

describe('全局选项：位置自由', () => {
  it('写在命令之后（最自然的写法）', async () => {
    const r = await run(['task', 'list', '--json']);
    expect(r.code).toBe(0);
    expect(r.calls[0]!.method).toBe('task.list');
  });

  it('写在命令之前同样成立', async () => {
    const r = await run(['--json', 'task', 'list']);
    expect(r.code).toBe(0);
    expect(r.calls[0]!.method).toBe('task.list');
  });

  it('夹在命令段中间', async () => {
    const r = await run(['task', '--json', 'list']);
    expect(r.code).toBe(0);
    expect(r.calls[0]!.method).toBe('task.list');
  });

  it('boolean 选项不吃值：`--json task list` 里的 task 仍是命令段', async () => {
    const r = await run(['-j', 'task', 'list']);
    expect(r.calls[0]!.method).toBe('task.list');
  });

  it('带值选项：`-C /tmp task list` 与 `task list -C /tmp` 等价', async () => {
    const a = await run(['-C', '/tmp', 'task', 'list']);
    const b = await run(['task', 'list', '-C', '/tmp']);
    expect(a.calls[0]!.method).toBe('task.list');
    expect(b.calls[0]!.method).toBe('task.list');
  });

  it('`--cwd=/tmp` 形式', async () => {
    const r = await run(['--cwd=/tmp', 'task', 'list']);
    expect(r.calls[0]!.method).toBe('task.list');
  });

  it('短名聚合 `-jv` 只在全为 boolean 时展开（这里 j 是 boolean，v 未声明 → 原样留下报错）', async () => {
    const r = await run(['-j', 'task', 'list']);
    expect(r.code).toBe(0);
    // 未声明的聚合不静默丢弃
    const bad = await run(['-jx', 'task', 'list']);
    expect(bad.code).toBe(2);
    expect(bad.err.join('\n')).toContain('Unknown');
  });

  it('`--` 之后全部当位置参数（全局选项不再被剥离）', async () => {
    const r = await run(['task', 'list', '--', '--json']);
    expect(r.code).toBe(0);
    // 命令照常执行，`--json` 落到位置参数里（本命令没有位置参数 → 被忽略；
    // 「多余位置参数该报错」是 parseArgv 的独立缺口，不在本用例范围）
    expect(r.calls[0]!.method).toBe('task.list');
  });
});

describe('全局选项：校验与 help', () => {
  it('枚举值非法 → 退出码 2，报错点名字段', async () => {
    const r = await run(['task', 'list', '--color', 'rainbow']);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toContain('color');
  });

  it('缺值的选项 → 报错而不是吞掉下一条命令', async () => {
    const r = await run(['--cwd']);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toContain('需要一个值');
  });

  it('重复给出非 multiple 选项 → 报错（不静默覆盖）', async () => {
    const r = await run(['task', 'list', '--json', '--json']);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toContain('重复');
  });

  it('help 的 Options 段列出全局选项（与解析同源）', async () => {
    const r = await run(['--help']);
    expect(r.text).toContain('--json');
    expect(r.text).toContain('--color');
    expect(r.text).toContain('-C, --cwd');
  });

  it('默认值出现在 help 里', async () => {
    const r = await run(['--help']);
    expect(r.text).toContain('(default: "auto")');
  });

  it('命令级 help 不吞全局项：`task list --help` 仍执行且不调 RPC', async () => {
    const r = await run(['task', 'list', '--help']);
    expect(r.code).toBe(0);
    expect(r.text).toContain('Usage: diy task list');
    expect(r.calls.length).toBe(0);
  });
});
