// errors.ts —— 把 SDK / 网络错误翻译成人能读的一句话（别把堆栈甩给用户）。

/** 常见失败 → 人能读的提示；认不出来就返回第一行原文 */
export function friendlyError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    const cause = (error as { cause?: { message?: string } } | undefined)?.cause?.message ?? '';

    if (/Connect Timeout|connect timeout/i.test(raw) || /ConnectTimeout/i.test(cause)) {
        const host = /\(attempted address: ([^,\s)]+)/.exec(raw)?.[1] ?? '模型网关';
        return `连不上 ${host}（连接超时）。检查网络 / 代理，或换一个模型后重试。`;
    }
    if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET/i.test(`${raw} ${cause}`)) {
        return '网络请求失败（DNS 或连接被拒）。检查网络后重试。';
    }
    if (/BodyStreamBuffer|aborted|abort/i.test(`${raw} ${cause}`)) {
        return '模型响应被中断（连接中止）。重试一次；如果反复出现，检查网络或换模型。';
    }
    if (/Failed to process successful response/i.test(raw)) {
        return '模型网关返回了无法解析的响应（provider 侧问题）。重试一次，或换一个模型。';
    }
    if (/\b401\b|Unauthorized|invalid api key/i.test(raw)) {
        return '模型网关拒绝了请求：API key 无效或过期。';
    }
    // 额度用尽不是「限流」：429 里夹着 usage limit / quota 的一律先认出来，
    // 并把网关自己给的「多久后重置」抄进话术 —— 那是用户唯一能行动的信息
    // （2026-11-25：一轮 turn 撞 OpenCode Go 月度额度，界面上只说「稍后重试」）。
    if (/usage limit|quota exceeded|insufficient_quota|GoUsageLimitError/i.test(`${raw} ${cause}`)) {
        const reset = /resets? in ([^."]+)/i.exec(`${raw} ${cause}`)?.[1]?.trim();
        const tail = reset === undefined ? '' : `，${reset} 后重置`;
        return `模型额度已用尽${tail}。换一个模型，或等它重置（这一轮不会再自动重试）。`;
    }
    if (/\b429\b|rate limit/i.test(raw)) {
        return '模型网关限流（429），稍后重试。';
    }
    if (/\b5\d\d\b/.test(raw)) {
        return `模型网关返回服务端错误（${/\b5\d\d\b/.exec(raw)?.[0] ?? '5xx'}），稍后重试。`;
    }
    return raw.split('\n')[0] ?? raw;
}
