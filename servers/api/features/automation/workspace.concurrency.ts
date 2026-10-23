export type WorkspaceConcurrencyGate = Readonly<{
  /** Takes one slot for the workspace, or returns false when a cap is reached. */
  acquire: (workspaceId: string) => boolean;
  /** Round-robin over candidate workspaces; skips workspaces at their own cap. Returns the workspace that got a slot. */
  acquireFair: (candidates: readonly string[]) => string | undefined;
  release: (workspaceId: string) => void;
  inFlight: (workspaceId: string) => number;
  totalInFlight: () => number;
}>;

const isPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

/**
 * Per-process fairness gate: one workspace can never hold more than `maxPerWorkspace` slots,
 * so a noisy workspace cannot consume all worker capacity. Candidate ids must come from a trusted
 * source (the scheduler listing workspaces with queued work).
 */
export const createWorkspaceConcurrencyGate = ({
  maxPerWorkspace,
  maxTotal
}: Readonly<{ maxPerWorkspace: number; maxTotal: number }>): WorkspaceConcurrencyGate => {
  if (!isPositiveInteger(maxPerWorkspace) || !isPositiveInteger(maxTotal) || maxPerWorkspace > maxTotal) {
    throw new Error("Concurrency caps must be positive integers with maxPerWorkspace <= maxTotal.");
  }
  const counts = new Map<string, number>();
  let total = 0;
  let lastServed = "";

  const acquire = (workspaceId: string): boolean => {
    if (workspaceId.length === 0) return false;
    const current = counts.get(workspaceId) ?? 0;
    if (current >= maxPerWorkspace || total >= maxTotal) return false;
    counts.set(workspaceId, current + 1);
    total += 1;
    return true;
  };

  const release = (workspaceId: string): void => {
    const current = counts.get(workspaceId) ?? 0;
    if (current <= 0) return;
    if (current === 1) counts.delete(workspaceId);
    else counts.set(workspaceId, current - 1);
    total -= 1;
  };

  const acquireFair = (candidates: readonly string[]): string | undefined => {
    const ordered = [...new Set(candidates)].sort();
    if (ordered.length === 0) return undefined;
    const next = ordered.findIndex((id) => id > lastServed);
    const startIndex = next === -1 ? 0 : next;
    for (let offset = 0; offset < ordered.length; offset += 1) {
      const id = ordered[(startIndex + offset) % ordered.length];
      if (id !== undefined && acquire(id)) {
        lastServed = id;
        return id;
      }
    }
    return undefined;
  };

  return Object.freeze({
    acquire,
    acquireFair,
    release,
    inFlight: (workspaceId: string): number => counts.get(workspaceId) ?? 0,
    totalInFlight: (): number => total
  });
};