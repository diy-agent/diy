// store.ts — blobs 目录的读写实现（本包唯一的 IO）
//
// 磁盘形状（2026-11-26 与用户定）：
//
//   <home>/blobs/<YYYY-MM-DD>/<HHMMSS>-<batch8>/<NN>-<原名>.<ext>
//
//   · 日期目录 —— 按天浏览、按天清；一天的批次数就是目录项数，fs 扫描不炸
//   · 批次 = **一次发送**（同批多图共享目录）⇒ 可整批回看、整批删
//   · `NN-` 保序 —— 多图的顺序有意义，光靠原文件名排会乱
//   · `<ext>` 由 mime 定，不信原名后缀（`.png` 里装 jpeg 是常态）
//   · `<原名>` sanitize 过（见 name.ts），全名另存 ref.displayName —— 一个字都不丢
//
// 两条入口，对应用户问的「拷不拷」：
//   beginBatch().putBytes/putFile  —— **拷**：字节进 blobs（剪贴板、远端、程序产物）
//   adopt({ path })                —— **引用**：字节留在原处（工作区文件 / 目录），只记路径
//
// 安全（这一层必须有，不能指望调用方）：
//   · 所有路径折进 root 之后必须仍在 root 里（`..` / 绝对路径 / 软链一律拒）
//   · 写文件先写 `<name>.tmp-<rand>` 再 rename（半截文件绝不出现在正式名下）
//   · 目录 0700 / 文件 0600（附件可能有隐私）

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, readFile, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { AttachmentError } from './errors.js';
import { imageSizeOf } from './image-size.js';
import { extOfMime, isImageMime, sniffMime } from './mime.js';
import { fileNameOf, PASTE_NAME } from './name.js';
import type {
    AttachmentImageSize,
    AttachmentKind,
    AttachmentListing,
    AttachmentOrigin,
    AttachmentSource,
    LinkedAttachment,
    StoredAttachment,
} from './types.js';

/** 单文件缺省上限：64 MB（超过说明该走 archive 或 linked，不该当附件塞进上下文） */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** linked 文件算 sha256 的缺省上限：32 MB（再大就是白烧 IO，而它本来只是「提示原件变没变」） */
export const DEFAULT_HASH_LIMIT = 32 * 1024 * 1024;

/** 目录 listing 的扫描上限：超过就停，并标 truncated（不让一次拖整库把 UI 卡死） */
const LISTING_SCAN_LIMIT = 5000;

/** 嗅探 + 尺寸要读的文件头长度（JPEG 的 SOF 可能在大 EXIF 之后） */
const HEAD_BYTES = 256 * 1024;

/** 目录权限：只有自己可进 */
const DIR_MODE = 0o700;

/** 文件权限：只有自己可读（附件里可能有截图、合同、身份证） */
const FILE_MODE = 0o600;

/** 建 store 的选项 */
export interface BlobStoreOptions {
    /** blobs 根本目录（`<home>/blobs`） */
    readonly root: string;
    /** 时间源（测试注入） */
    readonly clock?: () => number;
    /** 随机源（批次后缀；测试注入） */
    readonly random?: () => string;
    /** 单文件上限（字节） */
    readonly maxBytes?: number;
    /** linked 文件算 sha256 的上限（字节） */
    readonly hashLimit?: number;
}

/** 写入字节的入参 */
export interface PutBytesInput {
    readonly bytes: Uint8Array;
    /** 原名（displayName）；剪贴板图没有 = 缺省 */
    readonly name?: string;
    /** 调用方声明的 mime（**嗅探优先**，这里只是兜底） */
    readonly mime?: string;
    readonly source: AttachmentSource;
    readonly origin?: AttachmentOrigin;
    /** 显式类别（缺省由 mime 推：image/* → 'image'，其余 'file'；归档传 'archive'） */
    readonly kind?: Exclude<AttachmentKind, 'dir'>;
    /** 归档 / 打包的目录概览（archive 用；没有 UI 只能显示一个文件名） */
    readonly listing?: AttachmentListing;
}

/** 从磁盘文件拷进来的入参（流式，不整份进内存） */
export interface PutFileInput extends Omit<PutBytesInput, 'bytes'> {
    /** 源文件绝对路径 */
    readonly path: string;
}

