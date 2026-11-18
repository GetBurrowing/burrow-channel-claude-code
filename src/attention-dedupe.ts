/**
 * Bounded LRU of chat attentions this process has seen, keyed by
 * `signal.message_id`.
 *
 * Core (#228, `Platform.Federation.DeliveryQueue`) redelivers a chat message
 * to a runtime that declared `attention_ack` when no ack arrives inside its
 * timeout, and again when the runtime rejoins. A redelivery is the SAME
 * message: shown twice, it is a duplicate turn. This is what turns it back
 * into one.
 *
 * It lives on the `SuiteClient` instance, not the connection, so it survives
 * every reconnect inside one process; a redelivery triggered by a rejoin is
 * the case it exists for. A process restart loses it, which costs at most one
 * repeat of a message the old process already showed.
 *
 * Each id is in one of two states:
 *   - `pending`: handed to the attention handler, not yet resolved. A second
 *     copy is dropped silently; the first will ack when it resolves.
 *   - `delivered`: handed to Claude Code. A second copy is dropped AND acked
 *     again, so core stops redelivering a message whose first ack was lost
 *     with the old socket.
 *
 * A handler that fails `forget`s its id, so the redelivery that follows the
 * missing ack is delivered rather than swallowed.
 */
export const ATTENTION_DEDUPE_CAPACITY = 500;

export type SeenState = "pending" | "delivered";

export class AttentionDedupe {
  private readonly entries = new Map<string, SeenState>();

  constructor(private readonly capacity: number = ATTENTION_DEDUPE_CAPACITY) {}

  /** The id's state, refreshing its recency, or `undefined` if unseen. */
  get(messageId: string): SeenState | undefined {
    const state = this.entries.get(messageId);
    if (state !== undefined) {
      this.entries.delete(messageId);
      this.entries.set(messageId, state);
    }
    return state;
  }

  /** Record `messageId` as most recent in `state`, evicting the oldest past capacity. */
  set(messageId: string, state: SeenState): void {
    this.entries.delete(messageId);
    this.entries.set(messageId, state);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  forget(messageId: string): void {
    this.entries.delete(messageId);
  }

  get size(): number {
    return this.entries.size;
  }
}
