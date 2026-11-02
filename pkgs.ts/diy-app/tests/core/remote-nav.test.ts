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
