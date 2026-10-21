import { describe, expect, it } from 'vitest';
import { pathCovers, scopeKey, scopeMatches, scopeSpecificity } from '../src/scope';

describe('scope 三轴匹配', () => {
    it('路径前缀按段边界，不做裸 startsWith', () => {
        expect(pathCovers('src/aa', 'src/aa/b.ts')).toBe(true);
        expect(pathCovers('src/aa', 'src/aa')).toBe(true);
        expect(pathCovers('src/aa', 'src/aaa/b.ts')).toBe(false);
        expect(pathCovers('src/aa/', 'src/aa/b.ts')).toBe(true);
    });

    it('未声明 scope 的全局事实在任何上下文都匹配', () => {
        expect(scopeMatches(undefined, {})).toBe(true);
        expect(scopeMatches(undefined, { env: 'test' })).toBe(true);
    });

    it('env 轴是子集判定：数组声明覆盖多个环境', () => {
        expect(scopeMatches({ env: ['development', 'test'] }, { env: 'test' })).toBe(true);
        expect(scopeMatches({ env: 'production' }, { env: 'test' })).toBe(false);
        // ctx 没声明 env ⇒ env-scoped 事实不匹配（宁可查不到，也不要误用别环境的结论）
        expect(scopeMatches({ env: 'production' }, {})).toBe(false);
    });

    it('path-scoped 事实在纯 env 上下文里查不到', () => {
        expect(scopeMatches({ paths: ['pkgs.ts/diy-app/tests'] }, { env: 'test' })).toBe(false);
        expect(scopeMatches({ paths: ['pkgs.ts/diy-app/tests'] }, { paths: ['pkgs.ts/diy-app/tests/a.test.ts'] })).toBe(
            true,
        );
    });

    it('scopeKey 归一：数组顺序无关，轴序固定', () => {
        expect(scopeKey({ env: ['test', 'development'] })).toBe(scopeKey({ env: ['development', 'test'] }));
        expect(scopeKey(undefined)).toBe('');
    });

    it('特定度 = 声明的轴数（多轴者优先）', () => {
        expect(scopeSpecificity(undefined)).toBe(0);
        expect(scopeSpecificity({ env: 'test' })).toBe(1);
        expect(scopeSpecificity({ env: 'test', paths: ['a'] })).toBe(2);
    });
});
