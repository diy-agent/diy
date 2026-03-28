// Re-exports for the public API
export type { ComponentGenerator, Component } from "./types.js";
export { App, FunctionalApp, createApp } from "./app.js";
export { Horizontal, Vertical, Panel } from "./containers.js";
export { Label, Header, Rule, Pill, LogLine } from "./components.js";
export type { ChatMessage } from "./chat.js";
export { ChatBubble, Input, SlashCommandSuggestion } from "./chat.js";

// Also re-export commonly used types from pi-tui for convenience
export { Text as PiText } from "@mariozechner/pi-tui";
