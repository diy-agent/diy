// tests/intent.template.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 提示词模版引擎「意图测试」—— 需求级（人类语言描述需求，不描述实现）
//
// 需求定义（本文件即契约，逐条对应 SPEC.md §1 的 R1–R12）：
//   R1  逐字节原样：不转义、不 trim、不删行
//   R2  插值：globals（a.b）与动态作用域（.x.y）真分离
//   R3  属性内插值：<project_instructions path="{{.path}}">
//   R4  条件：:if / :if-not，真假值固定表
//   R5  循环：:for={{集合}} :as="x" + .x.value/.x.index/.x.isFirst（嵌套时外层仍可访）
//   R6  include：参数显式传递，动态作用域**不继承**（只看到参数），globals 全程可见
//   R7  include 解析走宿主注册表；白名单 / 禁止 .. / 禁止绝对路径
//   R8  include 循环检测 + 深度上限
//   R9  未知路径 / 未知参数 / 少传参数 / 取值 undefined / 写表达式 → 全部报错（不静默）
//   R10 静态分析：引用清单（globals / 动态 / include / 条件 / 循环）
//   R11 结构 trace：每个节点的字节数 + 每个 :if 的真假与原因
//   R12 装配形态：节标签与分隔由模版表达，不再是代码拼装
//
// 测试风格：**以真实提示词为素材**（链上 AGENTS.md、diy 自述、任务节、技能槽位），
// 断言完整输出字符串（而不是断言内部实现），以「换引擎后模型看到的东西没变」为准。
// 模版一律用多行字符串书写（block() 去公共缩进），与真实模版长得一样；
// 换行是契约的一部分，所以「末尾要不要换行」一律显式写出来（+ '\n'），不靠隐式规则。
// ═══════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest';
import {
    TemplateError,
    analyze,
    previewValue,
    render,
    renderWithTrace,
    type IncludeResolver,
    type IncludeTarget,
    type TraceNode,
} from '../src/index';

/**
 * 多行模版 → 字符串：去掉首行/末行空行，按最小缩进去公共缩进。
 * 这样测试里的模版能保持人读得懂的缩进；**末尾换行请显式 `+ '\n'`**（引擎不 trim）。
 */
function block(s: string): string {
    const lines = s
        .replace(/^\n/, '')
        .replace(/\n[ \t]*$/, '')
        .split('\n');
    const indents = lines.filter((l) => l.trim() !== '').map((l) => /^[ \t]*/.exec(l)![0].length);
    const indent = indents.length > 0 ? Math.min(...indents) : 0;
    return lines.map((l) => l.slice(indent)).join('\n');
}

/** 用内存表当宿主注册表（真环境里是 prompt-registry：项目覆盖 > 内置 + 白名单） */
function resolverOf(files: Record<string, IncludeTarget | string>): IncludeResolver {
    return {
        resolve(relpath) {
            const hit = files[relpath];
            if (hit === undefined) return null;
            return typeof hit === 'string' ? { source: hit } : hit;
        },
    };
}

/** 捕获错误（断言分类 + 位置） */
function caught(fn: () => unknown): TemplateError {
    try {
        fn();
    } catch (e) {
        if (e instanceof TemplateError) return e;
        throw e;
    }
    throw new Error('预期抛 TemplateError，但没有抛');
}

// ── 共用素材（与真实模版同形） ────────────────────────────────────────

/** 链片段：AGENTS.md 每层的包裹格式（真实 _chain.md 的形态） */
const CHAIN_FRAGMENT = block(`
    <project_instructions path="{{.path}}" scope="{{.scope}}">
    {{.content}}
    </project_instructions>
`);

const CHAIN = [
    { path: '/Users/ccc/AGENTS.md', scope: '/Users/ccc', content: '根规则' },
    { path: '/repo/AGENTS.md', scope: '/repo', content: '仓库规则 & <x>' },
];

/** 一层链的期望渲染结果 */
function chainItem(path: string, scope: string, content: string): string {
    return block(`
        <project_instructions path="${path}" scope="${scope}">
        ${content}
        </project_instructions>
    `);
}

/** 一个 include 标签（装配布局用它拼顺序） */
function include(relpath: string, attrs = ''): string {
    return `<template :include="${relpath}"${attrs} />`;
}

// ── R1 逐字节原样 ────────────────────────────────────────────────────

