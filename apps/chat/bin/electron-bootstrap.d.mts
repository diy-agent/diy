// electron-bootstrap.mjs 的类型声明（实现是运行态薄脚本，不参与 tsc 编译）。
export interface ElectronMirror {
    id: string;
    label: string;
    kind: "mirror" | "github";
    base?: string;
}

export interface ProbeResult {
    id: string;
    label: string;
    url: string;
    ok: boolean;
    ms: number;
    status?: number;
    error?: string;
    total?: number;
}

export interface EnsureOptions {
    version: string;
    electronDir: string;
    platform?: string;
    arch?: string;
    log?: (msg: string) => void;
    fetchImpl?: typeof fetch;
    probeTimeoutMs?: number;
    downloadTimeoutMs?: number;
}

export interface EnsureResult {
    exe: string;
    dir: string;
    source: string;
}

export declare const DEFAULT_MIRRORS: ElectronMirror[];
export declare function platformExe(platform?: string): string;
export declare function cacheHome(): string;
export declare function storeRoot(): string;
export declare function zipName(version: string, platform?: string, arch?: string): string;
export declare function electronStoreDir(opts: { version: string; platform?: string; arch?: string }): string;
export declare function mirrorUrl(mirror: ElectronMirror, opts: { version: string; zip: string }): string;
export declare function requestedMirror(): ElectronMirror | null;
export declare function probeMirrors(opts: {
    mirrors: ElectronMirror[];
    version: string;
    zip: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}): Promise<ProbeResult[]>;
export declare function chooseMirror(
    results: ProbeResult[],
    userWanted: ElectronMirror | null,
): { chosen: ProbeResult | null; reason: string };
export declare function formatProgress(opts: { done: number; total: number; elapsedMs: number; width?: number }): string;
export declare function locateElectronBinary(opts: Omit<EnsureOptions, "log" | "fetchImpl">): EnsureResult | null;
export declare function ensureElectronBinary(opts: EnsureOptions): Promise<EnsureResult>;