/** 引用（不拷贝）一条已有路径 */
export interface AdoptInput {
    /** 绝对路径（文件或目录） */
    readonly path: string;
    /** 缺省 `path`（用户自己给的路径）；拖拽 / 选择器传 `drop` / `pick` */
    readonly source?: AttachmentSource;
    /** 显式类别（缺省：目录 → 'dir'，文件 → 由 mime 推） */
    readonly kind?: AttachmentKind;
    /** 显示名（缺省 = basename） */
    readonly name?: string;
    readonly origin?: AttachmentOrigin;
}

/** 一个批次（= 一次发送）。同批的 put 共享目录，`NN` 递增 */
export interface AttachmentBatch {
    readonly id: string;
    putBytes(input: PutBytesInput): Promise<StoredAttachment>;
    putFile(input: PutFileInput): Promise<StoredAttachment>;
}

/** blobs 的读写面 */
export interface BlobStore {
    /** blobs 根（绝对路径） */
    readonly root: string;
    /** 开一个批次（一次发送一个） */
    beginBatch(): AttachmentBatch;
    /** 便捷：单发一批（内部自己开批次） */
    putBytes(input: PutBytesInput): Promise<StoredAttachment>;
    /** 便捷：单发一批，从磁盘文件拷 */
    putFile(input: PutFileInput): Promise<StoredAttachment>;
    /** 按 ref 取回字节（带 sha256 校验：文件被改过 / 被清了都要立刻炸） */
    read(ref: StoredAttachment): Promise<Uint8Array>;
    /** 只读文件头（模型侧判尺寸 / UI 嗅探复检用，不整份拉进内存） */
    readHead(ref: StoredAttachment, limit?: number): Promise<Uint8Array>;
    /** relPath 是否存在 */
    exists(relPath: string): Promise<boolean>;
    /** 整批删（一次发送的全部附件）。返回删掉的文件数与子目录数 */
    removeBatch(batchId: string): Promise<number>;
    /** 引用一条已有路径（**不拷**） */
    adopt(input: AdoptInput): Promise<LinkedAttachment>;
}

/** 两位补零 */
function pad(value: number, width = 2): string {
    return String(value).padStart(width, '0');
}

