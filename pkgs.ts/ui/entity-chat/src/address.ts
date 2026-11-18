// address.ts —— 「现在在看哪儿」的唯一真相：一个能直接写进地址栏的**普通路径**。
//
// 为什么是 `/room/task/t-001` 而不是 `#/room/task/t-001`：
//   diy2 的 UI 由我们自己的 node HTTP server 提供，两条路都已经做了 SPA 回退 ——
//     dev  ：vite 以 middleware 挂进同一个 server，`appType:'spa'`（server/dev.ts:52）；
//     prod ：static.ts「命中文件就发，否则回退 index.html」（server/static.ts:66-68）。
//   于是 `/room/xxx` 刷新时服务器给的就是 index.html，有没有 `#` 都能直达。
//   hash 唯一的好处是「不会发给服务器」，这一条我们不需要；代价却是地址栏里永远有一段 `#`，
//   复制、grep、贴进 issue 都难看。
//
// ⚠ 两个来自 server 侧（不是本文件实现细节）的硬约束：
//   1. 第一段不能是 `api`：dev.ts:63 与 app.ts:760 把 `/api` 分流给 JSON 接口，
//      以它开头的地址永远到不了页面。
//   2. 不能和真实静态文件同名（`/perf.html`、`/assets/x.js`、`/favicon.ico`）：
//      static.ts 先查磁盘，命中就直接发文件，页面根本不会启动。所以 page 段用
//      `room` / `task-run` 这类词，别用带扩展名或和产物撞名的词。
//
// 形状是 `/<page>/<kind>/<local>`：room id 的写法本来就是 `kind:local`（`task:t-001`、
// `proj:diy`），把那个冒号换成路径分隔符 —— 于是
//
//     proj:diy            → /room/proj/diy
//     task:t-001          → /room/task/t-001
//     task-mf3k2ab        → /room/task-mf3k2ab      （运行时新建的 id 没有冒号，就一段）
//     task:projects/1/tasks/1 → /room/task/projects%2F1%2Ftasks%2F1
//
// **只换第一个冒号**，这是可逆的关键：如果反过来「只要多段就把第一段当 kind」，
// 那 /room/a/b 既可能是 id `a:b` 也可能是 id `a/b`，两种拼法指向不同房间，地址就不再
// 唯一决定位置了。所以规则必须是「有冒号才展开」，encode 侧产出什么、decode 侧就认什么。
// 顺带的好处：老的 `/room/task:t-001`（单段、冒号没转）在同一套规则下仍然解析得回来，
// 已经贴出去的链接不会烂。
//
// 这里只有纯函数 —— 不认识 React、不认识 store、不碰 window。碰了就没法在 node 里测，
// 也没法被非浏览器宿主（diy-app / remote）复用。

/** 一个可寻址的位置。page 不枚举：插件贡献的条目也得能寻址。 */
export interface NavAddress {
    /** 页类型。现在只有一个（`room`），将来是 `task-run` / `project` … */
    page: string;
    /** 该领域内的稳定 id（就是 room id；**不再单存 kind**，见下） */
    id: string;
}

/** 当前唯一的页类型 */
export const DEFAULT_PAGE = 'room';

/**
 * 已注册的页类型。地址里出现没注册的页 = 坏地址（手改的、插件卸载后的旧链接）。
 *
 * 现在只有 `room`；将来插件贡献页面时调 `registerPage` 加进来 —— 这跟侧栏插槽是同
 * 一个原则：**壳认得的位置才有位置**，而不是地址里写什么就认什么。
 */
const knownPages = new Set<string>([DEFAULT_PAGE]);

export function registerPage(page: string): void {
    if (page !== '') knownPages.add(page);
}

export function knownPage(page: string): boolean {
    return knownPages.has(page);
}

// kind（project / task / …）**故意不进地址**：它已经能从 `roomOf(id).type` 查到，
// 存进地址就是一份会过期的副本 —— 地址说 task、数据里改成 project 的那天，
// 谁对？以数据为准，地址只记「是哪个」，不记「是什么」。

