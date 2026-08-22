import * as fs from "node:fs";
import * as path from "node:path";
import { ulid } from "ulid";
import type { MemEvent, VerifyResult } from "./types.js";

const SCOPE_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export class ValidationError extends Error {}

export function logDir(root: string): string {
  return path.join(root, "log");
}

function dayFile(root: string, ts: string): string {
  // ts is ISO-8601 UTC: YYYY-MM-DDTHH:MM:SS.sssZ
  const [y, m, d] = ts.slice(0, 10).split("-");
  return path.join(logDir(root), y, m, `${d}.jsonl`);
}

/** Read every event in the log, sorted by ULID. Throws on malformed lines. */
export function readAllEvents(root: string): MemEvent[] {
  const dir = logDir(root);
  if (!fs.existsSync(dir)) return [];
  const events: MemEvent[] = [];
  for (const file of listLogFiles(dir)) {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      events.push(JSON.parse(line) as MemEvent);
    }
  }
  events.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return events;
}

function listLogFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export interface AppendInput {
  scope: string;
  author: MemEvent["author"];
  kind: MemEvent["kind"];
  body: string;
  derived_from?: string[];
  supersedes?: string[];
  confidence?: number;
  ttl_hint?: string;
  meta?: Record<string, unknown>;
  /** Bypass the ±24h clock-skew guard (for imports). */
  force?: boolean;
  /** Supply id/ts explicitly (imports, tests). */
  id?: string;
  ts?: string;
}

export function validate(e: MemEvent, existing: Map<string, MemEvent>, force = false): void {
  const fail = (msg: string) => {
    throw new ValidationError(msg);
  };
  if (!ULID_RE.test(e.id)) fail(`invalid ULID: ${e.id}`);
  if (existing.has(e.id)) fail(`duplicate id: ${e.id}`);
  const t = Date.parse(e.ts);
  if (Number.isNaN(t) || !e.ts.endsWith("Z")) fail(`invalid ts (must be ISO-8601 UTC with Z): ${e.ts}`);
  if (!force && Math.abs(t - Date.now()) > 24 * 3600 * 1000) fail(`ts more than 24h from now (use --force to override): ${e.ts}`);
  if (!SCOPE_RE.test(e.scope)) fail(`invalid scope: ${e.scope}`);
  if (e.body.trim() === "" || e.body.length > 4000) fail(`body must be non-empty and <= 4000 chars`);
  if (!(e.confidence >= 0 && e.confidence <= 1)) fail(`confidence must be in [0,1]: ${e.confidence}`);
  const needsTarget = e.kind === "correction" || e.kind === "retraction" || e.kind === "promotion";
  if (needsTarget && e.supersedes.length < 1) fail(`${e.kind} requires supersedes`);
  for (const id of [...e.supersedes, ...e.derived_from]) {
    if (!existing.has(id)) fail(`referenced event does not exist: ${id}`);
  }
  // supersedes must not create a cycle (multi-hop): walk from targets, never reach e.id
  const seen = new Set<string>();
  const stack = [...e.supersedes];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === e.id) fail(`supersedes cycle involving ${e.id}`);
    if (seen.has(cur)) continue;
    seen.add(cur);
    const target = existing.get(cur);
    if (target) stack.push(...target.supersedes);
  }
  if (e.ttl_hint !== undefined && Number.isNaN(Date.parse(e.ttl_hint))) fail(`invalid ttl_hint: ${e.ttl_hint}`);
}

function withLock<T>(root: string, fn: () => T): T {
  const lock = path.join(logDir(root), ".lock");
  fs.mkdirSync(logDir(root), { recursive: true });
  const deadline = Date.now() + 5000;
  let fd: number;
  for (;;) {
    try {
      fd = fs.openSync(lock, "wx");
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`could not acquire ${lock}`);
      const buf = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(buf), 0, 0, 25); // sleep 25ms
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

/** Append one event. Returns the new event's id. */
export function append(root: string, input: AppendInput): string {
  return withLock(root, () => {
    const existing = new Map(readAllEvents(root).map((e) => [e.id, e]));
    const e: MemEvent = {
      id: input.id ?? ulid(),
      ts: input.ts ?? new Date().toISOString(),
      scope: input.scope,
      author: input.author,
      kind: input.kind,
      body: input.body,
      derived_from: input.derived_from ?? [],
      supersedes: input.supersedes ?? [],
      confidence: input.confidence ?? (input.author.kind === "human" ? 1.0 : 0.8),
      ...(input.ttl_hint !== undefined && { ttl_hint: input.ttl_hint }),
      ...(input.meta !== undefined && { meta: input.meta }),
    };
    validate(e, existing, input.force);
    const file = dayFile(root, e.ts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, "a"); // O_APPEND
    try {
      fs.writeSync(fd, JSON.stringify(e) + "\n"); // single write: complete line or nothing
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return e.id;
  });
}

/** Integrity check: parseable lines, valid ULIDs, no duplicate ids, references exist, no cycles. */
export function verify(root: string): VerifyResult {
  const errors: string[] = [];
  const ids = new Set<string>();
  const events: MemEvent[] = [];
  const dir = logDir(root);
  if (fs.existsSync(dir)) {
    for (const file of listLogFiles(dir)) {
      const text = fs.readFileSync(file, "utf8");
      if (text !== "" && !text.endsWith("\n")) errors.push(`${file}: torn last line (missing newline)`);
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === "") continue;
        let e: MemEvent;
        try {
          e = JSON.parse(line) as MemEvent;
        } catch {
          errors.push(`${file}:${i + 1}: unparseable line`);
          continue;
        }
        if (!ULID_RE.test(e.id)) errors.push(`${file}:${i + 1}: invalid ULID ${e.id}`);
        if (ids.has(e.id)) errors.push(`duplicate id ${e.id} (bad merge?)`);
        ids.add(e.id);
        events.push(e);
      }
    }
  }
  for (const e of events) {
    for (const ref of [...e.supersedes, ...e.derived_from]) {
      if (!ids.has(ref)) errors.push(`${e.id} references missing event ${ref}`);
    }
  }
  return { ok: errors.length === 0, errors, events: events.length };
}
