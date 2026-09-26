// tests/core/steer-queue.test.ts
// 🎯 插话队列语义（FIFO / 按模式取 / 取消 / 上限）—— 用内存端口，不碰文件系统
//
// 队列是「用户已提交但模型还没看见的发言」，两条硬约束：
//   ① 顺序即投递顺序（用户按下按钮的先后不能被打乱）
//   ② 取出的同时必须落盘删除（否则同一条插话会被投递两次）
// 文件端口的真实读写由 drafts.test.ts 覆盖（同一份 .diy/drafts.yaml）。

import { describe, it, expect } from "vitest";
import { SteerQueue, type SteerQueuePort } from "../../src/main/core/steer-queue";
import { readDrafts, writeSteers, type SteerItem } from "../../src/main/core/drafts";
import { mkdirSync, rmSync } from "node:fs";
import { taskDir } from "../../src/main/core/state";

const URI = "projects/902/tasks/1";

/** 内存端口：记录每次写入（断言"取出即落盘"用） */
function memPort(init: SteerItem[] = []): SteerQueuePort & { writes: SteerItem[][]; items: SteerItem[] } {
  const p = {
    items: [...init],
    writes: [] as SteerItem[][],
    read(): SteerItem[] {
      return [...p.items];
    },
    write(_uri: string, items: SteerItem[]): void {
      p.items = [...items];
      p.writes.push([...items]);
    },
  };
  return p;
}

describe("steer-queue 入队", () => {
  it("入队按 FIFO 尾部追加，返回提交后的队列", () => {
    const q = new SteerQueue(memPort());
    q.add(URI, "step", "第一句");
    const after = q.add(URI, "turn", "第二句");
    expect(after.map((i) => i.text)).toEqual(["第一句", "第二句"]);
    expect(after.map((i) => i.mode)).toEqual(["step", "turn"]);
  });

  it("id 形如 steer/1、steer/2…（给人看也给 agent 用，不用随机串）", () => {
    const q = new SteerQueue(memPort());
    const ids = [q.add(URI, "step", "a"), q.add(URI, "step", "b"), q.add(URI, "turn", "c")]
      .map((items) => items[items.length - 1]!.id);
    expect(ids).toEqual(["steer/1", "steer/2", "steer/3"]);
  });

  it("序号只增不回退：取消中间一条后，新提交不会复用它的号（队列内可定位）", () => {
    const q = new SteerQueue(memPort());
    q.add(URI, "step", "a");
    q.add(URI, "step", "b");
    q.remove(URI, "steer/1");
    expect(q.list(URI).map((i) => i.id)).toEqual(["steer/2"]);
    expect(q.add(URI, "step", "c").map((i) => i.id)).toEqual(["steer/2", "steer/3"]);
  });

  it("队列清空后再来 = 又从 steer/1 起（编号只需同一时刻唯一，不承诺跨时间唯一）", () => {
    const q = new SteerQueue(memPort());
    q.add(URI, "step", "a");
    q.takeFirst(URI);
    expect(q.add(URI, "step", "b").map((i) => i.id)).toEqual(["steer/1"]);
  });

  it("不认识的手写 id 不参与计数（旧随机 id 仍可读可取消，但不会把新号顶高）", () => {
    const port = memPort([
      { id: "s1abc", mode: "step", text: "旧格式的项", created: "" },
      { id: "steer/7x", mode: "step", text: "畸形的项", created: "" },
    ]);
    const q = new SteerQueue(port);
    expect(q.add(URI, "step", "新的").map((i) => i.id)).toEqual(["s1abc", "steer/7x", "steer/1"]);
    // 旧 id 照样能取消（id 只是不透明字符串，没有解析逻辑）
    expect(q.remove(URI, "s1abc").map((i) => i.id)).toEqual(["steer/7x", "steer/1"]);
  });

  it("内容 trim；空内容拒绝（空插话投进去只会污染提示词）", () => {
    const q = new SteerQueue(memPort());
    expect(q.add(URI, "step", "  留白  ")[0]!.text).toBe("留白");
    expect(() => q.add(URI, "step", "   ")).toThrow();
    expect(() => q.add(URI, "step", "")).toThrow();
  });

  it("未知模式拒绝（不许静默当成 step）", () => {
    const q = new SteerQueue(memPort());
    // @ts-expect-error 故意传非法模式
    expect(() => q.add(URI, "next", "x")).toThrow();
  });
});

