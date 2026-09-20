// tests/parser.test.ts — 词法/语法边界（意图测试之外的「实现契约」单测）
//
// 这里只测两类东西：
//   1. 逐字节语义的边界（CRLF、末尾换行、无值属性、注释样文本、<templateX>）
//   2. 报错是否**带位置**且**不静默**（未闭合、错配、非法绑定、非法控制属性）

import { describe, expect, it } from 'vitest';
import { TemplateError, analyze, parse, render } from '../src/index';

function code(fn: () => unknown): string {
    try {
        fn();
    } catch (e) {
        return e instanceof TemplateError ? e.code : `非 TemplateError: ${String(e)}`;
    }
    return '（没报错）';
}

describe('逐字节边界（输出标签也是文本）', () => {
    it('CRLF 原样保留（不做换行归一化）', () => {
        expect(render('a\r\nb\r\n', {})).toBe('a\r\nb\r\n');
    });

    it('输出标签的属性、引号、空白原样（不解析、不规范化）', () => {
        expect(render("<pi path='x'  flag >y</pi>", {})).toBe("<pi path='x'  flag >y</pi>");
        expect(render('<br disabled/>', {})).toBe('<br disabled/>');
        expect(render('<project_instructions path="{{p}}">x</project_instructions>', { globals: { p: 'P' } })).toBe(
            '<project_instructions path="P">x</project_instructions>',
        );
    });

    it('未闭合 / 错配的输出标签也只是文本（不再报错）', () => {
        expect(render('<diy>x', {})).toBe('<diy>x');
        expect(render('<diy>x</task>', {})).toBe('<diy>x</task>');
        expect(render('x</diy>', {})).toBe('x</diy>');
        expect(render('任务号 <pid> 是数字；a<b；vector<T>', {})).toBe('任务号 <pid> 是数字；a<b；vector<T>');
    });

    it('注释样文本、<templateX> 都原样透传', () => {
        expect(render('<!-- 说明 -->', {})).toBe('<!-- 说明 -->');
        expect(render('<templateX>hi</templateX>', {})).toBe('<templateX>hi</templateX>');
    });

    it('代码围栏 ``` 内一律不解析（{{}} 与 <template> 都是字面量）', () => {
        const src = ['```md', '把 {{diy.cli}} 写进 <template :if="x">…</template>', '```'].join('\n');
        expect(render(src, { globals: { diy: { cli: 'V' } } })).toBe(src);
    });
});

describe('控制标记的语法（唯一严格的部分）', () => {
    it('插值未闭合', () => {
        expect(code(() => parse('a {{diy.cli'))).toBe('syntax');
    });

    it('控制标签未闭合', () => {
        const e = (() => {
            try {
                parse('<template :if="diy.on">x');
            } catch (err) {
                return err as TemplateError;
            }
            return null;
        })()!;
        expect(e.code).toBe('syntax');
        expect(e.message).toContain('标签未闭合 <template>');
    });

    it('<raw> 未闭合', () => {
        expect(code(() => parse('<raw>没关'))).toBe('syntax');
    });

    it(':for 语法非法（缺 of）带修复提示', () => {
        const e = (() => {
            try {
                parse('<template :for="x">a</template>');
            } catch (err) {
                return err as TemplateError;
            }
            return null;
        })()!;
        expect(e.code).toBe('syntax');
        expect(e.detail).toContain(':for="item of 路径"');
    });

    it('未知控制属性（<template :iff>）→ 报错', () => {
        const e = (() => {
            try {
                parse('<template :iff="a">x</template>');
            } catch (err) {
                return err as TemplateError;
            }
            return null;
        })()!;
        expect(e.code).toBe('syntax');
        expect(e.message).toContain(':iff');
        expect(e.line).toBe(1);
    });

    it(':include 路径不是 ./ 开头 / 含 .. → include 错误', () => {
        expect(code(() => parse('<template :include="a.md" />'))).toBe('include');
        expect(code(() => parse('<template :include="../a.md" />'))).toBe('include');
    });

    it(':include 带子节点 → 报错', () => {
        expect(code(() => parse('<template :include="./a.md">x</template>'))).toBe('syntax');
    });

    it('插值路径非法（如 a..b / a[0]）→ 语法错', () => {
        expect(code(() => parse('{{a..b}}'))).toBe('syntax');
        expect(code(() => parse('{{a[0]}}'))).toBe('syntax');
    });
});

describe('误用体检（lint，不阻断渲染但要显式提示）', () => {
    it('控制属性写在普通标签上 → 提示改用 <template> 包裹（否则会原样漏进提示词）', () => {
        const a = analyze('<rules>\n<item :if="diy.strict">严格</item>\n</rules>');
        expect(a.lint).toHaveLength(1);
        expect(a.lint[0]!.message).toContain(':if');
        expect(a.lint[0]!.message).toContain('<template');
        expect(a.lint[0]!.loc.line).toBe(2);
    });

    it('写到 <template> 上就不算误用', () => {
        expect(analyze('<template :if="diy.strict">严格</template>').lint).toEqual([]);
    });
});

describe('作用域边界', () => {
    it('{{.}} 不在循环里 → unresolved-path', () => {
        expect(code(() => render('{{.}}', {}))).toBe('unresolved-path');
    });

    it('{{.index}} 不在循环里 → unresolved-path，提示需显式传参', () => {
        const e = (() => {
            try {
                render('{{.index}}', {});
            } catch (err) {
                return err as TemplateError;
            }
            return null;
        })()!;
        expect(e.code).toBe('unresolved-path');
        expect(e.message).toContain('include 内需显式传参');
    });

    it('首段用 Object.hasOwn 判定，原型链上的名字不算存在', () => {
        expect(code(() => render('{{constructor}}', { globals: {} }))).toBe('unresolved-path');
        expect(code(() => render('{{diy.toString}}', { globals: { diy: { cli: 'x' } } }))).toBe('missing-value');
    });

    it('对象被直接插值 → 序列化（并应尽量改用 :for 或取具体字段）', () => {
        expect(render('{{diy.obj}}', { globals: { diy: { obj: { a: 1 } } } })).toBe('{"a":1}');
    });
});