export function addressOf(page: string, id: string): NavAddress {
    return { page, id };
}

/** id 里 kind 与 local 的分隔符（room id 的既有写法，不改数据层） */
const KIND = ':';

/**
 * 单个路径段的转义：只处理会破坏「分段 / 查询 / 片段」的字符。
 *
 * 不用 `encodeURIComponent` 的理由：它把 `:` 也编成 `%3A`，`/room/task%3At-001` 读不出来，
 * 而 `:` 在路径段里是合法字符（RFC 3986 pchar 含 ':'）。
 * 中文也不转：浏览器地址栏会显示原文，`location.pathname` 拿回来是已编码的，decode 后一致。
 * 但 `/` **必须**转义 —— 否则 local 里那个斜杠（`task:projects/1/tasks/1`）会被当成
 * 三段路径，往返之后就变成 kind=`projects` 了。
 */
/**
 * 点段的转义前缀。
 *
 * 为什么不用 `%2E`：WHATWG URL 规范把「`%2E` 单段」和「`.`」一样视为 *single-dot
 * path segment*，浏览器处理时**直接忽略那一段** —— `/room/%2E/x` 在地址栏里会变成
 * `/room/x`，id 从 `.:x` 静默变成 `x`（指错房间）。`%2E%2E` 同理，还会往上跳一层。
 *
 * 换个不带点的前缀：`.` → `~.`、`..` → `~..`。`~` 是 pchar，浏览器不会碰；decode 侧
 * 只认**原文**以 `~` 开头且整体就是点段的情况，所以 id 真的是 `~.` 时也有救（`~` 在
 * encodeSegment 里先被编成 `%7E`，原文不再以 `~` 开头）。
 */
const DOT_ESCAPE = '~';

