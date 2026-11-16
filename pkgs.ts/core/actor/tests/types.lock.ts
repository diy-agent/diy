// types.lock.ts — **只给类型检查看**的文件（不是测试，vitest 不会跑它）。
//
// 这里钉的是声明层的类型信息有没有真的留住。它曾经没留住，而且是**编译不报错**的那种没留住：
//   · `KindBuilder` 的初始类型参数是 `Record<string, never>`（带字符串索引签名）→ `keyof C` 是 `string`
//   · `CommandDef` 存的是 `z.ZodType<O>`（只有输出）→ `z.input` 只能给 `unknown`
// 两个加起来，`client.cmd('nope', {...})` 能编译、入参可以随便写、「类型从 schema 推」变成空话。
//
// 所以这里的每一行 `@ts-expect-error` 都是一道锁：哪天类型退化了，`tsc --noEmit` 会报
// 「Unused '@ts-expect-error' directive」—— 也就是这一行又能编译了。判据就是它。

import type { CmdInput, CmdNames, QueryInput, QueryNames, CmdOutput } from '../src/index.js';
import { createLocalActor, type ActorClient } from '../src/index.js';

import { counterKind } from './support/fixtures.js';

// ── 名字集合是封闭的 ────────────────────────────────────────────────────────
const names: CmdNames<typeof counterKind>[] = ['add', 'slowAdd', 'slowFail', 'reset'];
void names;
// @ts-expect-error 命令名集合里没有这个
const _badName: CmdNames<typeof counterKind>[] = ['nope'];
void _badName;

const queries: QueryNames<typeof counterKind>[] = ['get'];
void queries;
// @ts-expect-error 查询名不能混进命令名
const _badQuery: QueryNames<typeof counterKind>[] = ['add'];
void _badQuery;

// ── 入参/出参按名字精确推导 ────────────────────────────────────────────────
const input: CmdInput<typeof counterKind, 'add'> = { by: 2 };
void input;
// @ts-expect-error 字段写错
const _badInputField: CmdInput<typeof counterKind, 'add'> = { byN: 2 };
void _badInputField;
// @ts-expect-error 缺字段
const _badInputMissing: CmdInput<typeof counterKind, 'add'> = {};
void _badInputMissing;

const output: CmdOutput<typeof counterKind, 'add'> = { n: 2 };
void output;

// ── raw 层也吃同一份契约（它是函数层的地基）────────────────────────────────
async function rawLayer(): Promise<void> {
    const { client, actor } = await createLocalActor({ kind: counterKind, uri: 'test://types' });

    // 写对了就能编译
    const ok: ActorClient<typeof counterKind> = client;
    await ok.cmd('add', { by: 1 });
    await ok.query('get', {});

    // 写错了就编译不过
    // @ts-expect-error 没有这个命令
    await client.cmd('nope', {});
    // @ts-expect-error 入参字段写错
    await client.cmd('add', { byN: 1 });
    // @ts-expect-error 查询入参也校验
    await client.query('get', { n: 1 });

    await actor.close();
}
void rawLayer;

// 空入参（`z.object({})`）是 `Record<string, never>`，不是 `{}` —— 记一笔，免得下次又当它是空对象
const emptyQueryInput: QueryInput<typeof counterKind, 'get'> = {};
void emptyQueryInput;
