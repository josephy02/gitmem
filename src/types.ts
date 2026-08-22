export type EventKind =
  | "observation"
  | "decision"
  | "correction"
  | "retraction"
  | "promotion";

export interface Author {
  kind: "agent" | "human" | "system";
  id: string;
  session?: string;
}

export interface MemEvent {
  id: string;
  ts: string;
  scope: string;
  author: Author;
  kind: EventKind;
  body: string;
  derived_from: string[];
  supersedes: string[];
  confidence: number;
  ttl_hint?: string;
  meta?: Record<string, unknown>;
}

export type FactStatus = "live" | "superseded" | "retracted" | "expired" | "contested";

export interface Fact {
  id: string;
  scope: string;
  body: string;
  author: Author;
  valid_from: string;
  valid_until: string | null;
  status: FactStatus;
  confidence: number;
  supersedes: string[];
  superseded_by: string[];
  derived_from: string[];
  /** ids of conflict partners when status === "contested" */
  conflicts_with?: string[];
}

export interface Conflict {
  id: string;
  members: string[];
  detected_by: "explicit" | "negation" | "divergence";
  detected_at: string;
  resolution: null;
}

export interface Capability {
  principal: string;
  scopes: string[];
  mode: "read" | "write" | "admin";
}

export interface EventFilter {
  scope?: string;
  kind?: EventKind;
  id?: string;
  since?: string;
  until?: string;
}

export interface FactFilter {
  scope?: string;
  status?: FactStatus;
}

export interface Config {
  capabilities: Capability[];
}

export interface VerifyResult {
  ok: boolean;
  errors: string[];
  events: number;
}

export interface Stats {
  [scope: string]: {
    events_by_kind: Record<string, number>;
    facts_by_status: Record<string, number>;
    first_ts: string;
    last_ts: string;
    authors: Record<string, number>;
  };
}

export interface TraceNode {
  event: MemEvent;
  derived_from: TraceNode[];
}
