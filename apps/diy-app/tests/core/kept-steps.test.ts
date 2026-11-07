import { describe, expect, it, beforeEach } from "vitest";
import { keptStepsView } from "../../src/main/services/local-agent";
import { sessionFileRel } from "../../src/main/core/local-paths";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("keptStepsView", () => {
  let home = "";
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "keptsteps-"));
    process.env["DIY_HOME"] = home;
  });

  it("按实测差分出轴、累加、默认落点、中位数", async () => {
    const task = "projects/1/tasks/1";
    const fp = join(home, sessionFileRel(task, "usage"));
    mkdirSync(join(fp, ".."), { recursive: true });
    const mk = (turn: string, s: number, total: number) =>
      JSON.stringify({ ts: "2026-11-06T00:00:00.000+0800", turnId: turn, step: s, model: "m", apiFace: "chat",
        usage: { inputTokens: total, outputTokens: 10 } });
    writeFileSync(fp, [mk("t1",1,1000), mk("t1",2,1500), mk("t1",3,2500)].join("\n") + "\n");

    const v = keptStepsView(task);
    expect(v.rows.length).toBe(3);
    expect(v.rows[0]!.fromTail).toBe(1);          // 最新在前
    expect(v.rows[0]!.tokens).toBe(1000);         // 2500 - 1500
    expect(v.rows[1]!.tokens).toBe(500);          // 1500 - 1000
    // 总量含 output（bucketsOf.total = input + output）⇒ 最老一步自身也算进 10
    expect(v.rows[2]!.cumFromTail).toBe(2510);    // 1000 + 500 + 1010
    expect(v.rows[0]!.cumFromTail).toBe(1000);
    expect(v.medianTokens).not.toBeNull();
  });
});
