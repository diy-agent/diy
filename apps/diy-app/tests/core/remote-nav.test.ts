// tests/core/remote-nav.test.ts
// 🎯 远程导航页（##507）的可判定语义 —— 纯函数单测（不依赖 Electron）。
//
// 锁死的契约：
//   1. webAccessUrl：endpoint → https 根地址；非法 / 非 http(s) → null
//   2. pairingAllowed：mDNS 不可配对（与 HubPage 判据 22 同源）；tailscale / local / manual 可以
//   3. PAIR_ACTIONS：两个方向都在（invite=host 屏 / join=join 屏）—— 判据 4 的结构面
//   4. joinUrlFor：预填 URL 与 HubPage.pickDiscover 同款（基址 + /hub/pair?inv=）
//   5. machineLabel / sourceLabel：显示名兜底链与 mDNS 标注
import { describe, it, expect } from "vitest";
import {
  PAIR_ACTIONS,
  joinUrlFor,
  machineLabel,
  pairingAllowed,
  sourceLabel,
  webAccessUrl,
} from "../../src/shared/remote-nav";

describe("webAccessUrl", () => {
  it("http endpoint → https 根地址（换 scheme、去路径、补斜杠）", () => {
    expect(webAccessUrl("http://192.168.1.5:9400")).toBe("https://192.168.1.5:9400/");
    expect(webAccessUrl("http://c-mac.gute-fish.ts.net:9400/ping?x=1")).toBe(
      "https://c-mac.gute-fish.ts.net:9400/",
    );
  });

  it("已是 https 也归一成根地址", () => {
    expect(webAccessUrl("https://example.com/hub")).toBe("https://example.com/");
  });

  it("无 scheme 时按 https 补", () => {
    expect(webAccessUrl("192.168.1.5:9400")).toBe("https://192.168.1.5:9400/");
  });

  it("空串 / 非 http(s) / 解析不了 → null", () => {
    expect(webAccessUrl("")).toBeNull();
    expect(webAccessUrl("   ")).toBeNull();
    expect(webAccessUrl("ftp://x/")).toBeNull();
    expect(webAccessUrl("not a url ::")).toBeNull();
  });
});

describe("pairingAllowed", () => {
  it("mDNS（source 或 sources 含）不可配对", () => {
    expect(pairingAllowed({ source: "mdns", sources: ["mdns"] })).toBe(false);
    expect(pairingAllowed({ source: "local", sources: ["local", "mdns"] })).toBe(false);
  });

  it("tailscale / local / manual 可配对", () => {
    expect(pairingAllowed({ source: "tailscale", sources: ["tailscale"] })).toBe(true);
    expect(pairingAllowed({ source: "local", sources: ["local"] })).toBe(true);
    expect(pairingAllowed({ source: "manual", sources: ["manual"] })).toBe(true);
  });
});

describe("PAIR_ACTIONS（判据 4：两个方向都要存在）", () => {
  it("invite → host 屏（我当主控建邀请）", () => {
    const invite = PAIR_ACTIONS.find((a) => a.key === "invite");
    expect(invite).toBeDefined();
    expect(invite!.tab).toBe("host");
    expect(invite!.label).toBe("添加为卫星节点");
  });

  it("join → join 屏（我当卫星连它）", () => {
    const join = PAIR_ACTIONS.find((a) => a.key === "join");
    expect(join).toBeDefined();
    expect(join!.tab).toBe("join");
    expect(join!.label).toBe("申请成为它的卫星");
  });

  it("恰好两个方向，不多不少", () => {
    expect(PAIR_ACTIONS.map((a) => a.key)).toEqual(["invite", "join"]);
  });
});

describe("joinUrlFor", () => {
  it("与 HubPage.pickDiscover 同款：去尾斜杠 + /hub/pair?inv=", () => {
    expect(joinUrlFor("http://192.168.1.5:9400")).toBe("http://192.168.1.5:9400/hub/pair?inv=");
    expect(joinUrlFor("http://192.168.1.5:9400/")).toBe("http://192.168.1.5:9400/hub/pair?inv=");
  });
});

describe("machineLabel / sourceLabel", () => {
  it("displayName 优先，空则退回 host", () => {
    expect(machineLabel({ displayName: "c-mac", endpoint: "http://10.0.0.1:9400" })).toBe("c-mac");
    expect(machineLabel({ displayName: null, endpoint: "http://10.0.0.1:9400" })).toBe("10.0.0.1:9400");
    expect(machineLabel({ displayName: "  ", endpoint: "http://10.0.0.1:9400" })).toBe("10.0.0.1:9400");
  });

  it("mDNS 标注「局域网」，其余用 source", () => {
    expect(sourceLabel({ source: "mdns", sources: ["mdns"] })).toBe("mDNS（局域网）");
    expect(sourceLabel({ source: "tailscale", sources: ["tailscale"] })).toBe("tailscale");
  });
});

