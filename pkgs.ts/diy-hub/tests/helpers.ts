import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySecretStore } from '../src/secret.js';
import type { HubIdentity } from '../src/types.js';
import { generateKeyPair } from '../src/key.js';
import { MemoryHubStore, emptyPeerState } from '../src/store.js';

export const tempDirs: string[] = [];

export function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'diy-hub-test-'));
    tempDirs.push(dir);
    return dir;
}

export function cleanupTempDirs(): void {
    while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
}

export function memorySecrets(initial?: Record<string, string>): MemorySecretStore {
    return new MemorySecretStore(initial);
}

export function testIdentity(
    hubNodeId = 'diy-hubtest01',
    domainId = 'default',
): { identity: HubIdentity; privateKey: string } {
    const pair = generateKeyPair();
    return {
        identity: {
            protocolVersion: 1,
            domainId,
            hubNodeId,
            publicKey: pair.publicKey,
            createdAt: '2026-11-01T12:00:00.000+0800',
        },
        privateKey: pair.privateKey,
    };
}

export function testStore(hubNodeId = 'diy-hubtest01'): MemoryHubStore {
    return new MemoryHubStore(emptyPeerState('default', hubNodeId));
}
