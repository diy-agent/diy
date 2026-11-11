// use-controllable-state.ts —— 受控 / 非受控统一取值（替代 @radix-ui/react-use-controllable-state）。
//
// 为什么不用 radix 那个包：本项目的组件层是 Base UI 阵营（components.json 的 base-nova），
// 引一个 radix 小包只为 15 行逻辑不值得，也免得两套原语并存。
//
// 语义与 radix 版一致：有 prop 时以 prop 为准（受控），否则用内部 state；
// 每次切换都调 onChange（受控时由调用方决定要不要理会）。

import * as React from 'react';

export function useControllableState<T>(opts: {
    prop?: T | undefined;
    defaultProp: T;
    onChange?: ((value: T) => void) | undefined;
}): [T, (next: T) => void] {
    const { prop, defaultProp, onChange } = opts;
    const [uncontrolled, setUncontrolled] = React.useState<T>(defaultProp);
    const controlled = prop !== undefined;
    const value = controlled ? prop : uncontrolled;
    const onChangeRef = React.useRef(onChange);
    onChangeRef.current = onChange;
    const setValue = React.useCallback(
        (next: T) => {
            if (!controlled) setUncontrolled(next);
            onChangeRef.current?.(next);
        },
        [controlled],
    );
    return [value, setValue];
}
