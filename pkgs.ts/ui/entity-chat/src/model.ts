// model.ts —— 类型从 chat-core 来；这里只留 UI 用的常量与再导出（避免两处定义漂移）。

export type { Author, Bot, Delivery, Entity, EntityKind, Item } from '@diy-agent/chat-core';
export { botsOf, dirOf, ownerOfBot } from '@diy-agent/chat-core';

export const DIR_SUGGESTIONS = ['~/git/diy/diy', '~/git/diy/diy-research', '~/git/cops', '~/git/sha'];