function encodeSegment(text: string): string {
    const escaped = text
        .replace(/%/g, '%25')
        .replace(/~/g, '%7E')
        .replace(/\//g, '%2F')
        .replace(/#/g, '%23')
        .replace(/\?/g, '%3F')
        .replace(/ /g, '%20');
    // `.` / `..` 单独成段是路径里的「本层 / 上一层」，浏览器会在地址栏里吃掉它们
    if (escaped === '.' || escaped === '..') return DOT_ESCAPE + escaped;
    return escaped;
}

/**
 * id → 路径尾段：有 `kind:local` 就拆成两段，否则整段。
 *
 * `at <= 0`（`:` 在开头）与 `at` 在末尾（`task:`）都退回整段：宁可地址里露个冒号，
 * 也不产出一个尾斜杠或空段 —— 那种地址 parse 回来是另一个 id。
 */
function formatId(id: string): string {
    const at = id.indexOf(KIND);
    if (at <= 0 || at === id.length - 1) return encodeSegment(id);
    return `${encodeSegment(id.slice(0, at))}/${encodeSegment(id.slice(at + 1))}`;
}

/** 坏转义（`%zz`）原样返回 —— 地址栏是用户能改的输入，不该因此抛异常 */
function decode(raw: string): string {
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

/** 段原文是 `~.` / `~..` 才当点段解开；`%7E.` 这种是用户真写了 `~.` */
function decodeSegment(raw: string): string {
    if (raw === `${DOT_ESCAPE}.` || raw === `${DOT_ESCAPE}..`) return raw.slice(1);
    return decode(raw);
}

/** `/room/task/t-001` —— 直接给 `history.pushState` 和 `<a href>` 用 */
export function formatAddress(address: NavAddress): string {
    return `/${encodeSegment(address.page)}/${formatId(address.id)}`;
}

/**
 * 解析 `location.pathname`。**宽松**：认得就返回，认不得返回 undefined（不抛、不猜）。
 *
 * 认不得是常态：`/`（首屏）、`/perf.html`（多入口的另一个 HTML）、手滑的旧书签，
 * 都该静默落到默认页，而不是把界面炸掉。
 */
export function parseAddress(pathname: string): NavAddress | undefined {
    // 查询串和片段不属于地址（`?debug=1` 之类不影响「在看哪儿」）
    const path = (pathname.split('#')[0] ?? '').split('?')[0] ?? '';
    const parts = path.split('/').filter((part) => part !== '');
    // 至少两段：page + id。只有 `/room` 不构成位置（没有 id 不知道该看哪个）
    if (parts.length < 2) return undefined;
    const page = decodeSegment(parts[0]!);
    const segments = parts.slice(1).map((part) => decodeSegment(part));
    // 两段以上 = `kind/local`，用冒号拼回 id；单段 = 整个 id（`task-mf3k2ab`、老地址
    // `/room/task:t-001`）。三段以上时后面全是 local —— 它内部的 `/` 在 encode 侧已被
    // 转义成 `%2F`，所以这里能确定「第二段之后都属于 local」，不存在歧义。
    const id = segments.length === 1 ? segments[0]! : `${segments[0]!}${KIND}${segments.slice(1).join('/')}`;
    if (page === '' || id === '') return undefined;
    return { page, id };
}

/**
 * 地址栏里的写法是不是已经是规范形态。
 *
 * 和 `sameAddress(parseAddress(path), address)` 不是一回事：那只问「指向同一个位置」，
 * 这里问「写法也对」。老地址 `/room/task:t-001` 与 `/room/task/t-001` 指的是一处，
 * 但前者的写法该被纠正 —— 一个位置只能有一个地址，否则分享、grep、active 判断全带歧义。
 *
 * `encodeURI` 是为了中文 id：浏览器把 pathname 里的非 ASCII 编成 `%XX`，而 formatAddress
 * 输出原文，两边写法本来就该算同一形态（否则每次刷新都会多 replaceState 一次）。
 */
export function isCanonicalPath(pathname: string, address: NavAddress): boolean {
    const canonical = formatAddress(address);
    return pathname === canonical || pathname === encodeURI(canonical);
}

/** 两段地址是不是同一个位置（用于「已经在这儿了就别再导航」，否则 pushState 会堆历史） */
export function sameAddress(a: NavAddress | undefined, b: NavAddress | undefined): boolean {
    if (a === undefined || b === undefined) return a === b;
    return a.page === b.page && a.id === b.id;
}

/**
 * 刷新 / 首屏时重新确定「在看哪儿」：三步顺序，纯函数（store 只负责提供事实）。
 *
 *   1. 内存里已有合法位置 → 保持（改名 / 改状态触发的 refresh 不该动位置）；
 *   2. 地址栏里有 → 用它（首屏、别人贴进来的链接）；
 *   3. 都不成立 → `fallback`（第一个房间；一个房间都没有时是空地址）。
 *
 * 「合法」由调用方给：对 room 页 = 这个 id 现在真的在 rooms 里；未知页 = 不合法。
 * 抽成纯函数是因为这三步最容易写错（谁优先、地址栏坏了怎么办），而它本来埋在
 * 依赖 window 的 store 里，一条测试都盖不到。
 */
export function pickAddress(input: {
    current: NavAddress;
    fromUrl?: NavAddress | undefined;
    known: (address: NavAddress) => boolean;
    fallback: NavAddress;
}): NavAddress {
    if (input.current.id !== '' && input.known(input.current)) return input.current;
    if (input.fromUrl !== undefined && input.known(input.fromUrl)) return input.fromUrl;
    return input.fallback;
}

/**
 * room 的地址 —— 把「侧栏列表里的一项」和「地址里的一个位置」说成同一件事。
 *
 * 将来插件贡献的条目**不需要是 room**，只要能说出自己的 `page` + `id`。
 */
export function roomAddressOf(room: { id: string }): NavAddress {
    return addressOf(DEFAULT_PAGE, room.id);
}