describe('R1 逐字节原样（不转义 / 不 trim / 不删行）', () => {
    it('提示词里的 & < > 引号原样保留，不做 HTML 转义', () => {
        const out = render(block(`
            用 bash 处理 a\\<b && c>d；说 "中文" 与 '单引号'
        `), {});
        expect(out).toBe('用 bash 处理 a<b && c>d；说 "中文" 与 \'单引号\'');
        expect(out).not.toContain('&lt;');
        expect(out).not.toContain('&amp;');
    });

    it('行尾换行与空行原样保留（不 trim、不删行）', () => {
        const src = '第一行\n\n第二行\n';
        expect(render(src, {})).toBe(src);
    });

    it('控制节点不产出任何字符（<template> 只做条件/循环）', () => {
        const out = render('<template :if={{diy.on}}>A</template>B', { globals: { diy: { on: true } } });
        expect(out).toBe('AB');
    });

    it('逃生舱 \\{{ ：只吞掉紧随其后的 {{ ，后面的插值照常生效', () => {
        expect(render('说明：\\{{diy.cli}} 是占位符写法', {})).toBe('说明：{{diy.cli}} 是占位符写法');
        // 吃掉的是开头的两个大括号；后面的 }} 本来就不是语法
        expect(render('\\{{ x }}{{diy.cli}}', { globals: { diy: { cli: 'V' } } })).toBe('{{ x }}V');
        // 属性值里同样可用（否则属性里写不出字面量 {{）
        expect(render('<pi path="\\{{a}}" />', {})).toBe('<pi path="{{a}}" />');
    });

    it('写法一：< 完全不需要转义（输出标签、非良构文本、泛型、比较符都是文本）', () => {
        expect(render('<pid> 是任务号；a<b；vector<T> 与 Map<K,V>', {})).toBe(
            '<pid> 是任务号；a<b；vector<T> 与 Map<K,V>',
        );
        // 输出标签也不解析：属性引号、空白都原样
        expect(render("<pi path='x'  flag>y</pi>", {})).toBe("<pi path='x'  flag>y</pi>");
        // 只有 <template 是控制标记：想写字面量时用 \<，整段用 <raw>，讲格式用代码围栏
        expect(render('讲格式：\\<template :if="x">A\\</template>', {})).toBe('讲格式：<template :if="x">A</template>');
        expect(render('<raw><template :if={{x}}>A</template></raw>', {})).toBe('<template :if={{x}}>A</template>');
    });

    it('反斜杠只在 {{ 或 < 前特殊；其它位置原样（Windows 路径不受影响）', () => {
        expect(render('C:\\repo\\src', {})).toBe('C:\\repo\\src');
        // 要输出字面量 \< ：写两个反斜杠（前一个原样输出，后一个触发转义）
        expect(render('\\\\<', {})).toBe('\\<');
        // 反斜杠 + 非 {{ / < ：原样
        expect(render('regex: \\d+', {})).toBe('regex: \\d+');
    });
});

// ── R2/R3 插值与属性 ─────────────────────────────────────────────────

describe('R2/R3 插值：globals 与动态作用域真分离', () => {
    it('globals 点路径取值（{{diy.cli}} / {{task.title}}）', () => {
        const out = render('入口 {{diy.cli}}，任务 {{task.title}}', {
            globals: { diy: { cli: '/repo/diy.sh' }, task: { title: '评审任务' } },
        });
        expect(out).toBe('入口 /repo/diy.sh，任务 评审任务');
    });

    it('属性里可以插值（链片段的真实写法）', () => {
        const out = render(
            include('./_chain.md', ' path={{diy.home}} content={{diy.note}} scope={{diy.scope}}'),
            { globals: { diy: { home: '/home/u/AGENTS.md', scope: '/home/u', note: '根规则' } } },
            { resolver: resolverOf({ './_chain.md': CHAIN_FRAGMENT }) },
        );
        expect(out).toBe(chainItem('/home/u/AGENTS.md', '/home/u', '根规则'));
    });

    it('属性里的插值解析期就校验（写表达式直接报错，而不是发出一个坏属性）', () => {
        const err = caught(() => render('<pi path="{{a == b}}">x</pi>', { globals: { a: 1, b: 1 } }));
        expect(err.code).toBe('syntax');
        expect(err.message).toContain('只支持路径');
    });
});

// ── R4 条件 ──────────────────────────────────────────────────────────