describe("steer-queue 取出（投递的唯一入口）", () => {
  const seed = (): SteerQueuePort & { writes: SteerItem[][]; items: SteerItem[] } =>
    memPort([
      { id: "a", mode: "turn", text: "A", created: "" }, // 手工 id：取出/取消只按字符串匹配
      { id: "b", mode: "step", text: "B", created: "" },
      { id: "c", mode: "step", text: "C", created: "" },
    ]);

  it("取指定模式 = 该模式里最早的一条（跨过其他模式，不动它们）", () => {
    const port = seed();
    const q = new SteerQueue(port);
    expect(q.takeFirst(URI, "step")!.id).toBe("b");
    expect(q.list(URI).map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("不指定模式 = 队首（无论什么模式）", () => {
    const port = seed();
    const q = new SteerQueue(port);
    expect(q.takeFirst(URI)!.id).toBe("a");
  });

  it("取出即落盘（否则同一条插话会被投递两次）", () => {
    const port = seed();
    const q = new SteerQueue(port);
    q.takeFirst(URI, "step");
    expect(port.writes).toHaveLength(1);
    expect(port.writes[0]!.map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("没有可取的 → undefined，且不产生写入", () => {
    const port = memPort();
    const q = new SteerQueue(port);
    expect(q.takeFirst(URI, "step")).toBeUndefined();
    expect(port.writes).toHaveLength(0);
  });

  it("写盘失败 → 抛错（调用方必须知道，不能出现「模型看见了、队列里还留着」）", () => {
    const q = new SteerQueue({
      read: () => [{ id: "a", mode: "step", text: "A", created: "" }],
      write: () => {
        throw new Error("磁盘只读");
      },
    });
    expect(() => q.takeFirst(URI, "step")).toThrow("磁盘只读");
  });
});

describe("steer-queue 认领（peekFirst：只看不动）", () => {
  it("只看不删：内容与队列都不变（step 模式要「认领 ≠ 投递」两段式）", () => {
    const port = memPort([
      { id: "steer/1", mode: "step", text: "A", created: "" },
      { id: "steer/2", mode: "step", text: "B", created: "" },
    ]);
    const q = new SteerQueue(port);
    expect(q.peekFirst(URI, "step")!.id).toBe("steer/1");
    expect(q.list(URI).map((i) => i.id)).toEqual(["steer/1", "steer/2"]);
    expect(port.writes).toHaveLength(0); // 一个字都没写盘
  });

  it("可按模式认领（跳过早于它的 turn 项）", () => {
    const q = new SteerQueue(
      memPort([
        { id: "steer/1", mode: "turn", text: "轮", created: "" },
        { id: "steer/2", mode: "step", text: "步", created: "" },
      ]),
    );
    expect(q.peekFirst(URI, "step")!.id).toBe("steer/2");
  });

  it("空队列 → undefined", () => {
    expect(new SteerQueue(memPort()).peekFirst(URI)).toBeUndefined();
  });
});

describe("steer-queue 取消与清空", () => {
  it("按 id 取消，其余顺序不变", () => {
    const port = memPort([
      { id: "a", mode: "step", text: "A", created: "" },
      { id: "b", mode: "step", text: "B", created: "" },
    ]);
    const q = new SteerQueue(port);
    expect(q.remove(URI, "a").map((i) => i.id)).toEqual(["b"]);
  });

  it("取消不存在的 id 幂等（重复点 ✕ 不该报错）", () => {
    const port = memPort([{ id: "a", mode: "step", text: "A", created: "" }]);
    const q = new SteerQueue(port);
    expect(() => q.remove(URI, "zzz")).not.toThrow();
    expect(q.list(URI).map((i) => i.id)).toEqual(["a"]);
  });

  it("clear 清空整队（清空会话时用）", () => {
    const port = memPort([{ id: "a", mode: "step", text: "A", created: "" }]);
    const q = new SteerQueue(port);
    q.clear(URI);
    expect(q.list(URI)).toEqual([]);
  });

  it("has 可按模式问（提交按钮的可用态用）", () => {
    const q = new SteerQueue(
      memPort([{ id: "a", mode: "turn", text: "A", created: "" }]),
    );
    expect(q.has(URI)).toBe(true);
    expect(q.has(URI, "turn")).toBe(true);
    expect(q.has(URI, "step")).toBe(false);
  });
});

describe("steer-queue 默认端口 = 任务目录 .diy/drafts.yaml", () => {
  it("默认端口读写的就是草稿文件里的 steers（重启/切模式后队列仍在）", () => {
    mkdirSync(taskDir(URI), { recursive: true });
    rmSync(`${taskDir(URI)}/.diy/drafts.yaml`, { force: true });
    const q = new SteerQueue();
    q.add(URI, "turn", "重启后还要在");
    // 直接读文件：队列确实落在任务目录里（不是内存态）
    expect(readDrafts(URI)!.steers.map((i) => i.text)).toEqual(["重启后还要在"]);
    // 新实例（模拟重启）也能看见；投递后文件里就没了
    const q2 = new SteerQueue();
    expect(q2.list(URI)).toHaveLength(1);
    expect(q2.takeFirst(URI, "turn")!.text).toBe("重启后还要在");
    expect(readDrafts(URI)).toBeNull();
  });

  it("已有草稿字段时只加 steers，不碰字段", () => {
    mkdirSync(taskDir(URI), { recursive: true });
    writeSteers(URI, []);
    const q = new SteerQueue();
    q.add(URI, "step", "插一句");
    expect(readDrafts(URI)!.steers).toHaveLength(1);
  });
});
