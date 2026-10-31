import { describe, expect, it } from 'vitest';
import { BAR_HTML, barDataUrl } from '../bar.js';

describe('横条页（本地 data: 页）', () => {
    it('是 data: URL（不依赖任何本地文件 / 远程资源）', () => {
        const url = barDataUrl();
        expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true);
        expect(decodeURIComponent(url.slice('data:text/html;charset=utf-8,'.length))).toBe(BAR_HTML);
    });

    it("CSP 收紧到 'none'：横条不需要外部资源（也不给远程留口子）", () => {
        expect(BAR_HTML).toContain("default-src 'none'");
        expect(BAR_HTML).not.toMatch(/<script[^>]+src=/);
        expect(BAR_HTML).not.toMatch(/<link[^>]+href=/);
        expect(BAR_HTML).not.toMatch(/<img[^>]+src=/);
    });

    it('有画横条需要的锚点（当前实例 / 列表 / 连接输入 / 刷新）', () => {
        for (const id of [
            'bar',
            'current',
            'current-dot',
            'current-name',
            'current-label',
            'instances',
            'add',
            'endpoint',
            'refresh',
        ]) {
            expect(BAR_HTML).toContain(`data-testid="${id}"`);
        }
    });

    it('只调桥上的四个方法，且**没有**确认 / 拦截（硬规则二）', () => {
        expect(BAR_HTML).toContain('window.diyBar');
        for (const method of ['connect(', 'getState(', 'refresh(', 'onState(']) {
            expect(BAR_HTML).toContain(`api.${method}`);
        }
        expect(BAR_HTML).not.toContain('confirm(');
        expect(BAR_HTML).not.toContain('alert(');
    });

    it('显示人读地址而不是 URL（##484 判据 4）', () => {
        // 当前实例：address 优先，拿不到才退回显示名
        expect(BAR_HTML).toContain('current.address || current.displayName');
        // 列表：address → displayName → endpoint 三级兜底
        expect(BAR_HTML).toContain('item.address || item.displayName || item.endpoint');
        // 悬停同时给地址与 endpoint（地址给人看，endpoint 才是程序连的）
        expect(BAR_HTML).toContain('item.address ? item.address + " · " : ""');
    });

    it('状态色三档：连上 / 连接中 / 断线（断线整条变红）', () => {
        expect(BAR_HTML).toContain('#bar[data-status="disconnected"]');
        expect(BAR_HTML).toContain('#f85149');
        expect(BAR_HTML).toContain('#bar[data-status="connecting"]');
    });
});
