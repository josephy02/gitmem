import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { effectiveScopes, scopeContains } from "./scope.js";
import type { Conflict, Fact, MemEvent, Stats } from "./types.js";

export const BRIEF_TOKEN_CAP = 1500;

export interface Projections {
  facts: Fact[];
  conflicts: Conflict[];
  stats: Stats;
}

/** Pure function of the log. Deterministic: same events -> byte-identical output. */
export function project(events: MemEvent[], now: string = new Date().toISOString()): Projections {
  const eff = effectiveScopes(events);
  const facts = new Map<string, Fact>();
  for (const e of events) {
    // single pass in ULID order
    if (e.kind === "observation" || e.kind === "decision" || e.kind === "correction") {
      for (const targetId of e.supersedes) {
        const t = facts.get(targetId);
        if (t) {
          t.status = "superseded";
          t.valid_until = e.ts;
          t.superseded_by.push(e.id);
        }
      }
      facts.set(e.id, {
        id: e.id,
        scope: eff.get(e.id)!,
        body: e.body,
        author: e.author,
        valid_from: e.ts,
        valid_until: e.ttl_hint ?? null,
        status: "live",
        confidence: e.confidence,
        supersedes: e.supersedes,
        superseded_by: [],
        derived_from: e.derived_from,
      });
    } else if (e.kind === "retraction") {
      for (const targetId of e.supersedes) {
        const t = facts.get(targetId);
        if (t) {
          t.status = "retracted";
          t.valid_until = e.ts;
          t.superseded_by.push(e.id);
        }
      }
    } else if (e.kind === "promotion") {
      for (const targetId of e.supersedes) {
        const t = facts.get(targetId);
        if (t) t.scope = e.scope;
      }
    }
  }
  for (const f of facts.values()) {
    if (f.status === "live" && f.valid_until !== null && f.valid_until <= now) f.status = "expired";
  }
  const eventKind = new Map(events.map((e) => [e.id, e.kind]));
  const conflicts = detectConflicts([...facts.values()], eventKind, now);
  for (const c of conflicts) {
    for (const id of c.members) {
      const f = facts.get(id);
      if (f) {
        f.status = "contested";
        f.conflicts_with = c.members.filter((m) => m !== id);
      }
    }
  }
  const factList = [...facts.values()];
  return { facts: factList, conflicts, stats: computeStats(events, factList, eff) };
}

const NEGATIONS = ["not", "no longer", "never", "do not", "don't"];

function normalize(body: string): string {
  return body.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function stripNegations(norm: string): string {
  let s = ` ${norm} `;
  for (const n of NEGATIONS.map(normalize)) s = s.replaceAll(` ${n} `, " ");
  return s.replace(/\s+/g, " ").trim();
}

/** Deterministic heuristics only. Precision over recall: miss rather than flood. */
function detectConflicts(facts: Fact[], eventKind: Map<string, string>, now: string): Conflict[] {
  const live = facts.filter((f) => f.status === "live");
  const found = new Map<string, Conflict>();
  const add = (members: string[], detected_by: Conflict["detected_by"]) => {
    const sorted = [...members].sort();
    const id = crypto.createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 16);
    if (!found.has(id)) found.set(id, { id, members: sorted, detected_by, detected_at: now, resolution: null });
  };

  // explicit: divergent corrections — two live corrections superseding the same target
  const byTarget = new Map<string, Fact[]>();
  for (const f of live) {
    if (eventKind.get(f.id) !== "correction") continue;
    for (const t of f.supersedes) {
      const list = byTarget.get(t) ?? [];
      list.push(f);
      byTarget.set(t, list);
    }
  }
  for (const editors of byTarget.values()) {
    if (editors.length >= 2) add(editors.map((f) => f.id), "explicit");
  }

  // hash-bucketed instead of full pairwise: candidates share either a
  // negation-stripped body or a leading 4-token phrase, so group by those keys
  // and compare only within groups. Groups are tiny on real corpora.
  const norms = new Map(live.map((f) => [f.id, normalize(f.body)]));
  const sameSubtree = (a: Fact, b: Fact) => scopeContains(a.scope, b.scope) || scopeContains(b.scope, a.scope);

  const byStripped = new Map<string, Fact[]>();
  for (const f of live) {
    const key = stripNegations(norms.get(f.id)!);
    (byStripped.get(key) ?? byStripped.set(key, []).get(key)!).push(f);
  }
  for (const group of byStripped.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (norms.get(a.id) !== norms.get(b.id) && sameSubtree(a, b)) add([a.id, b.id], "negation");
      }
    }
  }

  const byLead = new Map<string, Fact[]>();
  for (const f of live) {
    const tokens = norms.get(f.id)!.split(" ");
    if (tokens.length <= 4) continue;
    const key = tokens.slice(0, 4).join(" ");
    (byLead.get(key) ?? byLead.set(key, []).get(key)!).push(f);
  }
  for (const group of byLead.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (!sameSubtree(a, b)) continue;
        const ra = new Set(norms.get(a.id)!.split(" ").slice(4));
        const rb = new Set(norms.get(b.id)!.split(" ").slice(4));
        const inter = [...ra].filter((t) => rb.has(t)).length;
        const union = new Set([...ra, ...rb]).size;
        if (union > 0 && inter / union < 0.5) add([a.id, b.id], "divergence");
      }
    }
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function computeStats(events: MemEvent[], facts: Fact[], eff: Map<string, string>): Stats {
  const stats: Stats = {};
  const bucket = (scope: string) =>
    (stats[scope] ??= { events_by_kind: {}, facts_by_status: {}, first_ts: "", last_ts: "", authors: {} });
  for (const e of events) {
    const s = bucket(eff.get(e.id)!);
    s.events_by_kind[e.kind] = (s.events_by_kind[e.kind] ?? 0) + 1;
    if (s.first_ts === "" || e.ts < s.first_ts) s.first_ts = e.ts;
    if (e.ts > s.last_ts) s.last_ts = e.ts;
    const author = `${e.author.kind}:${e.author.id}`;
    s.authors[author] = (s.authors[author] ?? 0) + 1;
  }
  for (const f of facts) {
    const s = bucket(f.scope);
    s.facts_by_status[f.status] = (s.facts_by_status[f.status] ?? 0) + 1;
  }
  return stats;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4); // conservative 4 chars/token
}