describe('R4 条件：:if / :if-not 与固定真假值表', () => {
    it('空数组为假 → 技能槽位整节不出现（今天由代码 if (!text.trim()) 决定）', () => {
        const tpl = block(`
            <template :if={{diy.skills}}><skills>
            技能
            </skills>
            </template>
        `);
        expect(render(tpl, { globals: { diy: { skills: [] } } })).toBe('');
        expect(render(tpl, { globals: { diy: { skills: ['a'] } } })).toBe('' + block(`
            <skills>
            技能
            </skills>
        `) + '\n');
    });

    it(':unless 取反 → 「cwd 回退」提示只在回退时出现（今天由代码拼 "\n注意：…" 决定）', () => {
        const tpl = block(`
            工作目录：{{diy.cwd}}<template :if-not={{diy.cwdIsProject}}>
            注意：项目目录不存在，工具实际在任务目录下执行</template>
        `);
        expect(render(tpl, { globals: { diy: { cwd: '/repo', cwdIsProject: false } } })).toBe(
            '工作目录：/repo\n注意：项目目录不存在，工具实际在任务目录下执行',
        );
        expect(render(tpl, { globals: { diy: { cwd: '/repo', cwdIsProject: true } } })).toBe('工作目录：/repo');
    });

    it('真假值表：false/0/""/[]/null 为假；"false"/"0"/" "/{} 为真', () => {
        const tpl = '<template :if={{x}}>真</template><template :if-not={{x}}>假</template>';
        for (const falsy of [false, 0, '', [], null]) {
            expect(render(tpl, { globals: { x: falsy } })).toBe('假');
        }
        for (const truthy of ['false', '0', ' ', {}]) {
            expect(render(tpl, { globals: { x: truthy } })).toBe('真');
        }
    });

    it('给某个标签加条件：直接写在标签上（带控制属性的标签即容器，标签原样输出）', () => {
        const tpl = block(`
            <rules>
            <item :if={{diy.strict}}>严格</item>
            </rules>
        `);
        expect(render(tpl, { globals: { diy: { strict: true } } })).toBe(block(`
            <rules>
            <item>严格</item>
            </rules>
        `));
        // 条件为假：连标签一起不输出（只留布局自身的换行）
        expect(render(tpl, { globals: { diy: { strict: false } } })).toBe(block(`
            <rules>

            </rules>
        `));
        // 等价写法：<template> 包裹（控制标记不产出字符）；两者字节一致
        const wrapped = block(`
            <rules>
            <template :if={{diy.strict}}><item>严格</item></template>
            </rules>
        `);
        expect(render(wrapped, { globals: { diy: { strict: true } } })).toBe(
            render(tpl, { globals: { diy: { strict: true } } }),
        );
        // 循环也一样：<skill :for={{list}} :as="s">
        expect(render('<skill :for={{diy.skills}} :as="s">{{.s.value}}</skill>', { globals: { diy: { skills: ['a', 'b'] } } })).toBe(
            '<skill>a</skill><skill>b</skill>',
        );
    });
});

// ── R5 循环 ──────────────────────────────────────────────────────────

describe('R5 循环：:for={{集合}} :as + 项/序号/首末（嵌套各自可访）', () => {
    it('链上多层 AGENTS.md：由模版自己迭代（今天由代码循环）', () => {
        const tpl = block(`
            以下按 scope 生效：
            <template :for={{diy.chain}} :as="item"><template :include="./_chain.md" path={{.item.value.path}} scope={{.item.value.scope}} content={{.item.value.content}} />
            </template>
        `);
        const out = render(
            tpl,
            { globals: { diy: { chain: CHAIN } } },
            { resolver: resolverOf({ './_chain.md': CHAIN_FRAGMENT }) },
        );
        expect(out).toBe(
            '以下按 scope 生效：\n' +
                `${chainItem(CHAIN[0]!.path, CHAIN[0]!.scope, CHAIN[0]!.content)}\n` +
                `${chainItem(CHAIN[1]!.path, CHAIN[1]!.scope, CHAIN[1]!.content)}\n`,
        );
    });

    it('下标用 .x.index，字符串数组用 .x.value，空数组不产出任何字符', () => {
        const tpl = '<template :for={{diy.list}} :as="s">{{.s.index}}:{{.s.value}}|</template>';
        expect(render(tpl, { globals: { diy: { list: ['a', 'b'] } } })).toBe('0:a|1:b|');
        expect(render(tpl, { globals: { diy: { list: [] } } })).toBe('');
    });

    it('分隔符不需要表达式：信封自带 .isFirst / .isLast / .index', () => {
        // 等价于 join("\n\n")：除首项外，每项前加一个空行
        const tpl = block(`
            <template :for={{diy.list}} :as="f"><template :if-not={{.f.isFirst}}>

            </template>[{{.f.value}}]</template>
        `);
        expect(render(tpl, { globals: { diy: { list: ['a', 'b', 'c'] } } })).toBe('[a]\n\n[b]\n\n[c]');
        expect(
            render('<template :for={{diy.list}} :as="f">{{.f.index}}:{{.f.value}} first={{.f.isFirst}} last={{.f.isLast}}|</template>', {
                globals: { diy: { list: ['a', 'b'] } },
            }),
        ).toBe('0:a first=true last=false|1:b first=false last=true|');
    });

    it('嵌套循环：外层与内层的信封**同时可访**（旧设计里外层 .index 会被遮蔽）', () => {
        const tpl = block(`
            <template :for={{diy.groups}} :as="g"><template :for={{.g.value.items}} :as="it">{{.g.value.name}}#{{.g.index}}.{{.it.index}}={{.it.value}}|</template></template>
        `);
        const out = render(tpl, { globals: { diy: { groups: [{ name: 'A', items: ['x', 'y'] }, { name: 'B', items: ['z'] }] } } });
        expect(out).toBe('A#0.0=x|A#0.1=y|B#1.0=z|');
    });
});

