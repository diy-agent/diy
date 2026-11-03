// @diy-agent/remote — 纯契约（浏览器安全：不 import node:*，renderer 也能用这些类型）

/** 发现来源（四个发现器各一个 kind；`source` 是字符串是为了容忍未来的新发现器） */
export type DiscoverSource = 'local' | 'mdns' | 'tailscale' | 'manual';

/**
 * 一台被发现到的 diy 实例。
 *
 * ⚠️ `id` / `displayName` 允许是 null：发现阶段**可能不知道**（老实例没广播、mDNS 没带 TXT），
 * 那不等于「这台没有身份」—— ping 通之后再补。别拿 endpoint 充当 id。
 */
export interface DiscoveredInstance {
    /** 实例自报的永不变 id（`$DIY_HOME/instance-id`）；未知为 null */
    id: string | null;
    /** 可改的显示名（缺省 hostname）；未知为 null */
    displayName: string | null;
    /** 直接可用的基址，形如 `http://192.168.1.5:9400`（不含 /ping） */
    endpoint: string;
    /** 哪个发现器给出的（local / mdns / tailscale / manual） */
    source: string;
    /** 发现器附带的证据（variant / env / diyHome / pid…），只作线索 */
    meta?: Record<string, string>;
}

/** 合并去重后的一行：同一实例可能被多个发现器同时看到（形如 `(mdns + local)`） */
export interface MergedInstance extends DiscoveredInstance {
    /** 参与合并的来源，按 `SOURCE_RANK` 排序（用户据此判断可信度） */
    sources: string[];
}

/** 一个发现器：`kind` 即上面 `source` 的取值 */
export interface Discoverer {
    readonly kind: string;
    discover(): Promise<DiscoveredInstance[]>;
}

/**
 * `GET /ping` 的响应体（**本轮唯一对外契约**）。
 *
 * 字段只放「能识别一台实例 + 判断它活着」所必需的信息，**不放数据根路径**：
 * 本轮无鉴权，任何能连上端口的人都能读到它。
 */
export interface PingInfo {
    /** 永不变的实例 id（首次启动生成，存 `$DIY_HOME/instance-id`） */
    id: string;
    /** 可改的显示名（缺省 hostname，用户可改） */
    displayName: string;
    /**
     * app 短名（##484：`@diy-agent/app-chat` → `diy-chat`，不带 scope）。
     * 光有 variant 分不清 diy-chat / video / quant / mini —— 地址里那段就是它。
     */
    app: string;
    /** 产物变体：prod / lab / test / preview */
    variant: string;
    /** 实例版本 */
    version: string;
    pid: number;
    /** 进程启动时刻（ISO） */
    startedAt: string;
    uptimeMs: number;
}

/** ping 的 HTTP 路径 */
export const PING_PATH = '/ping';

/** ping 缺省端口（被占时实例顺延，实际端口由发现器自报） */
export const PING_DEFAULT_PORT = 9400;

/** mDNS 服务类型：`_diy._tcp`（bonjour-service 里写 `type: "diy"`） */
export const MDNS_SERVICE_TYPE = 'diy';

/**
 * 多源合并时的**端点优先级**：同一个 id 被多个发现器给出不同 endpoint 时，取排名靠前的那个。
 * manual 排第一 —— 用户手输的东西是明确意图，不该被自动发现覆盖。
 */
export const SOURCE_RANK: readonly string[] = ['manual', 'local', 'tailscale', 'mdns'];

/** 某来源的优先级（未知来源排最后） */
export function sourceRank(source: string): number {
    const i = SOURCE_RANK.indexOf(source);
    return i === -1 ? SOURCE_RANK.length : i;
}
