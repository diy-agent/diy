import type { Component } from "@mariozechner/pi-tui";

/**
 * A generator function that yields components for container composition.
 * Allows use of TypeScript control flow (if/else, for, while) inside composition.
 */
export type ComponentGenerator = () => Iterable<Component>;

export type { Component };
