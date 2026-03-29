// Re-exports for the public API
export type { ComponentGenerator, Component } from "./types.js";
export { App, FunctionalApp, createApp } from "./app.js";
export { Horizontal, Vertical, Panel } from "./containers.js";
export { Text, Text as Label, Header, Rule, Pill, LogLine } from "./components.js";
export type { ChatMessage } from "./chat.js";
export { ChatBubble, Input, SlashCommandSuggestion } from "./chat.js";
