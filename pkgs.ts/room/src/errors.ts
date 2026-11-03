// errors.ts — @diy-agent/room 统一错误类型
//
// 同 @diy-agent/session：不静默丢弃。找不到收件人 / 成员重复 / 空发言一律报错；
// 「记录但不投递」是**显式状态**（没有收件人），不是异常。

/** 错误分类（UI / 测试 / 宿主按此判断处置方式） */
export type RoomErrorCode =
    /** createRoom 入参非法（id 为空 / store 形状不对） */
    | 'room/invalid-options'
    /** 房间 id 非法（空串 / 含 `..` / 结尾 `/` —— 将来要当目录名） */
    | 'room/invalid-id'
    /** 成员字段非法（id / name / kind / session 形状不对）或重复加入 */
    | 'room/invalid-member'
    /** post 入参非法（from 不存在 / text 为空 / to 不是数组） */
    | 'room/invalid-post'
    /** `@` 到 / `to` 里点名了房间成员表里没有的人（不静默忽略：否则发言者以为送到了） */
    | 'room/unknown-recipient';

/** 本包唯一错误类型：带 `code`（机器判据）与 `path`（从根到字段的点路径） */
export class RoomError extends Error {
    readonly code: RoomErrorCode;
    /** 出错位置的点路径；空串表示整体 */
    readonly path: string;

    constructor(code: RoomErrorCode, message: string, path = '') {
        super(path === '' ? `${code}: ${message}` : `${code} @ ${path}: ${message}`);
        this.name = 'RoomError';
        this.code = code;
        this.path = path;
    }
}