// ── R6 include 隔离 ──────────────────────────────────────────────────

describe('R6 include：参数显式传递，动态作用域不继承', () => {
    const files = {
        './a.md': '<A task="{{.task.title}}"><template :include="./b.md" task={{.task}} /></A>',
        './b.md': '<B><template :include="./c.md" item={{.task.item}} /></B>',
        './c.md': '<C item="{{.item}}" />',
    };

    it('三层调用：每层只看到自己拿到的参数（A→B→C，C 看不到 A 的 .task 全部）', () => {
        const out = render(
            '<template :include="./a.md" task={{diy.task}} />',
            { globals: { diy: { task: { title: 'T', item: 'I' } } } },
            { resolver: resolverOf(files) },
        );
        expect(out).toBe('<A task="T"><B><C item="I" /></B></A>');
    });

    it('子模版看不到调用者的动态变量（隔离而非继承）', () => {
        const err = caught(() =>
            render(
                '<template :for={{diy.list}} :as="t"><template :include="./child.md" /></template>',
                { globals: { diy: { list: [1] } } },
                { resolver: resolverOf({ './child.md': '{{.t.value}}' }) },
            ),
        );
        // 先被「少传参数」静态预检拦下
        expect(err.code).toBe('missing-arg');
        expect(err.detail).toContain('.t');
    });

    it('globals 在 include 里继续可见（只有动态作用域被隔离）', () => {
        const out = render(
            include('./child.md'),
            { globals: { diy: { cli: '/repo/diy.sh' } } },
            { resolver: resolverOf({ './child.md': 'CLI={{diy.cli}}' }) },
        );
        expect(out).toBe('CLI=/repo/diy.sh');
    });
});

// ── R7/R8 include 解析规则 ───────────────────────────────────────────

describe('R7/R8 include 解析：注册表白名单 + 循环 + 深度 + 锁定', () => {
    it('不在白名单（resolver 返回 null）→ 报错，而不是静默空', () => {
        const err = caught(() => render(include('./nope.md'), {}, { resolver: resolverOf({}) }));
        expect(err.code).toBe('include');
        expect(err.message).toContain('不在白名单');
    });

    it('路径必须是 ./ 开头且不含 ..（穿越尝试直接拒绝）', () => {
        expect(caught(() => render(include('../secret.md'), {})).message).toContain('include');
        expect(caught(() => render(include('/etc/passwd'), {})).message).toContain('include');
    });

    it('循环引用 → 报错并给出完整链', () => {
        const err = caught(() =>
            render(include('./a.md'), {}, {
                resolver: resolverOf({ './a.md': include('./b.md'), './b.md': include('./a.md') }),
            }),
        );
        expect(err.code).toBe('include-cycle');
        expect(err.detail).toContain('./a.md → ./b.md → ./a.md');
    });

    it('深度超限 → 报错（默认 8 层）', () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 12; i++) files[`./l${i}.md`] = include(`./l${i + 1}.md`);
        files['./l12.md'] = 'end';
        const err = caught(() => render(include('./l0.md'), {}, { resolver: resolverOf(files) }));
        expect(err.code).toBe('depth');
    });

    it('锁定模版不可被可覆盖模版 include，但锁定入口可以 include 它', () => {
        const files = { './_guard.md': { source: '禁止杀宿主进程', locked: true } };
        expect(caught(() => render(include('./_guard.md'), {}, { resolver: resolverOf(files) })).code).toBe('locked');
        expect(render(include('./_guard.md'), {}, { resolver: resolverOf(files), locked: true })).toBe('禁止杀宿主进程');
    });
});

// ── R9 不静默 ────────────────────────────────────────────────────────

