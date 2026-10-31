// 实例身份：**id 与 displayName 必须分开**（用户裁决，##479）。
//
//   id          首次启动生成一次，落 `$DIY_HOME/instance-id`，**永不变**。
//   displayName 给人看的名字：缺省取 hostname，用户可改（落 `$DIY_HOME/instance-name`）。
//
// ⚠️ 绝对不要拿 hostname 当 id：hostname 可以改（换机器名 / 公司改名 / DHCP 反查变），
//    一改 id 就漂移 —— 已配对的远端、缓存的 endpoint 全部失效。单测钉住这条（hostname 改了 id 不变）。
//
// app（##484）：身份里还带 **app 短名**（`diy-chat` / `video` / `quant`）。只有 variant（lab / prod）
// 区分不了并存的多个 app，地址 `alice@c-mac/diy-chat.lab` 里那段就是它。

import { shortAppName } from './address.js';

/** id 前缀（示例：`diy-7f3a2c91`） */
export const INSTANCE_ID_PREFIX = 'diy-';

/** 身份文件名（相对数据根） */
export const ID_FILENAME = 'instance-id';
export const NAME_FILENAME = 'instance-name';

export interface InstanceIdentity {
    /** 永不变的标识 */
    id: string;
    /** 可改的显示名 */
    displayName: string;
    /**
     * app 短名（地址里 `user@host/<app>.<variant>` 那一段，##484）。
     * 光有 variant 分不清 diy-chat / video / quant / mini 这些 app —— 故它进身份。
     */
    app: string;
}

/** 从盘上读到的三样原材料（IO 在 `@diy-agent/remote/node`，本模块纯函数） */
export interface StoredIdentity {
    /** `$DIY_HOME/instance-id` 的内容；没有 = null */
    storedId: string | null;
    /** `$DIY_HOME/instance-name` 的内容；没有 = null（⇒ 用 hostname） */
    storedName: string | null;
    /** `os.hostname()`（取不到给空串） */
    hostname: string;
    /**
     * app 的包名或短名（**不落盘**：调用方从自己的 package.json 取，如 `@diy-agent/app-chat`）。
     * 归一成地址里的短名在 `resolveIdentity` 里做（`shortAppName`）；缺省 = `diy`。
     */
    appName?: string;
}

export interface ResolvedIdentity {
    identity: InstanceIdentity;
    /** 首次启动时生成的新 id（调用方负责落盘）；已有 id ⇒ null */
    newId: string | null;
}

/** 生成一个新 id：`diy-` + uuid 的前 8 位十六进制（示例口径；一机几十个实例不会撞） */
export function newInstanceId(uuid: () => string = () => globalThis.crypto.randomUUID()): string {
    const hex = uuid()
        .replace(/[^0-9a-f]/gi, '')
        .toLowerCase();
    return `${INSTANCE_ID_PREFIX}${(hex.slice(0, 8) || '00000000').padEnd(8, '0')}`;
}

/** id 是否像个 id（宽松：只要有 `diy-` 前缀且非空就认，**不因格式细节换掉已有 id**） */
export function isValidInstanceId(value: string): boolean {
    const v = value.trim();
    return v.length > INSTANCE_ID_PREFIX.length && v.startsWith(INSTANCE_ID_PREFIX);
}

/** 显示名归一：去空白；空 ⇒ null（空名字不算「用户设过」） */
export function normalizeDisplayName(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v === '' ? null : v;
}

function normalizeStoredId(value: string | null): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v === '' ? null : v;
}

/**
 * 由「盘上读到的东西」解析出身份（纯函数，故 hostname 改了之后的行为可单测）。
 *
 * 判据：**有 id 就沿用**（哪怕 hostname 全变了）；没有才生成。displayName 优先用户设过的名字，
 * 否则取当前 hostname —— 改名只影响 displayName，不动 id。
 */
export function resolveIdentity(store: StoredIdentity, generateId: () => string = newInstanceId): ResolvedIdentity {
    const storedId = normalizeStoredId(store.storedId);
    const id = storedId ?? generateId();
    const displayName =
        normalizeDisplayName(store.storedName) ?? normalizeDisplayName(store.hostname) ?? 'diy-instance';
    const app = shortAppName(store.appName ?? 'diy');
    return { identity: { id, displayName, app }, newId: storedId === null ? id : null };
}
