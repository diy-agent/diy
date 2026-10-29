// @diy/room — diy 协作空间内核：成员表 + `@` 投递 + 忙闲
//
// 边界一句话：**一个房间 = 谁在 + 谁对谁说**。单会话怎么跑归 @diy/agent-session，
// 任务状态归宿主 —— 所以本包 import 清单里绝不允许出现任务标识 / @diy/task / 文件系统模块 /
// electron / 应用数据根（##456 硬判据，意图测试 R7 静态扫）。
//
//   import { createRoom } from '@diy/room';
//   import { createSession } from '@diy/agent-session';
//
//   const room = createRoom({ id: 'room-1' });
//   room.addMember({ id: 'human:me', name: '我', kind: 'human' });
//   room.addMember({ id: 'agent:a', name: '甲', kind: 'agent', session: sessionA });
//   room.addMember({ id: 'agent:b', name: '乙', kind: 'agent', session: sessionB });
//
//   for await (const event of room.post({ from: 'human:me', text: '@甲 @乙 开工' })) {
//       if (event.kind === 'response') console.log(event.author, event.content);
//   }
//
// 收件人解析 / 投递状态机 / 忙闲粒度的细节见 ./types.ts 与 ./room.ts 头注。

export { RoomError } from './errors.js';
export type { RoomErrorCode } from './errors.js';

export { parseMentions, resolveRecipients } from './mentions.js';

export type {
    Clock,
    Delivery,
    DeliveryState,
    MemberKind,
    PostInput,
    PublicLogEntry,
    PublicLogKind,
    Room,
    RoomEvent,
    RoomEventKind,
    RoomMember,
    RoomMemberInit,
    RoomMemberSnapshot,
    RoomSnapshot,
    RoomStore,
    SessionDelta,
    SessionPeer,
} from './types.js';

export { createRoom } from './room.js';
export type { CreateRoomOptions } from './room.js';
