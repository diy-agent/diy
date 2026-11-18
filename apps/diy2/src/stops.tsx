// stops.tsx —— 「这一轮是怎么停的」lab 页（/stops.html）
//
// 这个页面**不是示意**：每个场景的事件流都被喂给真 `Projector`、真判据
// （`entity-runtime/end-reason.ts`）与真时间线分组（`chat-core/timeline.ts`），
// 页面上显示的就是这套代码对那条流的实际处理结果。改判据 → 页面跟着变。
//
// 左栏「修复前」= 同一条流在旧逻辑下的下场（只分跑成/跑不成，没有收尾解释），
// 右边「现在」= 现在会落什么条目、用户看得到什么、该做什么。

import { buildTimeline, endFooterOf, type Item, type TimelineEntry, type TurnEndReason } from '@diy-agent/chat-core';
import {
    ROOM_SCENARIOS,
    replayRoom,
    type FooterExpectation,
    type RoomReplay,
} from '@diy-agent/entity-runtime/room-scenarios';
import { replay, STOP_SCENARIOS, type StopReplay } from '@diy-agent/entity-runtime/stop-scenarios';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import './stops.css';

type Tone = 'ok' | 'warn' | 'bad' | 'dim';

const TONE: Record<string, Tone> = {
    completed: 'ok',
    interrupted: 'dim',
    'max-tokens': 'warn',
    filtered: 'warn',
    'tool-mismatch': 'warn',
    unknown: 'bad',
    error: 'bad',
};

const JUDGE_TABLE: Array<{ when: string; verdict: string; why: string }> = [
    { when: '运行抛异常 / SDK 给 error part', verdict: 'error', why: '跑不成了，把失败原文给用户' },
    { when: '人按了停（abort）', verdict: 'interrupted', why: '人自己结束的，不需要动作' },
    { when: '没收到 run.finished', verdict: 'unknown · no-finish', why: '流被掐断 / 进程被杀 —— 没证据 ≠ 完成' },
    { when: "finishReason = 'length'", verdict: 'max-tokens', why: '模型没说完 → 说「继续」能接上' },
    { when: "finishReason = 'content-filter'", verdict: 'filtered', why: '被策略拦，续写会再被拦 → 换说法/换模型' },
    { when: "finishReason = 'tool-calls'", verdict: 'tool-mismatch', why: '工具结果没回来 → 补结果，不是续写' },
    { when: "finishReason = 'stop' 且有产出", verdict: 'completed', why: '唯一允许把产出当结论发到房间的情况' },
    { when: "finishReason = 'stop' 但 0 字 0 工具", verdict: 'unknown · empty-output', why: '可疑的静默停' },
    { when: '我们不认识的 finishReason', verdict: 'unknown · finish=xxx', why: '新词也得当未知，不能当成功' },
];

function reasonLabel(result: StopReplay): string {
    const reason = result.reason;
    if (reason.note !== undefined) return `${reason.type} · ${reason.note}`;
    if (reason.type === 'max-tokens') return `max-tokens · ${reason.maxOutputTokens ?? '?'}`;
    if (reason.finishReason !== undefined) return `${reason.type} · finish=${reason.finishReason}`;
    return reason.type;
}

function ToolRow({ part }: { part: Extract<TimelineEntry['parts'][number], { kind: 'tool' }> }) {
    const args = part.args === undefined ? '' : JSON.stringify(part.args);
    return (
        <div className="tool">
            <span className="name">{part.name}</span>
            <span className="args">{args.length > 64 ? `${args.slice(0, 64)}…` : args}</span>
            <span className={`state ${part.state}`}>
                {part.state === 'running' ? '还在转圈…' : part.state === 'ok' ? 'ok' : 'failed'}
            </span>
        </div>
    );
}

