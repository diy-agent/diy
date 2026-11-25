// stop-scenarios.test.ts —— 锁住判据与样本的对应关系。
//
// 这个测试存在的理由：lab 页（`/stops.html`）拿的是**同一批**样本。判据一改、样本没跟上，
// 页面会照旧"看着挺对"地渲染出错误的结论 —— 所以要在 CI 里先红。
// 断言只锁 `type` / `note`：文案允许改，类别不许漂。

import { describe, expect, it } from 'vitest';

import { endReasonOf } from '../src/end-reason';
import { factsOf, replay, STOP_SCENARIOS } from '../src/stop-scenarios';

describe('停止场景样本', () => {
    it('每条样本的判定与它声明的类别一致', () => {
        const wrong = STOP_SCENARIOS.map((scenario) => ({ scenario, replay: replay(scenario) }))
            .filter(({ scenario, replay: result }) => result.reason.type !== scenario.expect)
            .map(
                ({ scenario, replay: result }) => `${scenario.id}: 期望 ${scenario.expect}，实得 ${result.reason.type}`,
            );
        expect(wrong).toEqual([]);
    });

    it('声明了细因的样本，细因也对得上', () => {
        const wrong = STOP_SCENARIOS.filter((scenario) => scenario.expectNote !== undefined)
            .filter((scenario) => replay(scenario).reason.note !== scenario.expectNote)
            .map(
                (scenario) => `${scenario.id}: 期望 note=${scenario.expectNote}，实得 ${replay(scenario).reason.note}`,
            );
        expect(wrong).toEqual([]);
    });

    it('id 唯一（lab 页拿它做路由与锚点）', () => {
        const ids = STOP_SCENARIOS.map((scenario) => scenario.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('「未知」一定被当失败处理，且「截断」一定不是完成', () => {
        for (const scenario of STOP_SCENARIOS) {
            const result = replay(scenario);
            if (result.reason.type === 'unknown') expect(result.publishable).toBe(false);
            if (result.reason.type === 'max-tokens') expect(result.publishable).toBe(false);
        }
    });

    it('只有 completed 允许把产出当结论发到房间', () => {
        const publishableIds = STOP_SCENARIOS.filter((scenario) => replay(scenario).publishable).map(
            (scenario) => scenario.id,
        );
        // 现阶段只有两条样本是「正常说完」；判据是 completed → 可发布，不是按 id 白名单
        expect(publishableIds).toEqual(['completed', 'tool-error-but-finished']);
    });

    it('修复前对照：截断 / 断流 / 空产出全都被当成「完成」', () => {
        const legacySaysDone = ['max-tokens', 'thread-cut', 'empty-output', 'weird-finish', 'tool-mismatch'];
        for (const id of legacySaysDone) {
            const scenario = STOP_SCENARIOS.find((item) => item.id === id);
            expect(scenario, id).toBeDefined();
            expect(replay(scenario!).legacy.label, id).toBe('完成');
        }
    });

    it('「怎么停的」看得见：需要解释的类别都落了条目', () => {
        for (const scenario of STOP_SCENARIOS) {
            const result = replay(scenario);
            const explained = result.items.some((item) => item.type === 'notice' || item.type === 'error');
            const silent = result.reason.type === 'completed' || result.reason.type === 'interrupted';
            expect(explained, scenario.id).toBe(!silent);
        }
    });

    it('没收尾信号就是 unknown，不是 completed（判据的直接约束）', () => {
        const facts = factsOf(STOP_SCENARIOS.find((scenario) => scenario.id === 'thread-cut')!);
        expect(facts.finished).toBe(false);
        expect(endReasonOf(facts).type).toBe('unknown');
    });

    it('上游静默：带 stall 的 run.failed 判成 stalled，只出一条 notice（超时不是出错）', () => {
        const scenario = STOP_SCENARIOS.find((item) => item.id === 'upstream-stall');
        expect(scenario).toBeDefined();
        const result = replay(scenario!);
        expect(result.reason.type).toBe('stalled');
        // 卡在哪个时段 / 等了多久：由杀它的那一层带上来
        expect(result.reason.awaiting).toBe('model-stream');
        expect(result.reason.idleMs).toBe(180_000);
        // 同一件事不说两遍：不落 error 条目，只落一条 stalled notice
        expect(result.items.some((item) => item.type === 'error')).toBe(false);
        expect(result.items.some((item) => item.type === 'notice' && item.data.kind === 'stalled')).toBe(true);
    });

    it('工具没结果时不留转圈的条目（tool 段必须收成 failed）', () => {
        const scenario = STOP_SCENARIOS.find((item) => item.id === 'tool-mismatch')!;
        const tools = replay(scenario).items.filter((item) => item.type === 'tool');
        expect(tools).toHaveLength(1);
        expect(tools[0]?.status).toBe('failed');
    });
});
