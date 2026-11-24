// ActiveGlyphs —— 标题栏的全实例活动入口：空闲时也必须可见且可辨认。

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ActiveJobsGlyph, ActiveSessionsGlyph } from '../src/components/ActiveGlyphs';

describe('标题栏活动指示器', () => {
    it('空闲时仍显示会话与后台任务名称及 0，不退化成两个无标签图标', () => {
        const sessions = renderToStaticMarkup(<ActiveSessionsGlyph />);
        const jobs = renderToStaticMarkup(<ActiveJobsGlyph />);

        expect(sessions).toContain('会话');
        expect(sessions).toContain('>0</span>');
        expect(jobs).toContain('后台任务');
        expect(jobs).toContain('>0</span>');
    });
});