/** 本地时区的 `YYYY-MM-DD`（与 diy 其它落盘时刻一致：本地时间 + 人可读） */
function localDay(at: number): string {
    const date = new Date(at);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 本地时区的 `HHMMSS` */
function localStamp(at: number): string {
    const date = new Date(at);
    return `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 从 mime 与显式声明推附件类别 */
function kindOf(mime: string, explicit?: Exclude<AttachmentKind, 'dir'>): Exclude<AttachmentKind, 'dir'> {
    if (explicit !== undefined) return explicit;
    return isImageMime(mime) ? 'image' : 'file';
}

/** 把 relPath 折成 root 内的绝对路径（逃逸一律抛 `attachment/unsafe-path`） */
function resolveInRoot(root: string, relPath: string): string {
    if (relPath === '') {
        throw new AttachmentError('attachment/unsafe-path', '路径为空', root);
    }
    if (isAbsolute(relPath)) {
        throw new AttachmentError('attachment/unsafe-path', '不许绝对路径', relPath);
    }
    const segments = relPath.split(/[/\\]/);
    if (segments.some((segment) => segment === '..')) {
        throw new AttachmentError('attachment/unsafe-path', '不许 `..` 段', relPath);
    }
    const absolute = resolve(root, relPath);
    if (absolute !== root && !absolute.startsWith(root + sep)) {
        throw new AttachmentError('attachment/unsafe-path', '折出来跑到 blobs 根之外', `${relPath} → ${absolute}`);
    }
    return absolute;
}

/** sha256（hex） */
function sha256Of(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/** 内存里维护的批次计数（同批 NN 递增；进程重启后同批不会续写 —— 批次本来就不跨进程） */
interface BatchState {
    readonly root: string;
    readonly id: string;
    readonly dir: string;
    counter: number;
}

/** 建一个 blobs store */
export function createBlobStore(options: BlobStoreOptions): BlobStore {
    if (options.root === '' || !isAbsolute(options.root)) {
        throw new AttachmentError('attachment/invalid-options', 'root 必须是绝对路径', String(options.root));
    }
    const root = resolve(options.root);
    const clock = options.clock ?? Date.now;
    const random = options.random ?? (() => randomBytes(4).toString('hex'));
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const hashLimit = options.hashLimit ?? DEFAULT_HASH_LIMIT;
    if (maxBytes <= 0) {
        throw new AttachmentError('attachment/invalid-options', 'maxBytes 必须为正', String(maxBytes));
    }

    /** 确保批次目录存在（0700） */
    const ensureDir = async (dir: string): Promise<void> => {
        await mkdir(dir, { recursive: true, mode: DIR_MODE });
    };

    /**
     * 写临时文件（`.tmp-<rand>`），失败自己清掉。
     * 先临时后改名是因为**真名要等 mime 定下来才知道**（扩展名由 mime 定，不信用户后缀）。
     */
    const writeTemp = async (
        dir: string,
        write: (tmpPath: string) => Promise<{ bytes: number; sha256: string; head: Uint8Array }>,
    ): Promise<{ tmpPath: string; bytes: number; sha256: string; head: Uint8Array }> => {
        const tmpPath = join(dir, `.tmp-${random()}`);
        try {
            const written = await write(tmpPath);
            return { tmpPath, ...written };
        } catch (error) {
            await rm(tmpPath, { force: true });
            if (error instanceof AttachmentError) throw error;
            throw new AttachmentError(
                'attachment/write-failed',
                error instanceof Error ? error.message : String(error),
                tmpPath,
            );
        }
    };

    /** 撞名就加 `-2` / `-3`（同批同 NN 极少；重建同名批次时可能） */
    const freeName = async (dir: string, baseName: string): Promise<string> => {
        let fileName = baseName;
        let dup = 1;
        while (await existsIn(dir, fileName)) {
            dup += 1;
            fileName = baseName.replace(/(\.[^.]+)$/, `-${dup}$1`);
        }
        return fileName;
    };

    /** 字节已在内存：直接写 */
    const writeBytes = (bytes: Uint8Array) => async (tmpPath: string) => {
        await writeFile(tmpPath, bytes, { mode: FILE_MODE });
        return { bytes: bytes.byteLength, sha256: sha256Of(bytes), head: bytes.subarray(0, HEAD_BYTES) };
    };

    /** 字节在磁盘：流式拷（大文件不进内存），边写边算 hash / 攒文件头 */
    const writeStream = (sourcePath: string) => async (tmpPath: string) => {
        const hash = createHash('sha256');
        const headParts: Uint8Array[] = [];
        let headLength = 0;
        let total = 0;
        const out = await open(tmpPath, 'w', FILE_MODE);
        try {
            for await (const chunk of createReadStream(sourcePath)) {
                const buffer = chunk as Buffer;
                total += buffer.byteLength;
                if (total > maxBytes) {
                    throw new AttachmentError(
                        'attachment/too-large',
                        `超过单文件上限 ${maxBytes} 字节（目录或大文件请走 archive / linked）`,
                        sourcePath,
                    );
                }
                hash.update(buffer);
                if (headLength < HEAD_BYTES) {
                    const take = Math.min(HEAD_BYTES - headLength, buffer.byteLength);
                    headParts.push(buffer.subarray(0, take));
                    headLength += take;
                }
                await out.write(buffer);
            }
        } finally {
            await out.close();
        }
        return { bytes: total, sha256: hash.digest('hex'), head: Buffer.concat(headParts) };
    };

    /** 内存里同一批次的 put 串行化（NN 递增不能被并发打乱） */
    const putInto = async (state: BatchState, input: PutBytesInput | PutFileInput): Promise<StoredAttachment> => {
        await ensureDir(state.dir);
        state.counter += 1;
        const index = state.counter;
        const at = clock();
        const fromFile = 'path' in input;
        const declaredMime = input.mime;
        const displayNameHint = input.name;

        if (!fromFile && (input as PutBytesInput).bytes.byteLength > maxBytes) {
            throw new AttachmentError(
                'attachment/too-large',
                `超过单文件上限 ${maxBytes} 字节（目录或大文件请走 archive / linked）`,
                displayNameHint ?? '',
            );
        }

        const written = await writeTemp(
            state.dir,
            fromFile ? writeStream((input as PutFileInput).path) : writeBytes((input as PutBytesInput).bytes),
        );

        // 名字要等 mime 定下来才能定扩展名 —— 先写临时文件、嗅探、再用真名 rename
        // （嗅探 / 折名都是纯函数不抛；只有 stat / rename 会，抛了就清临时文件，
        //   否则批次目录里会攒下 `.tmp-*` 僵尸）
        const mime = sniffMime(written.head, declaredMime, displayNameHint);
        const ext = extOfMime(mime);
        const kind = kindOf(mime, input.kind);
        const displayName = displayNameHint ?? `${PASTE_NAME}.${ext}`;
        let fileName: string;
        try {
            fileName = await freeName(state.dir, fileNameOf(index, displayName, ext));
            await rename(written.tmpPath, join(state.dir, fileName));
        } catch (error) {
            await rm(written.tmpPath, { force: true });
            throw error;
        }

        const relPath = `${state.id}/${fileName}`;
        const image: AttachmentImageSize | undefined = kind === 'image' ? imageSizeOf(written.head) : undefined;
        const stored: StoredAttachment = {
            type: 'stored',
            id: relPath,
            relPath,
            kind,
            mime,
            bytes: written.bytes,
            displayName,
            source: input.source,
            createdAt: at,
            sha256: written.sha256,
            ...(image === undefined ? {} : { image }),
            ...(input.origin === undefined ? {} : { origin: input.origin }),
            ...(input.listing === undefined ? {} : { listing: input.listing }),
        };
        return stored;
    };

    /** 同批 put 串行排（并发调用时 NN 会撞） */
    const queues = new WeakMap<BatchState, Promise<unknown>>();
    const serialize = <T>(state: BatchState, task: () => Promise<T>): Promise<T> => {
        const previous = queues.get(state) ?? Promise.resolve();
        const next = previous.then(task, task);
        queues.set(
            state,
            next.catch(() => undefined),
        );
        return next;
    };

    const beginBatch = (): AttachmentBatch => {
        const at = clock();
        const id = `${localDay(at)}/${localStamp(at)}-${random()}`;
        const state: BatchState = { root, id, dir: join(root, id), counter: 0 };
        return {
            id,
            putBytes: (input) => serialize(state, () => putInto(state, input)),
            putFile: (input) => serialize(state, () => putInto(state, input)),
        };
    };

    const readByRelPath = async (relPath: string, sha256?: string): Promise<Uint8Array> => {
        const absolute = resolveInRoot(root, relPath);
        let bytes: Uint8Array;
        try {
            bytes = await readFile(absolute);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
                throw new AttachmentError('attachment/not-found', 'blobs 里没有这个附件', absolute);
            }
            throw new AttachmentError(
                'attachment/read-failed',
                error instanceof Error ? error.message : String(error),
                absolute,
            );
        }
        if (sha256 !== undefined) {
            const actual = sha256Of(bytes);
            if (actual !== sha256) {
                throw new AttachmentError(
                    'attachment/read-failed',
                    `sha256 不符（期望 ${sha256}，实际 ${actual}）`,
                    absolute,
                );
            }
        }
        return bytes;
    };

    /** 目录概览：顶层计数 + 递归样例（超上限就 truncated） */
    const listingOf = async (dir: string): Promise<AttachmentListing> => {
        const sample: string[] = [];
        let count = 0;
        let truncated = false;
        const walk = async (current: string, prefix: string): Promise<void> => {
            let entries;
            try {
                entries = await readdir(current, { withFileTypes: true });
            } catch {
                return; // 权限不足 / 竞态删除：能读多少算多少
            }
            for (const entry of entries) {
                if (entry.name === '.DS_Store' || entry.name.startsWith('._') || entry.name === '__MACOSX') continue;
                const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
                if (entry.isDirectory()) {
                    await walk(join(current, entry.name), relative);
                    if (truncated) return;
                    continue;
                }
                count += 1;
                if (sample.length < 20) sample.push(relative);
                if (count >= LISTING_SCAN_LIMIT) {
                    truncated = true;
                    return;
                }
            }
        };
        await walk(dir, '');
        return { count, sample, ...(truncated ? { truncated: true } : {}) };
    };

    return {
        root,
        beginBatch,
        putBytes: (input) => beginBatch().putBytes(input),
        putFile: (input) => beginBatch().putFile(input),

        read(ref) {
            return readByRelPath(ref.relPath, ref.sha256);
        },

        async readHead(ref, limit = 64) {
            const absolute = resolveInRoot(root, ref.relPath);
            const handle = await open(absolute, 'r');
            try {
                const buffer = Buffer.alloc(limit);
                const { bytesRead } = await handle.read(buffer, 0, limit, 0);
                return buffer.subarray(0, bytesRead);
            } catch (error) {
                throw new AttachmentError(
                    'attachment/read-failed',
                    error instanceof Error ? error.message : String(error),
                    absolute,
                );
            } finally {
                await handle.close();
            }
        },

        async exists(relPath) {
            try {
                const absolute = resolveInRoot(root, relPath);
                await stat(absolute);
                return true;
            } catch {
                return false;
            }
        },

        async removeBatch(batchId) {
            const absolute = resolveInRoot(root, batchId);
            try {
                const entries = await readdir(absolute);
                await rm(absolute, { recursive: true, force: true });
                return entries.length;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
                throw new AttachmentError(
                    'attachment/write-failed',
                    error instanceof Error ? error.message : String(error),
                    absolute,
                );
            }
        },

        async adopt(input) {
            const absolute = resolve(input.path);
            let info;
            try {
                info = await stat(absolute);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    throw new AttachmentError('attachment/not-found', '路径不存在', absolute);
                }
                throw new AttachmentError(
                    'attachment/read-failed',
                    error instanceof Error ? error.message : String(error),
                    absolute,
                );
            }
            const at = clock();
            const displayName = input.name ?? absolute.split(sep).at(-1) ?? absolute;
            const id = `ref-${createHash('sha256').update(absolute).digest('hex').slice(0, 12)}`;

            if (info.isDirectory()) {
                const listing = await listingOf(absolute);
                return {
                    type: 'linked',
                    id,
                    path: absolute,
                    kind: input.kind ?? 'dir',
                    // 目录没有 mime（不是文件）；给一个稳定的占位，消费方按 kind 分派
                    mime: 'inode/directory',
                    bytes: 0,
                    displayName,
                    source: input.source ?? 'path',
                    createdAt: at,
                    listing,
                    ...(input.origin === undefined ? {} : { origin: input.origin }),
                };
            }

            // 文件：读头嗅探 + 尺寸；小文件顺手算 sha256（「原件变了」靠它提示）
            const head = await readHeadOf(absolute, HEAD_BYTES);
            const mime = sniffMime(head.subarray(0, 64), undefined, absolute);
            const kind = input.kind ?? (isImageMime(mime) ? 'image' : 'file');
            const digest = info.size <= hashLimit ? await sha256OfFile(absolute) : undefined;
            const image = kind === 'image' ? imageSizeOf(head) : undefined;
            return {
                type: 'linked',
                id,
                path: absolute,
                kind,
                mime,
                bytes: info.size,
                displayName,
                source: input.source ?? 'path',
                createdAt: at,
                ...(digest === undefined ? {} : { sha256: digest }),
                ...(image === undefined ? {} : { image }),
                ...(input.origin === undefined ? {} : { origin: input.origin }),
            };
        },
    };
}

/** 目录里某个名字是否已存在 */
async function existsIn(dir: string, name: string): Promise<boolean> {
    try {
        await stat(join(dir, name));
        return true;
    } catch {
        return false;
    }
}

/** 读文件的头 N 字节（不足就返回已有的） */
async function readHeadOf(path: string, limit: number): Promise<Uint8Array> {
    const handle = await open(path, 'r');
    try {
        const buffer = Buffer.alloc(limit);
        const { bytesRead } = await handle.read(buffer, 0, limit, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

/** 整文件 sha256（流式，不整份进内存） */
async function sha256OfFile(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest('hex');
}
