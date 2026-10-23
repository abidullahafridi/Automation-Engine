import type { ReleaseSnapshot } from "./release.flags.js";

/**
 * Single-document release configuration. One revision covers flags AND kill switch,
 * so a change is atomic. A zero-match update is a conflict, never success.
 */
export type ReleaseControlStore = Readonly<{
  read: () => Promise<ReleaseSnapshot>;
  compareAndSet: (expectedRevision: number, next: ReleaseSnapshot) => Promise<"updated" | "conflict">;
}>;

/**
 * In-memory implementation for tests and the flag-OFF path.
 * A durable adapter is not part of this task (see release-gates.md).
 */
export const createInMemoryReleaseControlStore = (initial: ReleaseSnapshot): ReleaseControlStore => {
  let current = initial;
  return Object.freeze({
    read: () => Promise.resolve(current),
    compareAndSet: (expectedRevision, next) => {
      if (current.revision !== expectedRevision || next.revision !== expectedRevision + 1) {
        return Promise.resolve("conflict" as const);
      }
      current = next;
      return Promise.resolve("updated" as const);
    }
  });
};