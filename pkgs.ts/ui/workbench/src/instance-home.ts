/**
 * instance-home.ts —— **实例运行空间**的唯一真源（##518：dev 与 diy-app 同构）。
 *
 * 问题（真踩到）：dev 从没设置过 `app.setPath("userData", …)`，于是所有 dev 实例共用
 * Electron 的缺省 userData（`~/Library/Application Support/<name>`）：
 *   · **单实例锁是全局的** —— 语义错了（两个不同数据根的实例本来就该能并存）；
 *   · **`DevToolsActivePort` 也是全局的** —— 读到的可能是别的实例的端口；
 *   · Chromium 的缓存 / Local Storage / GPU 缓存互相踩。
 * diy-app 早就这么做了（`<home>/electron_user_data`），dev 没跟上 —— 于是「独占」无从谈起。
 *
 * 结论（与 diy 同构）：**独占的粒度 = 数据根**。先把 userData 落到 `<home>/electron_user_data`，
 * 再拿单实例锁；锁按 userData 分家，天然就是「一个数据根一个实例」。
 *
 * 顺序很关键：`setPath` 必须在 `app.requestSingleInstanceLock()` 与 `whenReady()` **之前**，
 * 否则锁文件已经建在缺省 userData 里了（Chromium 建锁发生在第一次取 app 状态时）。
 */

import { join } from "node:path";
import { SINGLETON_LOCK, classifyLock, lockAdvice, readLock } from "./single-instance.js";

/** Electron 需要的两个方法（只取用得到的，便于测试里注入假的） */
export interface ElectronAppLike {
    setPath(name: "userData", path: string): void;
    requestSingleInstanceLock(): boolean;
    quit(): void;
    getPath(name: "userData"): string;
}

/** `<home>/electron_user_data`：与 diy-app 同口径（它的 `AppConfig.electronUserData` 也是这个） */
export function userDataDirOf(home: string): string {
    return join(home, "electron_user_data");
}

/** 把 userData 落到数据根下（**必须在 requestSingleInstanceLock / whenReady 之前调**） */
export function configureUserData(app: ElectronAppLike, home: string): string {
    const dir = userDataDirOf(home);
    app.setPath("userData", dir);
    return dir;
}

export interface AcquireOptions {
    /** 打印一行诊断/拒绝信息（app 自己决定用 console 还是日志文件） */
    readonly log?: (line: string) => void;
}

/**
 * 取单实例锁。**拿不到就打印「为什么 + 下一步」并返回 false**（调用方负责 quit）。
 *
 * 为什么不用 `app.quit()` 直接了事：这正是本仓库反复吃的亏 —— 沉默退出没人知道原因。
 * `lockAdvice()` 会区分「活实例占锁 / 陈旧锁 / 跨机锁 / 形态异常」给不同建议。
 */
export function acquireSingleInstance(app: ElectronAppLike, options: AcquireOptions = {}): boolean {
    const log = options.log ?? ((line: string) => console.warn(line));
    if (app.requestSingleInstanceLock()) return true;
    const lockPath = join(app.getPath("userData"), SINGLETON_LOCK);
    log(`[instance] 这个数据根上已经有一个实例在跑：${lockAdvice(classifyLock(readLock(lockPath)), lockPath)}`);
    return false;
}