describe('R9 错误不静默：全部带行列与原因', () => {
    it('globals 名字写错 → 报错（不是输出空串）', () => {
        const err = caught(() => render('入口 {{diy.clii}}\n', { globals: { diy: { cli: 'x' } } }));
        expect(err.code).toBe('missing-value');
        expect(err.file).toBe('<entry>');
        // 报错信息里带上写错的那个路径（区别于「未声明」）
        expect(err.message).toContain('diy.clii');
    });

    it('首段未声明 → unresolved-path，detail 列出可用 namespace', () => {
        const err = caught(() => render('{{diyx.cli}}', { globals: { diy: { cli: 'x' } } }));
        expect(err.code).toBe('unresolved-path');
        expect(err.detail).toContain('diy');
    });

    it('动态变量未声明 → 报错，detail 列出当前作用域可用名', () => {
        const err = caught(() =>
            render(
                '<template :include="./c.md" task={{diy.task}} />',
                { globals: { diy: { task: 1 } } },
                { resolver: resolverOf({ './c.md': '<C>{{.taskx}}</C>' }) },
            ),
        );
        expect(err.code).toBe('missing-arg');
        expect(err.message).toContain('taskx');
    });

    it('include 参数拼错（:iff）→ unknown-arg（这正是我们最怕的静默类错误）', () => {
        // 普通标签上的控制属性是"文本"，不报错但会被 lint 抓住（否则会原样漏进提示词）
        const linted = analyze('<enabled :iff="diy.on">true</enabled>');
        expect(linted.lint).toHaveLength(1);
        expect(linted.lint[0]!.message).toContain(':iff');
        const err2 = caught(() =>
            render('<template :include="./x.md" iff="diy.on" note="diy.note" />', { globals: { diy: { on: 1, note: 'n' } } }, {
                resolver: resolverOf({ './x.md': '{{.note}}' }),
            }),
        );
        expect(err2.code).toBe('unknown-arg');
        expect(err2.detail).toContain('note');
    });

    it('条件里写表达式 → 语法错并指出位置（阶段 1 明确不支持表达式）', () => {
        // 含空格的表达式必须用引号包起来（裸值在空格处结束）
        const err = caught(() => render('<template :if="{{diy.a == 1}}">x</template>', { globals: { diy: { a: 1 } } }));
        expect(err.code).toBe('syntax');
        expect(err.line).toBe(1);
        expect(err.message).toContain('不支持表达式');
    });

    it('插值取到 undefined → missing-value（可选值必须用 :if 守住）', () => {
        const err = caught(() => render('{{diy.optional}}', { globals: { diy: {} } }));
        expect(err.code).toBe('missing-value');
    });

    it(':for 的数据源不是数组 → not-iterable', () => {
        const err = caught(() =>
            render('<template :for={{diy.obj}} :as="x">{{.x.value}}</template>', { globals: { diy: { obj: { a: 1 } } } }),
        );
        expect(err.code).toBe('not-iterable');
    });
});

// ── R10 静态分析 ─────────────────────────────────────────────────────

describe('R10 静态分析：引用清单（UI「变量 view」的数据源）', () => {
    it('列出 globals / 动态 / include / 条件 / 循环', () => {
        const src = block(`
            入口 {{diy.cli}}
            <template :if={{diy.hasSkills}}>
            <template :for={{diy.skills}} :as="s">{{.s.value}}@{{.s.index}}</template>
            </template>
            <template :include="./_chain.md" path={{diy.home}} content={{diy.note}} />
        `);
        const a = analyze(src, { file: 'system.md' });
        expect(a.globals).toEqual(['diy']);
        expect(a.paths.map((p) => p.path)).toContain('diy.hasSkills');
        expect(a.conditions).toEqual([{ path: 'diy.hasSkills', negate: false, loc: expect.anything() }]);
        expect(a.loops.map((l) => `${l.as} in ${l.source}`)).toEqual(['s in diy.skills']);
        expect(a.includes.map((i) => i.relpath)).toEqual(['./_chain.md']);
        expect(a.includes[0]!.args.map((x) => x.name)).toEqual(['path', 'content']);
        // 定位到行：条件在模版的第 2 行
        expect(a.conditions[0]!.loc.line).toBe(2);
    });

    it('分析不需要任何数据，也不渲染（模版里写错也照样给出清单）', () => {
        const a = analyze('{{diy.cli}} {{.unknown}}');
        expect(a.globals).toEqual(['diy']);
        expect(a.dynamics).toEqual(['unknown']);
    });
});

// ── R11 结构 trace ───────────────────────────────────────────────────

