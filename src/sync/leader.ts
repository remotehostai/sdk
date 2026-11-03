// One leader tab per workspace (sync design 5.4, N15; app backends design
// 4.2): elected with Web Locks (`rh-sync:<workspace>`), it owns the device,
// the outbox and the socket. Other tabs read the shared store and send their
// writes to the leader over a BroadcastChannel. A tab that loses the lock
// stops writing to the outbox at once.

import type { BroadcastChannelLike, LeaderEnvironment, WriteOutcome } from "./types.js";
import type { Op } from "./generated/protocol.js";
import { randomToken } from "./ids.js";

export type LeaderMessage =
  | { kind: "write"; id: string; ops: Op[]; batch: boolean }
  | { kind: "outcomes"; id: string; outcomes: WriteOutcome[] }
  | { kind: "changed" }
  | { kind: "status"; status: string }
  /** A tab that just joined asks the leader for its status. */
  | { kind: "ask" };

/** The browser's Web Locks and BroadcastChannel, when both exist. */
export function browserLeaderEnvironment(): LeaderEnvironment | null {
  const nav = (globalThis as { navigator?: { locks?: LeaderEnvironment["locks"] } }).navigator;
  const BC = (globalThis as { BroadcastChannel?: new (name: string) => BroadcastChannelLike })
    .BroadcastChannel;
  if (!nav?.locks || !BC) return null;
  return { locks: nav.locks, channel: (name) => new BC(name) };
}

export interface LeaderHooks {
  /** This tab became the leader: open the socket. */
  lead(): Promise<void>;
  /** This tab lost the lead (stop): stop writing at once. */
  resign(): void;
  /** A follower's write, for the leader to run. */
  write(ops: Op[], batch: boolean): Promise<WriteOutcome[]>;
  /** Another tab changed the store: reload it. */
  changed(): void;
  /** The leader's status, for a follower to show. */
  status(status: string): void;
  /** This tab's status, for the leader to answer a tab that just joined. */
  current(): string;
}

export class Leadership {
  private abort = new AbortController();
  private release: (() => void) | null = null;
  private channel: BroadcastChannelLike;
  private waiting = new Map<string, (o: WriteOutcome[]) => void>();
  leading = false;

  constructor(
    private readonly env: LeaderEnvironment,
    private readonly workspace: string,
    private readonly hooks: LeaderHooks,
  ) {
    this.channel = env.channel(`rh-sync:${workspace}`);
    this.channel.addEventListener("message", (e) => void this.onMessage(e.data as LeaderMessage));
  }

  /** Queues for the lock; resolves at once (the lead may come later). */
  start(): void {
    void this.env.locks
      .request(`rh-sync:${this.workspace}`, { signal: this.abort.signal }, async () => {
        this.leading = true;
        const held = new Promise<void>((resolve) => (this.release = resolve));
        await this.hooks.lead();
        await held;
      })
      .catch(() => undefined);
    // The leader posts its status only when it changes: a tab that joins
    // while it is steady asks, so it shows the leader's status at once.
    this.post({ kind: "ask" });
  }

  stop(): void {
    if (this.leading) {
      this.leading = false;
      this.hooks.resign();
    }
    this.abort.abort();
    this.release?.();
    this.release = null;
    this.channel.close();
    for (const resolve of this.waiting.values()) resolve([]);
    this.waiting.clear();
  }

  /** A follower's write, forwarded to the leader; resolves with its outcomes. */
  forward(ops: Op[], batch: boolean): Promise<WriteOutcome[]> {
    const id = randomToken(12);
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.post({ kind: "write", id, ops, batch });
    });
  }

  post(message: LeaderMessage): void {
    this.channel.postMessage(message);
  }

  private async onMessage(m: LeaderMessage): Promise<void> {
    switch (m.kind) {
      case "write": {
        if (!this.leading) return;
        const outcomes = await this.hooks.write(m.ops, m.batch);
        this.post({ kind: "outcomes", id: m.id, outcomes });
        return;
      }
      case "outcomes": {
        const resolve = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        resolve?.(m.outcomes);
        return;
      }
      case "changed":
        if (!this.leading) this.hooks.changed();
        return;
      case "status":
        if (!this.leading) this.hooks.status(m.status);
        return;
      case "ask":
        if (this.leading) this.post({ kind: "status", status: this.hooks.current() });
        return;
    }
  }
}
