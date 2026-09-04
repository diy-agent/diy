// src/renderer/components-diy/AppInfo.tsx
import { useEffect, useState } from "react";
import { diyService } from "./lib/rpc";

export interface AppInfoData {
  port: number;
  diyHome: string;
  cache: string;
  userData: string;
  electron: string;
  node: string;
  chrome: string;
  platform: string;
  pid: number;
  memory: string;
}

export function AppInfo() {
  const [info, setInfo] = useState<AppInfoData | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    // 走 RPC router（Electron / serve / CLI 同一实现）。
    // 旧写法是 window.diy?.getAppInfo()：Electron 里 preload 只桥接了 transport，
    // window.diy 为 undefined → 可选链短路 → .then 永不执行 → 界面无声卡在「加载中…」；
    // serve 里 window.diy 存在但没这个方法 → TypeError。两端都拿不到数据。
    let alive = true;
    diyService.diy
      .getAppInfo({})
      .then((d) => {
        if (alive) setInfo(d);
      })
      .catch((e: unknown) => {
        if (alive) setFailed(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  if (failed) {
    return <div className="p-4 text-sm text-destructive">获取运行信息失败：{failed}</div>;
  }

  if (!info) {
    return <div className="p-4 text-sm text-muted-foreground">加载中…</div>;
  }

  return (
    <div className="p-4 max-w-xl space-y-2 text-xs font-mono">
      <Section label="运行">
        <Row k="端口" v={String(info.port)} />
        <Row k="PID" v={String(info.pid)} />
      </Section>
      <Section label="目录">
        <Row k="diyHome" v={info.diyHome} />
        <Row k="cache" v={info.cache} />
        <Row k="userData" v={info.userData} />
      </Section>
      <Section label="版本">
        <Row k="Electron" v={info.electron} />
        <Row k="Chrome" v={info.chrome} />
        <Row k="Node.js" v={info.node} />
      </Section>
      <Section label="系统">
        <Row k="平台" v={info.platform} />
        <Row k="内存" v={info.memory} />
      </Section>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded border p-3">
      <div className="text-xs font-bold text-foreground mb-1.5">{label}</div>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground w-20 shrink-0">{k}:</span>
      <span className="text-foreground break-all">{v}</span>
    </div>
  );
}