function Timeline({ items, endReasons }: { items: readonly Item[]; endReasons?: Record<string, TurnEndReason> }) {
    // 与真实 UI 同一条路：turn.end 事实 → buildTimeline 挂到该轮最后一段 → endFooterOf 出文案
    const entries = buildTimeline(items, [], {}, endReasons === undefined ? {} : { endReasons }).filter(
        (entry) => entry.kind !== 'user' && entry.kind !== 'typing',
    );
    if (entries.length === 0) return <p className="empty">（时间线上什么都不会多出来）</p>;

    return (
        <div className="tl">
            {entries.map((entry) => {
                if (entry.kind === 'notice' || entry.kind === 'error') {
                    return (
                        <div key={entry.key}>
                            <div className={`bar ${entry.kind}`}>
                                <span className="icon">{entry.kind === 'notice' ? '⚠' : '⛔'}</span>
                                <span>{entry.parts[0]?.kind === 'text' ? entry.parts[0].text : ''}</span>
                            </div>
                            {/* 这一轮没有 bot 消息时（空产出 / 直接失败），结局就挂在这条上 */}
                            <EndFooter reason={entry.endReason} />
                        </div>
                    );
                }
                return (
                    <div className="msg" key={entry.key}>
                        <div className="avatar">{entry.author?.name.slice(0, 1) ?? '?'}</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
                            {entry.parts.map((part, index) =>
                                part.kind === 'text' ? (
                                    <div className="bubble" key={index}>
                                        {part.text}
                                    </div>
                                ) : part.kind === 'tool' ? (
                                    <ToolRow key={part.id} part={part} />
                                ) : part.kind === 'error' ? (
                                    <div
                                        className="bubble"
                                        key={index}
                                        style={{ borderColor: '#b42318', color: '#b42318' }}
                                    >
                                        ⚠ {part.message}
                                    </div>
                                ) : null,
                            )}
                            {entry.streaming ? <span className="empty">…（这条还在流式，没被收尾）</span> : null}
                            <EndFooter reason={entry.endReason} />
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

function EndFooter({ reason }: { reason: TimelineEntry['endReason'] }) {
    const footer = endFooterOf(reason);
    if (footer === undefined) return null;
    return (
        <div className={`end-footer ${footer.tone}`} title={footer.detail ?? footer.label}>
            <span className="dot" />
            {footer.label}
        </div>
    );
}

function Card({ index, result }: { index: number; result: StopReplay }) {
    const scenario = result.scenario;
    const tone = TONE[result.reason.type] ?? 'dim';
    const selfChecked = result.reason.type === scenario.expect;

    return (
        <article className="card">
            <header>
                <span className="idx">{String(index + 1).padStart(2, '0')}</span>
                <h2>{scenario.title}</h2>
                {selfChecked ? null : (
                    <span className="chip chip-bad" title="判据与样本声明不一致 —— 页面或判据有 bug">
                        自检失败：期望 {scenario.expect}
                    </span>
                )}
                <span className={`chip chip-${tone}`}>{reasonLabel(result)}</span>
            </header>
            <p className="trigger">触发：{scenario.trigger}</p>

            <div className="cols">
                <section className="col before">
                    <h3>
                        修复前{' '}
                        <span className={`badge ${result.legacy.label === '完成' ? 'ok' : 'bad'}`}>
                            {result.legacy.label}
                        </span>
                    </h3>
                    <Timeline items={result.legacy.items} />
                </section>
                <section className="col">
                    <h3>
                        现在{' '}
                        <span className={`badge ${tone === 'dim' ? '' : tone}`}>
                            {result.reason.type === 'completed'
                                ? '完成'
                                : result.reason.type === 'interrupted'
                                  ? '已停止'
                                  : '说出来了'}
                        </span>
                    </h3>
                    <Timeline items={result.items} endReasons={{ 'turn-demo': result.reason }} />
                    <p className="advice">
                        <b>该做什么：</b>
                        {result.advice}
                        <br />
                        <b>能当结论发到房间吗：</b>
                        {result.publishable ? '能（只有 completed 能）' : '不能（只留在自己的时间线上）'}
                    </p>
                </section>
            </div>

            <details>
                <summary>原始事件流 + 判定事实（运行时真实发的顺序）</summary>
                <pre className="facts">{scenario.events.map((event) => JSON.stringify(event)).join('\n')}</pre>
                <pre>{JSON.stringify({ facts: result.facts, endReason: result.reason }, null, 2)}</pre>
            </details>
        </article>
    );
}

// ── 房间级场景 ───────────────────────────────────────────────────
//
// 单轮样本回答「这一轮为什么停」；这里回答「停法多了以后时间线会不会串」。
// 页脚位置**自检**：挂错位置和挂错内容一样糟（挂在半句话下面 / 挂两遍 / 挂到别人头上）。

interface Placement {
    turnId: string;
    on: FooterExpectation;
    actual: number;
    ok: boolean;
    detail: string;
}

function checkPlacement(result: RoomReplay, entries: TimelineEntry[]): Placement[] {
    return result.scenario.expectFooters.map((expected) => {
        const mine = entries.filter((entry) => entry.turnId === expected.turnId);
        // 「有页脚」= 真的渲染出来那行字（`endFooterOf`）。`completed` 的结局事实也挂在条目上，
        // 只是按约定不显示 —— 事实和渲染是两件事，自检必须按**看得见的**那行算。
        const withFooter = mine.filter((entry) => endFooterOf(entry.endReason) !== undefined);
        const footerKinds = withFooter.map((entry) => entry.kind);
        const lastBot = mine.filter((entry) => entry.kind !== 'notice' && entry.kind !== 'error').at(-1);

        if (expected.on === 'none') {
            const factOnly = mine.some((entry) => entry.endReason !== undefined) && withFooter.length === 0;
            return {
                turnId: expected.turnId,
                on: expected.on,
                actual: withFooter.length,
                ok: withFooter.length === 0,
                detail:
                    withFooter.length === 0
                        ? `没有页脚（正确${factOnly ? '；结局事实仍挂在条目上，"完成"不占页脚' : ''}）`
                        : `${withFooter.length} 条页脚`,
            };
        }
        if (expected.on === 'notice') {
            const first = footerKinds[0];
            const ok = withFooter.length === 1 && (first === 'notice' || first === 'error');
            return {
                turnId: expected.turnId,
                on: expected.on,
                actual: withFooter.length,
                ok,
                detail: ok ? '挂在 notice/error 条目上（这一轮没说话，只能挂这儿）' : `挂在了 ${footerKinds.join('/')}`,
            };
        }
        const ok =
            withFooter.length === 1 &&
            withFooter[0] !== undefined &&
            (withFooter[0].kind === 'notice' || withFooter[0].kind === 'error') === false &&
            withFooter[0].key === lastBot?.key;
        return {
            turnId: expected.turnId,
            on: expected.on,
            actual: withFooter.length,
            ok,
            detail: ok
                ? '挂在最后一段 bot 消息上（只挂一次）'
                : `页脚 ${withFooter.length} 条，位置 ${footerKinds.join('/') || '无'}`,
        };
    });
}

function RoomCard({ index, result }: { index: number; result: RoomReplay }) {
    const entries = buildTimeline(result.items, [], {}, { endReasons: result.endReasons });
    const placements = checkPlacement(result, entries);
    const broken = placements.filter((placement) => !placement.ok);

    return (
        <article className="card">
            <header>
                <span className="idx">R{String(index + 1).padStart(2, '0')}</span>
                <h2>{result.scenario.title}</h2>
                {broken.length > 0 ? (
                    <span className="chip chip-bad" title="页脚挂错位置 —— 和挂错内容一样糟">
                        自检失败：{broken.map((placement) => placement.turnId).join('、')}
                    </span>
                ) : (
                    <span className="chip chip-ok">页脚位置自检通过</span>
                )}
            </header>
            <p className="trigger">触发：{result.scenario.trigger}</p>

            <div className="cols">
                <section className="col before">
                    <h3>
                        修复前 <span className="badge ok">{result.legacy.label}</span>
                    </h3>
                    <Timeline items={result.legacy.items} />
                </section>
                <section className="col">
                    <h3>
                        现在 <span className="badge warn">说出来了</span>
                    </h3>
                    <Timeline items={result.items} endReasons={result.endReasons} />
                </section>
            </div>

            <table className="judge tight">
                <thead>
                    <tr>
                        <th style={{ width: '22%' }}>轮次</th>
                        <th style={{ width: '24%' }}>判定</th>
                        <th style={{ width: '30%' }}>页脚位置</th>
                        <th>前端知道结局吗</th>
                    </tr>
                </thead>
                <tbody>
                    {result.turns.map((turn) => {
                        const placement = placements.find((candidate) => candidate.turnId === turn.turn.turnId);
                        return (
                            <tr key={turn.turn.turnId}>
                                <td className="mono">
                                    {turn.turn.turnId}
                                    <br />
                                    <span style={{ color: 'var(--dim)' }}>{turn.turn.bot.name}</span>
                                </td>
                                <td className="mono">
                                    {turn.reason.note === undefined
                                        ? turn.reason.type
                                        : `${turn.reason.type} · ${turn.reason.note}`}
                                </td>
                                <td style={{ color: placement?.ok === false ? '#ff6b6b' : 'var(--dim)' }}>
                                    {placement?.detail}
                                </td>
                                <td style={{ color: turn.known ? 'var(--text)' : '#ff9f43' }}>
                                    {turn.known ? '知道（turn.end 到了）' : '不知道（广播丢了）'}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>

            <details>
                <summary>原始事件流 + 判据事实</summary>
                {result.turns.map((turn) => (
                    <div key={turn.turn.turnId}>
                        <b>{turn.turn.turnId}</b>
                        <pre className="facts">{turn.turn.events.map((event) => JSON.stringify(event)).join('\n')}</pre>
                        <pre>{JSON.stringify({ facts: turn.facts, endReason: turn.reason }, null, 2)}</pre>
                    </div>
                ))}
            </details>
        </article>
    );
}

function RoomSection() {
    const results = ROOM_SCENARIOS.map((scenario) => replayRoom(scenario));
    const broken = results.filter((result) => {
        const entries = buildTimeline(result.items, [], {}, { endReasons: result.endReasons });
        return checkPlacement(result, entries).some((placement) => !placement.ok);
    });

    return (
        <>
            <h2 className="section">房间级场景（多种停法混在一起）</h2>
            <p className="lead">
                单轮样本只回答「这一轮为什么停」。真正难复现的是<b>混在一起</b>的时候：两只 bot 同时跑到不同结局、
                一轮被工具切成几段、上一轮的结局想粘到下一轮、广播丢了前端还知道什么。这里每条也是一条真实事件流，
                交给同一套 <code>Projector</code> + 判据 + <code>buildTimeline</code> 处理，并且**自检页脚挂在什么位置**
                —— 挂错位置和挂错内容一样糟。
            </p>
            <div className="summary">
                <span className="pill">
                    房间场景 <b>{results.length}</b> 条
                </span>
                <span className={broken.length === 0 ? 'pill' : 'pill bad'}>
                    页脚位置自检 <b>{broken.length === 0 ? '全部通过' : `${broken.length} 条挂错`}</b>
                </span>
                <span className="pill">
                    修复前有解释的{' '}
                    <b>{results.filter((r) => r.legacy.items.some((i) => i.type === 'notice')).length}</b> 条
                </span>
                <span className="pill">
                    前端拿不到结局的轮{' '}
                    <b>{results.reduce((sum, r) => sum + r.turns.filter((t) => !t.known).length, 0)}</b> 个
                </span>
            </div>
            {results.map((result, index) => (
                <RoomCard key={result.scenario.id} index={index} result={result} />
            ))}
        </>
    );
}

function App() {
    const [onlyDiffs, setOnlyDiffs] = useState(false);

    const results = STOP_SCENARIOS.map((scenario) => replay(scenario));
    const failedCheck = results.filter((result) => result.reason.type !== result.scenario.expect);
    const diffs = results.filter((result) => result.legacy.label !== '完成' || result.reason.type !== 'completed');
    const shown = onlyDiffs ? diffs : results;

    return (
        <div className="wrap">
            <h1>各种「停」的处理</h1>
            <p className="lead">
                你在 diy2 里看到的「执行一半就停」，以前在数据里和「正常说完」长得一模一样。这个页面把每条已知的停法
                都装配成一条<b>运行时真实会发的事件流</b>，然后交给同一套代码处理：
                <code>Projector</code>（事件 → 条目）、<code>end-reason.ts</code>（判定为什么停）、
                <code>chat-core/timeline</code>（条目 → 时间线）。所以下面显示的不是示意图，是实际处理结果。
            </p>

            <div className="summary">
                <span className="pill">
                    场景 <b>{results.length}</b> 条
                </span>
                <span className={failedCheck.length === 0 ? 'pill' : 'pill bad'}>
                    判据自检 <b>{failedCheck.length === 0 ? '全部通过' : `${failedCheck.length} 条对不上`}</b>
                </span>
                <span className="pill">
                    修复前会说「完成」的 <b>{results.filter((r) => r.legacy.label === '完成').length}</b> 条
                </span>
                <span className="pill">
                    能当结论发房间的 <b>{results.filter((r) => r.publishable).length}</b> 条
                </span>
            </div>

            <table className="judge">
                <thead>
                    <tr>
                        <th style={{ width: '34%' }}>事实（运行侧收集）</th>
                        <th style={{ width: '22%' }}>判定</th>
                        <th>为什么这么判</th>
                    </tr>
                </thead>
                <tbody>
                    {JUDGE_TABLE.map((row) => (
                        <tr key={row.when}>
                            <td className="mono">{row.when}</td>
                            <td className="mono" style={{ color: 'var(--text)' }}>
                                {row.verdict}
                            </td>
                            <td style={{ color: 'var(--dim)' }}>{row.why}</td>
                        </tr>
                    ))}
                </tbody>
            </table>

            <label className="switch">
                <input type="checkbox" checked={onlyDiffs} onChange={(event) => setOnlyDiffs(event.target.checked)} />
                只看「有差别」的（修复前静默显示完成、或现在仍算完成以外的）
            </label>

            {shown.map((result) => (
                <Card key={result.scenario.id} index={results.indexOf(result)} result={result} />
            ))}

            <RoomSection />
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<App />);
