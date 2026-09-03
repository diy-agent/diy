// @ts-nocheck
export interface RendererActions { navigate?: (page: string) => void; focus?: (uri: string) => void; toast?: (message: string, level: string) => void; }
let _actions: RendererActions = {};
export function setRendererActions(a: RendererActions) { _actions = a; }
export function resetRendererActions() { _actions = {}; }
export function getRendererActions() { return _actions; }