// ── ##511：设备列表合并（一台机器一行 / 按状态分组 / 行上只有一个值） ──
import { DEVICE_GROUPS, mergeDevices, devicePairingAllowed } from "../../src/shared/remote-nav";

const member = (over: Partial<Parameters<typeof mergeDevices>[0]> extends never ? never : any = {}) => ({
  nodeId: "diy-mac01",
  displayName: "c-mac",
  status: "active",
  online: 0,
  createdAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

const found = (over: any = {}) => ({
  id: null,
  displayName: "c-mac",
  endpoint: "http://10.0.0.9:9400",
  source: "tailscale",
  sources: ["tailscale"],
  ...over,
});

describe("mergeDevices（判据 4：同一台机器只出现一行）", () => {
  it("发现行带 id 且等于 member.nodeId → 合并成一行（不是两行）", () => {
    const rows = mergeDevices({
      members: [member({ online: 1 })],
      discovered: [found({ id: "diy-mac01" })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("node:diy-mac01");
    expect(rows[0]!.member).toBeTruthy();
    expect(rows[0]!.discovered).toBeTruthy();
    expect(rows[0]!.group).toBe("connected");
  });

  it("发现行没有 id 时按 link 的 host 对齐（同一个主控只一行）", () => {
    const rows = mergeDevices({
      discovered: [found({ endpoint: "http://c-mac.gute-fish.ts.net:9400" })],
      link: { hubNodeId: "diy-hub01", hubEndpoint: "https://c-mac.gute-fish.ts.net/hub" },
      connection: "online",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("node:diy-hub01");
    expect(rows[0]!.group).toBe("connected");
    expect(rows[0]!.status).toBe("已连接");
  });

  it("没 id 也没 host 匹配的发现行各自成行（未配对）", () => {
    const rows = mergeDevices({
      members: [member()],
      discovered: [found({ displayName: "c-win", endpoint: "http://10.0.0.10:9400" })],
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.group)).toEqual(["paired", "available"]);
  });
});

describe("mergeDevices（状态口径：未连接不是离线）", () => {
  it("link 有但没 Token → 未连接（判据 3）", () => {
    const rows = mergeDevices({
      link: { hubNodeId: "diy-hub01", hubEndpoint: "https://hub.example.ts.net/hub" },
      connection: "no-token",
    });
    expect(rows[0]!.group).toBe("paired");
    expect(rows[0]!.status).toBe("未连接");
  });

  it("link 在线 / 掉线 / 撤销 三种说法分开", () => {
    const link = { hubNodeId: "diy-hub01", hubEndpoint: "https://hub.example.ts.net/hub" };
    expect(mergeDevices({ link, connection: "online" })[0]!.status).toBe("已连接");
    expect(mergeDevices({ link, connection: "offline" })[0]!.status).toBe("离线");
    expect(mergeDevices({ link, connection: "revoked" })[0]!.status).toBe("已撤销");
  });

  it("member 有活连接 → 已连接，条数作为行上那个值", () => {
    expect(mergeDevices({ members: [member({ online: 2 })] })[0]!.status).toBe("2 条连接");
    expect(mergeDevices({ members: [member({ online: 1 })] })[0]!.status).toBe("已连接");
    expect(mergeDevices({ members: [member({ online: 0 })] })[0]!.status).toBe("离线");
    expect(mergeDevices({ members: [member({ status: "revoked" })] })[0]!.status).toBe("已撤销");
  });

  it("分组恒定按 已连接 → 已配对 → 未配对 排序", () => {
    const rows = mergeDevices({
      members: [member({ nodeId: "a", displayName: "a", online: 1 }), member({ nodeId: "b", displayName: "b" })],
      discovered: [found({ id: "c", displayName: "c", endpoint: "http://10.0.0.8:9400" })],
    });
    expect(rows.map((r) => r.group)).toEqual(["connected", "paired", "available"]);
    expect(DEVICE_GROUPS.map((g) => g.key)).toEqual(["connected", "paired", "available"]);
  });

  it("mDNS 发现行不能配对（与 HubPage 判据 22 同源）", () => {
    const [row] = mergeDevices({ discovered: [found({ id: "x", source: "mdns", sources: ["mdns"] })] });
    expect(devicePairingAllowed(row!)).toBe(false);
  });

  it("已撤销的成员不再给配对动作", () => {
    const [row] = mergeDevices({
      members: [member({ status: "revoked" })],
      discovered: [found({ id: "diy-mac01" })],
    });
    expect(devicePairingAllowed(row!)).toBe(false);
  });
});

/**
 * 两列分开（2026-11-05 用户裁）：「连接状态和授权状态分开，分开 2 列显示」。
 *
 * 这两个维度**独立**：一台机器可以「在线但未配对」（能 ping 通，我管不了它），
 * 也可以「已配对但离线」（我管它，但它现在不在线）。折叠成一列就丢了这两种情况。
 */
describe("连接与授权是两个独立维度", () => {
    const discovered = (id: string, endpoint: string) => ({
        id,
        displayName: "c-mac",
        endpoint,
        source: "local",
        sources: ["local"],
        meta: {},
    });

    it("在线但未配对：连接 online / 授权 none（不是被折叠成「可配对」）", () => {
        const rows = mergeDevices({
            discovered: [discovered("diy-a", "http://127.0.0.1:9401")],
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]!.connection).toBe("online");
        expect(rows[0]!.trust).toBe("none");
    });

    it("已配对且在线：online / master", () => {
        const rows = mergeDevices({
            members: [{ nodeId: "diy-b", displayName: "b", status: "active", online: 1, createdAt: "x" }],
        });
        expect(rows[0]!.connection).toBe("online");
        expect(rows[0]!.trust).toBe("master");
    });

    it("已配对但离线：offline / master", () => {
        const rows = mergeDevices({
            members: [{ nodeId: "diy-b", displayName: "b", status: "active", online: 0, createdAt: "x" }],
        });
        expect(rows[0]!.connection).toBe("offline");
        expect(rows[0]!.trust).toBe("master");
    });

    it("已撤销：connection unknown（不再探）/ trust revoked", () => {
        const rows = mergeDevices({
            members: [{ nodeId: "diy-b", displayName: "b", status: "revoked", online: 0, createdAt: "x" }],
        });
        expect(rows[0]!.connection).toBe("unknown");
        expect(rows[0]!.trust).toBe("revoked");
    });

    it("我是它的卫星且长连 online：online / satellite", () => {
        const rows = mergeDevices({
            link: { hubNodeId: "diy-hub", hubEndpoint: "https://c-mac.ts.net/hub" },
            connection: "online",
        });
        const row = rows.find((r) => r.link !== undefined);
        expect(row?.connection).toBe("online");
        expect(row?.trust).toBe("satellite");
    });

    it("我是它的卫星但长连断：offline / satellite（不伪装成在线）", () => {
        const rows = mergeDevices({
            link: { hubNodeId: "diy-hub", hubEndpoint: "https://c-mac.ts.net/hub" },
            connection: "offline",
        });
        const row = rows.find((r) => r.link !== undefined);
        expect(row?.connection).toBe("offline");
        expect(row?.trust).toBe("satellite");
    });
});

/** 列表里一眼看完一行（2026-11-05 用户：「显示 ccc@localhost:9401/diy-app/lab，再加一个列 pid」） */
describe("显示地址与 pid", () => {
    const local = (over: Record<string, unknown> = {}) => ({
        id: "diy-x",
        displayName: "c-mac",
        endpoint: "http://127.0.0.1:63059",
        source: "local",
        sources: ["local"],
        meta: { pid: "64621", app: "diy", variant: "lab", env: "development" },
        ...over,
    });

    it("local 源 + user ⇒ 拼出 user@host:port/app.variant", () => {
        const rows = mergeDevices({ user: "ccc", discovered: [local()] });
        expect(rows[0]!.address).toBe("ccc@127.0.0.1:63059/diy/lab");
        expect(rows[0]!.pid).toBe(64621);
    });

    it("不给 user ⇒ 不拼地址（UI 退回显示名），pid 仍然有", () => {
        const rows = mergeDevices({ discovered: [local()] });
        expect(rows[0]!.address).toBeUndefined();
        expect(rows[0]!.pid).toBe(64621);
    });

    it("非 local 源 ⇒ 不拼地址（不知道对方登录名，填本机会误导）", () => {
        const rows = mergeDevices({ user: "ccc", discovered: [local({ source: "tailscale", sources: ["tailscale"] })] });
        expect(rows[0]!.address).toBeUndefined();
    });

    it("meta 缺 pid ⇒ pid 缺省，不写 NaN", () => {
        const rows = mergeDevices({ discovered: [local({ meta: {} })] });
        expect(rows[0]!.pid).toBeUndefined();
    });
});
