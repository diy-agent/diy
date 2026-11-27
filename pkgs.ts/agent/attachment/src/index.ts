// @diy-agent/attachment — 附件本体：存哪、怎么取回、拷还是引用
//
// 边界一句话：**本包只回答「字节在哪」**。附件怎么进消息归 @diy-agent/protocol
// （`Item.chat.data.attachments`），怎么变成模型的 image part 归 @diy-agent/model-provider
// （`toModelMessages`）。两处都只消费这里的 `AttachmentRef`，不各自发明一份形状。
//
//   import { createBlobStore } from '@diy-agent/attachment';
//
//   const blobs = createBlobStore({ root: join(home, 'blobs') });
//   const batch = blobs.beginBatch();                       // 一次发送 = 一个批次
//   const shot = await batch.putBytes({                      // 剪贴板截图：拷
//       bytes: pngBytes,
//       name: 'shot.png',
//       source: 'paste',
//   });
//   const doc = await blobs.adopt({ path: '/Users/me/report.pdf' }); // 工作区文件：引用，不拷
//
//   shot.relPath;   // '2026-11-26/093012-a1b2c3d4/01-shot.png'
//   await blobs.read(shot);   // 取回字节（带 sha256 校验）
//
// 磁盘形状与两条入口的取舍见 ./store.ts 头注；来源→拷/引用的判据见 ./types.ts 的
// `AttachmentSource` 注释。**一句话判据：能从别处重建的只记路径，不能的才拷。**

export { AttachmentError, type AttachmentErrorCode } from './errors.js';
export {
    createBlobStore,
    DEFAULT_HASH_LIMIT,
    DEFAULT_MAX_BYTES,
    type AdoptInput,
    type AttachmentBatch,
    type BlobStore,
    type BlobStoreOptions,
    type PutBytesInput,
    type PutFileInput,
} from './store.js';
export { extOfMime, isImageMime, mimeOfPath, sniffMime } from './mime.js';
export { fileNameOf, sanitizeStem, splitName } from './name.js';
export { imageSizeOf } from './image-size.js';
export { ATTACHMENT_KINDS, ATTACHMENT_SOURCES, parseAttachmentRef, parseAttachmentRefs } from './ref.js';
export type {
    AttachmentBase,
    AttachmentBatchId,
    AttachmentImageSize,
    AttachmentKind,
    AttachmentListing,
    AttachmentOrigin,
    AttachmentRef,
    AttachmentSource,
    LinkedAttachment,
    StoredAttachment,
} from './types.js';
