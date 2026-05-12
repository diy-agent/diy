/**
 * 用户操作不当引发的业务异常。
 * CLI 层捕获后仅打印 message（不打印调用栈），以 1 退出。
 * 其他 Error 保留 stack trace 帮助调试。
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}
