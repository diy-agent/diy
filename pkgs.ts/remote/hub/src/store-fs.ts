// 文件存储：`$DIY_HOME/hub/` 下三个文件，职责分开。
//
//   hub.json    Hub 身份（**只有公钥**，判据 13）+ 监听配置；私钥在钥匙串
//   peers.json  三个状态机数组（invitations / requests / memberships）
//   link.json   卫星侧连接信息（**没有 token**，判据 11）
//
// 写一律同目录临时文件 + rename，权限 0600（只有一个文件不是秘密，但仍然别让同机别的用户读）。
// `update` 在进程内串行（判据 4）；跨进程并发不在 v1 范围（CLI 每次只有一个写者）。

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HubError } from './errors.js';
import { cloneState, emptyPeerState, type HubStore } from './store.js';
import type { DomainId, HubIdentity, HubLink, NodeId, PeerState } from './types.js';

export const HUB_DIR_NAME = 'hub';
export const HUB_IDENTITY_FILE = 'hub.json';
export const PEERS_FILE = 'peers.json';
export const LINK_FILE = 'link.json';

export function hubDir(home: string): string {
    return join(home, HUB_DIR_NAME);
}

/** 原子写：同目录临时文件 + rename（fsync 不做——丢一次身份重生成即可） */
export function writeFileAtomic(file: string, content: string, mode = 0o600): void {
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
    try {
        writeFileSync(tmp, content, { encoding: 'utf-8', mode });
        renameSync(tmp, file);
    } catch (e) {
        try {
            rmSync(tmp, { force: true });
        } catch {
            /* 忽略 */
        }
        throw e;
    }
}

function readJson<T>(file: string): T | null {
    try {
        return JSON.parse(readFileSync(file, 'utf-8')) as T;
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new HubError('hub/bad-input', `读不了 ${file}`, String(e));
    }
}

export function readHubIdentity(file: string): HubIdentity | null {
    return readJson<HubIdentity>(file);
}

export function writeHubIdentity(file: string, identity: HubIdentity): void {
    writeFileAtomic(file, `${JSON.stringify(identity, null, 2)}\n`);
}

export function readLink(file: string): HubLink | null {
    return readJson<HubLink>(file);
}

export function writeLink(file: string, link: HubLink): void {
    writeFileAtomic(file, `${JSON.stringify(link, null, 2)}\n`);
}

export interface FileHubStoreOptions {
    file: string;
    domainId: DomainId;
    hubNodeId: NodeId;
}

/** `peers.json` 实现：每次 update 重新读盘（外部手改也能被看见），进程内串行。 */
export class FileHubStore implements HubStore {
    private chain: Promise<unknown> = Promise.resolve();

    constructor(private readonly opts: FileHubStoreOptions) {}

    async read(): Promise<PeerState> {
        return cloneState(this.load());
    }

    update<T>(fn: (state: PeerState) => T | Promise<T>): Promise<T> {
        const run = this.chain.then(async () => {
            const state = this.load();
            const result = await fn(state);
            writeFileAtomic(this.opts.file, `${JSON.stringify(state, null, 2)}\n`);
            return result;
        });
        this.chain = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    private load(): PeerState {
        const stored = readJson<PeerState>(this.opts.file);
        if (!stored) return emptyPeerState(this.opts.domainId, this.opts.hubNodeId);
        // 文件里缺字段（旧版本 / 手删）时补齐，别让整份状态读崩
        return {
            version: 1,
            domainId: stored.domainId ?? this.opts.domainId,
            hubNodeId: stored.hubNodeId ?? this.opts.hubNodeId,
            invitations: stored.invitations ?? [],
            requests: stored.requests ?? [],
            memberships: stored.memberships ?? [],
        };
    }
}
