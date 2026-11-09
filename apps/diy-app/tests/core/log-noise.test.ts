// tests/core/log-noise.test.ts — 噪音登记与聚合（##522）
import { describe, expect, it } from "vitest";
import { classifyRendererNoise, createNoiseMeter, RENDERER_NOISE } from "../../src/main/services/log-noise";

const RO = "ResizeObserver loop completed with undelivered notifications";

describe("classifyRendererNoise", () => {
  it("两条 Chromium 措辞都归到同一个 kind", () => {
    expect(classifyRendererNoise(RO)?.kind).toBe("resize-observer-loop");
    expect(classifyRendererNoise("ResizeObserver loop limit exceeded")?.kind).toBe("resize-observer-loop");
  });

  it("带上下文的消息（Chromium 会拼 sourceId）照样命中", () => {
    expect(classifyRendererNoise(`${RO}. (file:///x/index.html:0)`)?.kind).toBe("resize-observer-loop");
  });

  it("未登记的消息返回 null —— 真错误不许被误当噪音吞掉", () => {
    expect(classifyRendererNoise("TypeError: x is not a function")).toBeNull();
  });

  it("每条登记都写了 why（首次日志就是靠它回答「这算啥」）", () => {
    for (const r of RENDERER_NOISE) expect(r.why.length).toBeGreaterThan(10);
  });
});

describe("createNoiseMeter", () => {
  const meter = (t: { now: number }) => {
    const lines: string[] = [];
    const m = createNoiseMeter({ now: () => t.now, flushMs: 60_000, emit: (l) => lines.push(l) });
    return { m, lines };
  };
  const rule = RENDERER_NOISE[0]!;

  it("首次命中立刻出一行，带原文与解释", () => {
    const t = { now: 0 };
    const { m, lines } = meter(t);
    m.note(rule, RO);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("首次出现");
    expect(lines[0]).toContain(RO);
    expect(lines[0]).toContain("已知良性");
  });

  it("窗口内的后续命中只计数不出行（不刷屏，但计数在涨）", () => {
    const t = { now: 0 };
    const { m, lines } = meter(t);
    for (let i = 0; i < 30; i++) m.note(rule, RO);
    t.now = 1_000;
    m.note(rule, RO);
    expect(lines).toHaveLength(1);
    // 隔 60s 后的那条命中把累计数带出来
    t.now = 61_000;
    m.note(rule, RO);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("累计 32");
  });

  it("flush 补齐窗口内没打出来的计数（退出不丢信息）", () => {
    const t = { now: 0 };
    const { m, lines } = meter(t);
    m.note(rule, RO);
    t.now = 5_000;
    m.note(rule, RO);
    m.note(rule, RO);
    m.flush();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("近 5s 内 2 条（累计 3）");
    m.flush(); // 幂等：没有待输出就不再出
    expect(lines).toHaveLength(2);
  });
});
