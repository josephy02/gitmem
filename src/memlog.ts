import * as fs from "node:fs";
import * as path from "node:path";
import { append, readAllEvents, verify, type AppendInput } from "./log.js";
import {
  isProjectionCurrent,
  project,
  renderBrief,
  writeProjections,
  type Projections,
} from "./projections.js";
import { readEvents, scopeContains } from "./scope.js";
import type {
  Capability,
  Conflict,
  EventFilter,
  Fact,
  FactFilter,
  MemEvent,
  TraceNode,
  VerifyResult,
} from "./types.js";

export class MemLog {
  private constructor(readonly root: string) {}

  static open(root: string): MemLog {
    if (!fs.existsSync(path.join(root, "memlog.config.json"))) {
      throw new Error(`${root} is not a memlog root (missing memlog.config.json); run memlog init`);
    }
    return new MemLog(root);
  }

  static init(root: string): MemLog {
    fs.mkdirSync(root, { recursive: true });
    const config = path.join(root, "memlog.config.json");
    if (!fs.existsSync(config)) {
      fs.writeFileSync(
        config,
        JSON.stringify({ capabilities: [{ principal: "human:owner", scopes: [""], mode: "admin" }] }, null, 2) + "\n",
      );
    }
    fs.mkdirSync(path.join(root, "log"), { recursive: true });
    return new MemLog(root);
  }

  append(input: AppendInput): string {
    return append(this.root, input);
  }

  events(): MemEvent[] {
    return readAllEvents(this.root);
  }

  read(cap: Capability, filter?: EventFilter): MemEvent[] {
    return readEvents(cap, this.events(), filter);
  }

  /** Reprojects lazily: callers never have to remember to project(). */
  project(opts: { force?: boolean } = {}): Projections {
    return writeProjections(this.root, this.events(), opts);
  }

  private fresh(): { events: MemEvent[]; projections: Projections } {
    const events = this.events();
    if (!isProjectionCurrent(this.root, events)) writeProjections(this.root, events);
    return { events, projections: project(events) };
  }

  facts(cap: Capability, filter: FactFilter = {}): Fact[] {
    const { events, projections } = this.fresh();
    const visible = new Set(readEvents(cap, events).map((e) => e.id));
    return projections.facts.filter((f) => {
      if (!visible.has(f.id)) return false;
      if (filter.scope !== undefined && !scopeContains(filter.scope, f.scope)) return false;
      if (filter.status !== undefined && f.status !== filter.status) return false;
      return true;
    });
  }

  conflicts(cap: Capability): Conflict[] {
    const { events, projections } = this.fresh();
    const visible = new Set(readEvents(cap, events).map((e) => e.id));
    return projections.conflicts.filter((c) => c.members.every((m) => visible.has(m)));
  }

  brief(cap: Capability, scope?: string): string {
    const { events, projections } = this.fresh();
    const visible = new Set(readEvents(cap, events).map((e) => e.id));
    const facts = projections.facts.filter((f) => visible.has(f.id));
    const overrideFile = path.join(this.root, "brief.override.md");
    const override = fs.existsSync(overrideFile) ? fs.readFileSync(overrideFile, "utf8") : null;
    const eventKind = new Map(events.map((e) => [e.id, e.kind]));
    const result = renderBrief(facts, eventKind, scope, override);
    if (result.dropped.length > 0) {
      process.stderr.write(`warning: brief truncated; dropped facts: ${result.dropped.join(", ")}\n`);
    }
    return result.markdown;
  }

  /** Event + full derivation ancestry. Point-get goes through readEvents too. */
  trace(cap: Capability, id: string): TraceNode {
    const events = this.events();
    const hit = readEvents(cap, events, { id });
    if (hit.length === 0) throw new Error(`no such event (or not readable): ${id}`);
    const visible = new Map(readEvents(cap, events).map((e) => [e.id, e]));
    const build = (e: MemEvent, seen: Set<string>): TraceNode => ({
      event: e,
      derived_from: e.derived_from
        .filter((d) => visible.has(d) && !seen.has(d))
        .map((d) => build(visible.get(d)!, new Set([...seen, d]))),
    });
    return build(hit[0], new Set([id]));
  }

  verify(): VerifyResult {
    return verify(this.root);
  }
}