describe('R11 结构 trace：节点字节数 + 参数/值 + 每个 :if 的真假与原因（试验场「结构树」）', () => {
    it('给出 include 的字节数与名字', () => {
        const fragment = block(`
            <project_instructions path="{{.path}}">{{.content}}</project_instructions>
        `);
        const { text, trace } = renderWithTrace(
            include('./_chain.md', ' path={{diy.p}} content={{diy.c}}'),
            { globals: { diy: { p: '/a/AGENTS.md', c: '规则' } } },
            { resolver: resolverOf({ './_chain.md': fragment }), file: 'system.md' },
        );
        expect(text).toBe('<project_instructions path="/a/AGENTS.md">规则</project_instructions>');
        const inc = trace.find((t) => t.kind === 'include')!;
        expect(inc.name).toBe('include');
        expect(inc.arg).toBe('./_chain.md'); // 参数 = 模版里写的 relpath
        expect(inc.bytes).toBe(Buffer.byteLength(text, 'utf-8'));
    });

    it('每个节点都区分「参数」（模版里写的）与「值」（求值结果）', () => {
        const { trace } = renderWithTrace(
            [
                'A',
                '<template :if-not={{diy.off}}>',
                '{{diy.cli}}',
                '</template>',
                '<template :for={{diy.list}} :as="f">{{.f.value}}</template>',
            ].join('\n'),
            { globals: { diy: { off: false, cli: '/repo/diy.sh', list: ['x', 'y'] } } },
        );
        const flat: TraceNode[] = [];
        const walk = (ns: TraceNode[]): void => {
            for (const n of ns) {
                flat.push(n);
                walk(n.children ?? []);
            }
        };
        walk(trace);

        const ifNode = flat.find((t) => t.kind === 'if')!;
        expect([ifNode.name, ifNode.arg, ifNode.value, ifNode.result]).toEqual([':if-not', 'diy.off', 'false', true]);

        const interp = flat.find((t) => t.kind === 'interp')!;
        expect([interp.name, interp.arg, interp.value]).toEqual(['插值', 'diy.cli', '/repo/diy.sh']);

        const forNode = flat.find((t) => t.kind === 'for')!;
        expect([forNode.name, forNode.arg, forNode.value]).toEqual([':for', 'diy.list :as="f"', '数组 · 2 项']);
        expect(forNode.children!.map((c) => [c.arg, c.value])).toEqual([
            ['f[0]', 'x'],
            ['f[1]', 'y'],
        ]);
        // 文本节点的参数就是它产出的字面量（换行显示为 ⏎）
        expect(flat.find((t) => t.kind === 'text')!.arg).toBe('A⏎');
    });

    it('值列是单行紧凑文本：多行折叠、长文本截断、集合只给摘要', () => {
        expect(previewValue('a\nb\tc')).toBe('a⏎b c');
        expect(previewValue('x'.repeat(80), 10)).toBe('xxxxxxxxxx…');
        expect(previewValue([])).toBe('空数组');
        expect(previewValue({ a: 1, b: 2 })).toBe('对象 · a, b');
        expect(previewValue(undefined)).toBe('未定义');
    });

    it('回答「这个 :if 为什么没进」：空数组 / 空串 / false 各有原因', () => {
        const { trace } = renderWithTrace(
            '<template :if={{diy.skills}}>技能</template><template :if={{diy.note}}>说明</template>',
            { globals: { diy: { skills: [], note: 'x' } } },
        );
        const ifs = trace.filter((t) => t.kind === 'if');
        expect(ifs[0]!.result).toBe(false);
        expect(ifs[0]!.reason).toContain('空数组');
        expect(ifs[1]!.result).toBe(true);
        expect(ifs[1]!.reason).toBe('值为真');
    });
});

// ── R12 装配形态 ─────────────────────────────────────────────────────

