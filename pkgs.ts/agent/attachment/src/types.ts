// types.ts — @diy-agent/attachment 的公开契约（纯类型，零 IO）
//
// 边界一句话：**本包只管「附件本体在哪、怎么取回」，不管「附件怎么进消息、怎么给模型看」**。
// 消息形状归 @diy-agent/protocol（`Item.chat.data.attachments`），给模型看的映射归
// @diy-agent/model-provider（`toModelMessages` 出 image part）。两处都只消费这里的
// `AttachmentRef`，不各自发明一份。
//
// 为什么 ref 分成 stored / linked 两支（本包的核心判断，2026-11-26 定）：
//   stored —— 字节**进了 blobs**：剪贴板图、远端下载、程序临时产物。本体不可从别处重建，
//             删了就没了 ⇒ 被消息引用期间不可清。
//   linked —— 字节**还在原处**：工作区里的文件、用户自己管着的目录。拷一份就是双份真相
//             （原件改了、消息里还是旧的），且大文件/目录库拷不动 ⇒ 只记路径。
//
// 判别键用 `type`（diy 规范 rule.code#discriminated-union）：`stored` / `linked`，
// 与判别键同级的字段 = 两支共有；两支私有的只有各自那一个位置字段（`relPath` / `path`）。

/** 附件的语义类别（决定 UI 怎么画、模型能不能"看"） */
export type AttachmentKind =
    /** 位图（png / jpeg / webp / gif …）—— 唯一会被塞进模型 content 的那一类 */
    | 'image'
    /** 任意单文件（pdf / 文本 / 音频 / 未知二进制） */
    | 'file'
    /** 打包后的目录（tar.gz / zip）—— 本体是一个文件，里面是树 */
    | 'archive'
    /** 目录引用（不打包、不拷贝，只给路径让 agent 自己 ls / fd） */
    | 'dir';

/**
 * 附件从哪来。**这一个字段决定「拷不拷」**（见 store.ts 的 adopted / stored 两条入口）：
 *
 *   paste  —— 剪贴板（⌘⇧⌃4 截图、浏览器「复制图像」）：无路径、无原名 ⇒ 必拷
 *   drop   —— 拖拽进窗口：有路径、有原名 ⇒ 拷（原文件可能被移走）
 *   pick   —— 文件选择器：同上
 *   path   —— 直接给一个已有路径（工作区文件 / 目录）⇒ 引用，不拷
 *   url    —— 远端地址（主进程下载）⇒ 拷（远端会 404）
 *   tool   —— agent 自己产（截图脚本、matplotlib、ffmpeg）⇒ 拷（内容是新的）
 *   relay  —— 另一个 bot / 房间递来的 ⇒ 已在 blobs 里，共享同一个 ref，不重复拷
 */
export type AttachmentSource = 'paste' | 'drop' | 'pick' | 'path' | 'url' | 'tool' | 'relay';

/** 图片来源信息（追源 / 重新取用 / 显示出处；不参与模型输入） */
export interface AttachmentOrigin {
    /** 远端地址（source=url，或浏览器「复制图像」带过来的源） */
    readonly url?: string;
    /** 产生它的那次工具调用（source=tool） */
    readonly toolCallId?: string;
    /** 从哪个房间 / 会话递来（source=relay） */
    readonly roomId?: string;
    /** 原件绝对路径（source=path/drop/pick；与 linked.path 重复，但 removed 后仍想知道原来在哪） */
    readonly originalPath?: string;
}

/** 位图尺寸（给 UI 排版 + 给模型侧判要不要缩图） */
export interface AttachmentImageSize {
    readonly width: number;
    readonly height: number;
}

/**
 * 归档 / 目录的内容概览。
 *
 * 为什么必须带：没有它，UI 上只有一个文件名、模型也不知道里面是什么
 * （它要细节就自己 `tar -tzf` / `ls`）。
 */
export interface AttachmentListing {
    /** 文件总数（不含目录条目） */
    readonly count: number;
    /** 总字节（解压后 / 目录实际占用；未知 = 缺省） */
    readonly bytes?: number;
    /** 样例路径（前 20 条，保留相对结构） */
    readonly sample: readonly string[];
    /** 扫描撞到上限就停了（`count` 只是「至少这么多」，别当准确值用） */
    readonly truncated?: boolean;
}

/** 两支共有的字段 */
export interface AttachmentBase {
    /**
     * 稳定 id。
     *   stored：`<YYYY-MM-DD>/<HHMMSS>-<batch8>/<NN>-<name>.<ext>`（可反解出磁盘位置）
     *   linked：`ref-<sha256(绝对路径) 前 12 位>`（路径不进 id —— id 会被塞进 json / URL）
     */
    readonly id: string;
    readonly kind: AttachmentKind;
    /** 以字节嗅探为准（不信调用方声明、更不信用户后缀） */
    readonly mime: string;
    readonly bytes: number;
    /** 原名（下载来的文件自带的名字就靠这个不丢；磁盘名是它 sanitize 后的安全副本） */
    readonly displayName: string;
    readonly source: AttachmentSource;
    readonly createdAt: number;
    /** 内容指纹。stored 必有；linked 的文件在 `hashLimit` 以内才有（目录没有：树会变） */
    readonly sha256?: string;
    readonly image?: AttachmentImageSize;
    readonly origin?: AttachmentOrigin;
    readonly listing?: AttachmentListing;
}

/** 字节进了 blobs（本包唯一写盘的形态） */
export type StoredAttachment = AttachmentBase & {
    readonly type: 'stored';
    /** 相对 `<home>/blobs` 的路径（`2026-11-26/093012-a1b2c3d4/01-shot.png`） */
    readonly relPath: string;
};

/** 字节还在原处（不拷贝） */
export type LinkedAttachment = AttachmentBase & {
    readonly type: 'linked';
    /** 绝对路径（文件或目录） */
    readonly path: string;
};

/** 一条附件的引用 —— 消息、协议、UI、模型映射四处共用的唯一形状 */
export type AttachmentRef = StoredAttachment | LinkedAttachment;

/** 一个批次 = 一次发送（同批多图共用一个目录，可整批删 / 整批回看） */
export interface AttachmentBatchId {
    /** `<YYYY-MM-DD>/<HHMMSS>-<batch8>` */
    readonly id: string;
}
