import type { Capability, EventFilter, MemEvent } from "./types.js";

/** Segment-aware prefix match: "team/core" grants "team/core" and descendants,
 *  but not "team/core-secrets". */
export function scopeContains(prefix: string, scope: string): boolean {
  if (scope === prefix) return true;
  return scope.startsWith(prefix + "/");
}

/** Effective scope per event: promotions (in ULID order) reassign the scope of
 *  the events they target. The log retains the original scope; access control
 *  and reads use the effective one — otherwise a promotion that narrows scope
 *  would still be readable under the old, broader scope.
 */
export function effectiveScopes(events: MemEvent[]): Map<string, string> {
  const eff = new Map<string, string>();
  for (const e of events) eff.set(e.id, e.scope);
  for (const e of events) {
    if (e.kind !== "promotion") continue;
    for (const target of e.supersedes) {
      if (eff.has(target)) eff.set(target, e.scope);
    }
  }
  return eff;
}

/** THE choke point. Every read path — search, point-get, brief, facts,
 *  conflicts, trace, stats, CLI — goes through this. Do not add a second one. */
export function readEvents(cap: Capability, events: MemEvent[], filter: EventFilter = {}): MemEvent[] {
  const eff = effectiveScopes(events);
  return events.filter((e) => {
    const scope = eff.get(e.id)!;
    if (!cap.scopes.some((s) => scopeContains(s, scope))) return false;
    if (filter.scope !== undefined && !scopeContains(filter.scope, scope)) return false;
    if (filter.kind !== undefined && e.kind !== filter.kind) return false;
    if (filter.id !== undefined && e.id !== filter.id) return false;
    if (filter.since !== undefined && e.ts < filter.since) return false;
    if (filter.until !== undefined && e.ts > filter.until) return false;
    return true;
  });
}
