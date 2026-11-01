import { describe, expect, it } from 'vitest';
import { BAR_HTML, BAR_HTML_HEIGHT_HINT, barDataUrl } from '../bar.js';
import { BAR_HEIGHT } from '../index.js';

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

    it('有画横条需要的锚点（tab 条 / 断线原因 / 连接输入 / 刷新）', () => {
        for (const id of ['bar', 'tabs', 'detail', 'add', 'endpoint', 'refresh']) {
            expect(BAR_HTML).toContain(`data-testid="${id}"`);
        }
        // tab 是脚本里一个个建出来的
        expect(BAR_HTML).toContain('setAttribute("data-testid", "tab")');
    });

    it('**没有**左侧「当前连接」区（##493 判据 1：当前只在 tab 里出现一次）', () => {
        expect(BAR_HTML).not.toContain('data-testid="current"');
        expect(BAR_HTML).not.toContain('id="current"');
        expect(BAR_HTML).not.toContain('current-dot');
        expect(BAR_HTML).not.toContain('current-name');
        // 候选列表也合并进了 tab 条
        expect(BAR_HTML).not.toContain('data-testid="instances"');
    });

    it('只调桥上的四个方法，且**没有**确认 / 拦截（硬规则二）', () => {
        expect(BAR_HTML).toContain('window.diyBar');
        for (const method of ['connect(', 'getState(', 'refresh(', 'onState(']) {
            expect(BAR_HTML).toContain(`api.${method}`);
        }
        expect(BAR_HTML).not.toContain('confirm(');
        expect(BAR_HTML).not.toContain('alert(');
    });

    it('tab 上只放短名，悬停才是全名（##493 判据 4）', () => {
        // 标签由主进程算好（buildTabs），横条只管画 tab.label / tab.title
        expect(BAR_HTML).toContain('name.textContent = tab.label');
        expect(BAR_HTML).toContain('button.title = tab.title');
        expect(BAR_HTML).toContain('dot.textContent = tab.dot');
    });

    it('当前 tab 的高亮只用背景（不叠下划线）', () => {
        expect(BAR_HTML).toContain('.tab[data-active="1"] { background: #30363d;');
        expect(BAR_HTML).not.toContain('text-decoration');
        expect(BAR_HTML).not.toContain('border-bottom: 2px');
    });

    it('状态色三档：连上 / 连接中或断线 / 未连（断线整条变红）', () => {
        expect(BAR_HTML).toContain('.tab[data-status="connected"] .dot { color: #3fb950; }');
        expect(BAR_HTML).toContain('.tab[data-status="connecting"] .dot { color: #d29922; }');
        expect(BAR_HTML).toContain('.tab[data-status="idle"] .dot { color: #8b949e; }');
        expect(BAR_HTML).toContain('#bar[data-status="disconnected"]');
        expect(BAR_HTML).toContain('#f85149');
    });

    it('横条高度仍是 32px（tab 不把横条撑高）', () => {
        expect(BAR_HTML_HEIGHT_HINT).toBe(BAR_HEIGHT);
        expect(BAR_HTML).toContain('#bar {');
        expect(BAR_HTML).toContain('height: 100%; box-sizing: border-box;');
        // tab 自己定高（24px < 32px），不靠内容撑
        expect(BAR_HTML).toContain('height: 24px;');
    });
});