describe('R12 装配形态：节的标签/顺序/分隔都在模版里（代码不再拼装）', () => {
    /**
     * 节模版自带末尾空行、末节不带 —— 这是拍板的「分隔符方案」：
     * 被 :if 跳过的节才能零残留（实测「布局空行」会多一个空行）。
     */
    const identity = block(`
        你是 diy 管控台的本地 coding agent，在用户的任务里干活。
    `);
    const diySection = block(`
        <diy>
        diy 是 Electron 桌面管控台。入口 {{diy.cli}}。
        </diy>
    `);
    const skillsSection = block(`
        <skills>
        <template :for={{.list}} :as="s">{{.s.value}}
        </template></skills>
    `);
    const guard = block(`
        禁止执行会杀死宿主进程的命令。
    `);
    const files: Record<string, IncludeTarget | string> = {
        './000-identity.md': identity + '\n\n',
        './100-diy.md': diySection + '\n\n',
        './500-skills.md': skillsSection + '\n\n',
        './_guard.md': { source: `${guard}\n`, locked: true },
    };
    // 布局只列顺序（控制标签之间的换行也会进输出，所以拼成一行）
    const system =
        include('./000-identity.md') +
        include('./100-diy.md') +
        include('./500-skills.md', ' :if={{diy.skills}} list={{diy.skills}}') +
        include('./_guard.md');

    it('skills 为空时整节不出现且零残留；有技能时出现在原位置', () => {
        const empty = render(
            system,
            { globals: { diy: { cli: '/repo/diy.sh', skills: [] } } },
            { resolver: resolverOf(files), file: 'system.md', locked: true },
        );
        const diyRendered = block(`
            <diy>
            diy 是 Electron 桌面管控台。入口 /repo/diy.sh。
            </diy>
        `);
        expect(empty).toBe(`${identity}\n\n${diyRendered}\n\n${guard}\n`);

        const withSkills = render(
            system,
            { globals: { diy: { cli: '/repo/diy.sh', skills: ['a', 'b'] } } },
            { resolver: resolverOf(files), file: 'system.md', locked: true },
        );
        const skillsRendered = block(`
            <skills>
            a
            b
            </skills>
        `);
        expect(withSkills).toContain(`${skillsRendered}\n\n`);
        expect(withSkills.indexOf('<skills>')).toBeLessThan(withSkills.indexOf('禁止执行'));
    });

    it('片段模版（只被引用的模版）不参与自动拼接：只有被 include 才渲染', () => {
        const resolver = resolverOf({ './_chain.md': { source: '<pi path="{{.path}}">{{.content}}</pi>' } });
        // 直接渲染入口时，fragment 不会自己出现
        expect(render('正文\n', {}, { resolver, file: 'system.md' })).toBe('正文\n');
        // include 才出现
        expect(
            render(include('./_chain.md', ' path={{diy.p}} content={{diy.c}}'), { globals: { diy: { p: 'p', c: 'c' } } }, {
                resolver,
            }),
        ).toBe('<pi path="p">c</pi>');
    });
});

// ── R13 控制标记不占空间（standalone 默认开） ────────────────────────

describe('R13 控制标记不占空间（standalone 默认开，无开关）', () => {
    it('内联：条件为假时，标记自身不留下任何字符（a<if>…</if>b → ab）', () => {
        const G = { globals: { diy: { off: false, on: true } } };
        expect(render('a<template :if={{diy.off}}></template>b', G)).toBe('ab');
        expect(render('a<template :if={{diy.off}}>X</template>b', G)).toBe('ab');
        expect(render('a<template :if={{diy.on}}>X</template>b', G)).toBe('aXb');
    });

    it('行级：独占一行的控制标记，连同它那一行的缩进与换行都不产出', () => {
        const src = [
            'A',
            '    <template :if={{diy.off}}>',
            '</template>',
            'B',
        ].join('\n');
        expect(render(src, { globals: { diy: { off: false } } })).toBe('A\nB');
        // 条件成立时也一样（标记本身不产出内容）
        expect(render(src, { globals: { diy: { off: true } } })).toBe('A\nB');
    });

    it('include 独占一行 → 该行不产出，所以布局可以"每行一个 include"地写', () => {
        const files = { './a.md': 'X\n' };
        const src = ['A', '<template :include="./a.md"/>', 'B'].join('\n');
        expect(render(src, {}, { resolver: resolverOf(files) })).toBe('A\nX\nB');
    });

    it('被跳过的节零残留：节自带末尾空行 + 每行一个 include（对比：不开 standalone 会多空行）', () => {
        const files = {
            './a.md': 'A\n\n',
            './c.md': '<skills>\nC\n</skills>\n\n',
            './d.md': '<guard>\nD\n</guard>\n',
        };
        const layout = [
            '<template :include="./a.md"/>',
            '<template :include="./c.md" :if={{diy.skills}}/>',
            '<template :include="./d.md"/>',
        ].join('\n');
        expect(render(layout, { globals: { diy: { skills: [] } } }, { resolver: resolverOf(files) })).toBe(
            'A\n\n<guard>\nD\n</guard>\n',
        );
        expect(render(layout, { globals: { diy: { skills: ['x'] } } }, { resolver: resolverOf(files) })).toBe(
            'A\n\n<skills>\nC\n</skills>\n\n<guard>\nD\n</guard>\n',
        );
    });

    it('注释 {{/* … */}} 不产出字符；独占一行时该行不产出；未闭合报错', () => {
        expect(render('a{{/* 说明 */}}b', {})).toBe('ab');
        expect(render(['A', '{{/* 为什么这么排 */}}', 'B'].join('\n'), {})).toBe('A\nB');
        expect(caught(() => render('a{{/* 没关', {})).code).toBe('syntax');
    });

    it('边界：带控制属性的"标签容器"会输出自身标签 → 它那一行照常保留（要整行消失就用 <template>）', () => {
        const src = '<item :if={{diy.on}}>x</item>\n';
        expect(render(src, { globals: { diy: { on: true } } })).toBe('<item>x</item>\n');
        expect(render(src, { globals: { diy: { on: false } } })).toBe('\n'); // 标签没了，行还在
        // 想让它整行消失 → 用纯标记包裹（<template> 不产出字符）
        const pure = '<template :if={{diy.on}}><item>x</item>\n</template>';
        expect(render(pure, { globals: { diy: { on: false } } })).toBe('');
        expect(render(pure, { globals: { diy: { on: true } } })).toBe('<item>x</item>\n');
    });
});

