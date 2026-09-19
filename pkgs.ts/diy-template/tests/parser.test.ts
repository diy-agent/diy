// tests/parser.test.ts — 词法/语法边界（意图测试之外的「实现契约」单测）
//
// 这里只测两类东西：
//   1. 逐字节语义的边界（CRLF、末尾换行、无值属性、注释样文本、<templateX>）
//   2. 报错是否**带位置**且**不静默**（未闭合、错配、非法绑定、非法控制属性）

import { describe, expect, it } from 'vitest';
import { TemplateError, parse, render } from '../src/index';

function code(fn: () => unknown): string {
    try {
        fn();
    } catch (e) {
        return e instanceof TemplateError ? e.code : `非 TemplateError: ${String(e)}`;
    }
    return '（没报错）';
}

describe('逐字节边界', () => {
    it('CRLF 原样保留（不做换行归一化）', () => {
        expect(render('a\r\nb\r\n', {})).toBe('a\r\nb\r\n');
    });

    it('无值属性原样输出（不补 =""）', () => {
        expect(render('<br disabled/>', {})).toBe('<br disabled/>');
        expect(render('<pi path="x" flag>x</pi>', {})).toBe('<pi path="x" flag>x</pi>');
    });

    it('自闭合元素原样输出', () => {
        expect(render('<hr/>', {})).toBe('<hr/>');
    });

    it('注释样文本被当普通文本透传（本引擎没有注释语法）', () => {
        expect(render('<!-- 说明 -->', {})).toBe('<!-- 说明 -->');
    });

    it('<templateX> 不是控制节点，是普通元素（只有 <template 后面跟空白/:/>/ 才是）', () => {
        expect(render('<templateX>hi</templateX>', {})).toBe('<templateX>hi</templateX>');
    });

    it('属性值统一用双引号输出（源里的单引号会被规范化）', () => {
        expect(render("<pi path='x'>y</pi>", {})).toBe('<pi path="x">y</pi>');
    });

    it(':omit-empty="true" 时内容为空的元素连标签一起省略', () => {
        const tpl = '<items :omit-empty="true"><template :for="x of diy.list">{{.x}}</template></items>';
        expect(render(tpl, { globals: { diy: { list: [] } } })).toBe('');
        expect(render(tpl, { globals: { diy: { list: ['a'] } } })).toBe('<items>a</items>');
    });
});

describe('语法错误（必须带行列，不静默）', () => {
    it('插值未闭合', () => {
        expect(code(() => parse('a {{diy.cli'))).toBe('syntax');
    });

    it('元素未闭合', () => {
        const e = (() => {
            try {
                parse('<diy>x');
            } catch (err) {
                return err as TemplateError;
            }
            return null;
        })()!;
        expect(e.code).toBe('syntax');
        expect(e.message).toContain('标签未闭合 <diy>');
    });

    it('结束标签错配', () => {
        expect(code(() => parse('<diy>x</task>'))).toBe('syntax');
    });

    it('多余的结束标签', () => {
        expect(code(() => parse('x</diy>'))).toBe('syntax');
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

    it('未知控制属性（:iff 这类拼错）→ 报错，不会静默当普通属性输出', () => {
        const e = (() => {
            try {
                parse('<enabled :iff="a">x</enabled>');
            } catch (err) {
                return err as TemplateError;
            }
            return null;
        })()!;
        expect(e.code).toBe('syntax');
        expect(e.message).toContain(':iff');
        expect(e.line).toBe(1);
        expect(e.col).toBeGreaterThan(1);
    });

    it(':include 只能用在 <template> 上', () => {
        expect(code(() => parse('<pi :include="./a.md" />'))).toBe('syntax');
    });

    it(':include 带子节点 → 报错', () => {
        expect(code(() => parse('<template :include="./a.md">x</template>'))).toBe('syntax');
    });

    it(':include 路径不是 ./ 开头 → include 错误', () => {
        expect(code(() => parse('<template :include="a.md" />'))).toBe('include');
        expect(code(() => parse('<template :include="../a.md" />'))).toBe('include');
    });

    it('插值路径非法（如 a..b / a[0]）→ 语法错', () => {
        expect(code(() => parse('{{a..b}}'))).toBe('syntax');
        expect(code(() => parse('{{a[0]}}'))).toBe('syntax');
    });

    it(':omit-empty 只接受 "true"', () => {
        expect(code(() => parse('<a :omit-empty="yes">x</a>'))).toBe('syntax');
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