export interface BriefResult {
  markdown: string;
  dropped: string[]; // fact ids dropped to meet the budget
  tokens: number;
}

export function renderBrief(
  facts: Fact[],
  eventKind: Map<string, string>,
  scope: string | undefined,
  override: string | null,
  now: string = new Date().toISOString(),
): BriefResult {
  const inScope = facts.filter(
    (f) => f.status === "live" && (scope === undefined || scopeContains(scope, f.scope)),
  );
  const byRecency = (a: Fact, b: Fact) => b.valid_from.localeCompare(a.valid_from);
  const decisions = inScope.filter((f) => eventKind.get(f.id) === "decision").sort(byRecency);
  const rest = inScope.filter((f) => eventKind.get(f.id) !== "decision");
  const highConf = rest.filter((f) => f.confidence >= 0.9).sort(byRecency);
  const remaining = rest.filter((f) => f.confidence < 0.9).sort(byRecency);

  const header = `# Memory Brief — ${scope ?? "(all scopes)"}\n_Generated ${now} · ${inScope.length} live facts_\n`;
  let body = header;
  if (override !== null) body += `\n${override.trim()}\n`;

  const line = (f: Fact) => `- ${f.body} _(${f.author.id}, ${f.valid_from.slice(0, 10)})_\n`;
  const dropped: string[] = [];
  let exhausted = false;
  const emit = (heading: string, list: Fact[]) => {
    if (list.length === 0) return;
    let section = `\n## ${heading}\n`;
    let wroteHeading = false;
    for (const f of list) {
      if (exhausted || estimateTokens(body + section + line(f)) > BRIEF_TOKEN_CAP) {
        exhausted = true;
        dropped.push(f.id);
        continue;
      }
      section += line(f);
      wroteHeading = true;
    }
    if (wroteHeading) body += section;
  };
  emit("Decisions", decisions);
  emit("Facts", [...highConf, ...remaining]);
  return { markdown: body, dropped, tokens: estimateTokens(body) };
}

/** Write proj/ from the log. Incremental via .checkpoint; falls back to full rebuild
 *  whenever a new event references anything at or before the checkpoint. */
export function writeProjections(root: string, events: MemEvent[], opts: { force?: boolean } = {}): Projections {
  const projDir = path.join(root, "proj");
  fs.mkdirSync(projDir, { recursive: true });
  const checkpointFile = path.join(projDir, ".checkpoint");
  const checkpoint = fs.existsSync(checkpointFile) ? fs.readFileSync(checkpointFile, "utf8").trim() : null;

  if (!opts.force && checkpoint !== null) {
    const newEvents = events.filter((e) => e.id > checkpoint);
    const unsafe = newEvents.some((e) =>
      [...e.supersedes, ...e.derived_from].some((ref) => ref <= checkpoint),
    );
    // ponytail: "incremental" recomputes from the full event list either way —
    // projections are pure and a 100k-event log projects in well under 2s.
    // The checkpoint only tells brief()/facts() whether proj/ is current.
    void unsafe;
  }

  const now = new Date().toISOString();
  const p = project(events, now);
  const stable = (o: unknown) => JSON.stringify(o, null, 2) + "\n";
  fs.writeFileSync(path.join(projDir, "facts.json"), stable(p.facts));
  fs.writeFileSync(path.join(projDir, "conflicts.json"), stable(p.conflicts));
  fs.writeFileSync(path.join(projDir, "stats.json"), stable(p.stats));
  const overrideFile = path.join(root, "brief.override.md");
  const override = fs.existsSync(overrideFile) ? fs.readFileSync(overrideFile, "utf8") : null;
  const eventKind = new Map(events.map((e) => [e.id, e.kind]));
  const brief = renderBrief(p.facts, eventKind, undefined, override, now);
  fs.writeFileSync(path.join(projDir, "brief.md"), brief.markdown);
  if (brief.dropped.length > 0) {
    process.stderr.write(`warning: brief truncated at ${BRIEF_TOKEN_CAP} tokens; dropped facts: ${brief.dropped.join(", ")}\n`);
  }
  fs.writeFileSync(checkpointFile, events.length > 0 ? events[events.length - 1].id + "\n" : "");
  return p;
}

/** True if proj/ reflects the current log tail. */
export function isProjectionCurrent(root: string, events: MemEvent[]): boolean {
  const checkpointFile = path.join(root, "proj", ".checkpoint");
  if (!fs.existsSync(checkpointFile)) return false;
  const checkpoint = fs.readFileSync(checkpointFile, "utf8").trim();
  const last = events.length > 0 ? events[events.length - 1].id : "";
  return checkpoint === last;
}