describe('R14 属性值只有两种形态（引号不是语法，{{}} 才是求值点）', () => {
    const G = {
        globals: {
            skills: [
                { name: 'a', desc: 'A' },
                { name: 'b', desc: 'B' },
            ],
            n: 2,
        },
    };

    it('整值单个插值 = 表达式：集合**不被字符串化**，原样传进 include', () => {
        const files = { './list.md': '<template :for={{.items}} :as="s">- {{.s.value.name}}\n</template>' };
        const out = render('<template :include="./list.md" items={{skills}}/>', G, { resolver: resolverOf(files) });
        expect(out).toBe('- a\n- b\n');
    });

    it('字符串字面量 vs 混合文本 vs 数字（文本一律字符串化，单插值保留类型）', () => {
        const files = { './t.md': '[{{.title}}][{{.count}}]' };
        const r = (attrs: string, ctx: typeof G = G) =>
            render(`<template :include="./t.md" ${attrs}/>`, ctx, { resolver: resolverOf(files) });
        expect(r('title="技能清单" count={{n}}')).toBe('[技能清单][2]');
        expect(r('title="共 {{n}} 项" count={{n}}')).toBe('[共 2 项][2]');
    });

    it('引号与裸值语义等价（引号只是边界）', () => {
        expect(render('<x :if={{n}}>y</x>', G)).toBe('<x>y</x>');
        expect(render('<x :if="{{n}}">y</x>', G)).toBe('<x>y</x>');
    });

    it('裸值里插值后跟内容 → 报错（要求引号），不静默截断', () => {
        const e = caught(() => render('<x :if={{n}}b>y</x>', G));
        expect(e.code).toBe('syntax');
        expect(e.message).toContain('引号');
    });

    it('两条 lint 提示：单插值别加引号；参数值像路径但是字面量（老写法的静默陷阱）', () => {
        const a = analyze('<x :if="{{n}}">y</x>');
        expect(a.lint.some((l) => l.message.includes('更清楚'))).toBe(true);
        // 迁移提示是"机械地把字面量包进 {{}}"（不推断语义，所以这里给完整路径）
        const b = analyze('<template :include="./a.md" path=".f.value.path"/>');
        const hit = b.lint.find((l) => l.message.includes('字面量字符串'));
        expect(hit?.message).toContain('path={{.f.value.path}}');
    });
});

describe('R15 变量契约（宿主声明类型/说明 → 静态校验）', () => {
    const VARS = [
        { path: 'diy.cli', type: 'string' as const, desc: '命令行入口' },
        { path: 'skills', type: 'array' as const, desc: '技能清单' },
        { path: 'task.body', type: 'string' as const },
        { path: 'diy.obj', type: 'object' as const },
    ];

    it('引用契约里没有的路径 → lint 提示（打错字不必等渲染）', () => {
        const a = analyze('用 {{diy.nope}} 试试', { vars: VARS });
        expect(a.lint.some((l) => l.message.includes('契约里没有这个变量：diy.nope'))).toBe(true);
    });

    it(':for 的源必须是数组；标量当源 → lint', () => {
        expect(analyze('<template :for={{diy.cli}} :as="x">{{.x.value}}</template>', { vars: VARS }).lint.some((l) => l.message.includes('必须是数组'))).toBe(true);
        // 合法用法不报
        expect(analyze('<template :for={{skills}} :as="s">{{.s.value}}</template>', { vars: VARS }).lint).toHaveLength(0);
    });

    it('插值只能是标量：集合/对象 → lint；但作为条件/循环源/include 参数是合法的', () => {
        expect(analyze('{{skills}}', { vars: VARS }).lint.some((l) => l.message.includes('是数组'))).toBe(true);
        expect(analyze('{{diy.obj}}', { vars: VARS }).lint.some((l) => l.message.includes('是对象'))).toBe(true);
        // 同一路径用在 :if / :for / include 参数上 → 不报
        expect(analyze('<template :if={{skills}}>x</template>', { vars: VARS }).lint).toHaveLength(0);
        expect(
            analyze('<template :include="./a.md" list={{skills}}/>', { vars: VARS }).lint,
        ).toHaveLength(0);
    });

    it('不给契约就不做类型校验（向后兼容）', () => {
        expect(analyze('{{skills}}').lint).toHaveLength(0);
    });
});
