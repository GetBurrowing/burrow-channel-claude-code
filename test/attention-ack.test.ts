// attention_ack + message_id dedupe (follow-up to core #228).
//
// Core's DeliveryQueue redelivers a chat message to a runtime that declared
// `attention_ack` until it gets `attention_ack {message_id}`, on ack timeout
// and on every rejoin. These tests pin the plugin's half of that contract:
//
//   - the ack goes out only AFTER the handler resolved (the notification was
//     handed to Claude Code), never before, and never when it rejects;
//   - a redelivered message_id is shown once, across reconnects, and is acked
//     again so core stops redelivering;
//   - attentions without a message_id keep the old ~1s identity bucket and are
//     never acked (core does not track them).

import { describe, expect, mock, test } from "bun:test";
import { AttentionDedupe } from "../src/attention-dedupe.ts";

class FakePush {
  handlers: Record<string, (payload?: unknown) => void> = {};
  receive(status: string, cb: (payload?: unknown) => void): this {
    this.handlers[status] = cb;
    return this;
  }
}

class FakeChannel {
  handlers: Record<string, (payload: any) => void> = {};
  pushes: Array<{ event: string; payload: any }> = [];
  constructor(
    public topic: string,
    public params: unknown,
  ) {}
  on(event: string, cb: (payload: any) => void): void {
    this.handlers[event] = cb;
  }
  push(event: string, payload: unknown): FakePush {
    this.pushes.push({ event, payload });
    return new FakePush();
  }
  join(): FakePush {
    return new FakePush();
  }
  leave(): void {}
  emit(event: string, payload: unknown): void {
    this.handlers[event]?.(payload);
  }
  acks(): string[] {
    return this.pushes.filter((p) => p.event === "attention_ack").map((p) => p.payload.message_id);
  }
}

class FakeSocket {
  lastChannel: FakeChannel | null = null;
  constructor(
    public url: string,
    public opts: unknown,
  ) {}
  channel(topic: string, params: unknown): FakeChannel {
    this.lastChannel = new FakeChannel(topic, params);
    return this.lastChannel;
  }
  onOpen(): void {}
  onClose(): void {}
  onError(): void {}
  onMessage(): void {}
  isConnected(): boolean {
    return true;
  }
  connect(): void {}
  disconnect(): void {}
}

mock.module("phoenix", () => ({ Socket: FakeSocket, Channel: FakeChannel }));

const { SuiteClient } = await import("../src/suite-client.ts");

const flush = () => new Promise((r) => setTimeout(r, 0));

function chat(messageId: string, content = "hello") {
  return {
    signal: { reason: "mention", space_id: "space-1", message_id: messageId },
    message: { content, author: "Jordan" },
  };
}

function client(onAttention: (payload: any) => void | Promise<void>) {
  const c: any = new SuiteClient(
    {
      url: "ws://localhost/socket",
      runtimeId: "rt",
      token: "t",
      reconnectIntervalMs: 1_000_000,
      maxReconnectIntervalMs: 1_000_000,
    },
    { onAttention, onDisconnect: () => {} },
  );
  c.connect();
  const channel = () => c.socket.lastChannel as FakeChannel;
  return { c, channel };
}

describe("attention_ack", () => {
  test("acks signal.message_id after the handler resolves, not before", async () => {
    let release!: () => void;
    const handed = new Promise<void>((r) => (release = r));
    const { c, channel } = client(() => handed);

    channel().emit("attention", chat("m-1"));
    await flush();
    expect(channel().acks()).toEqual([]);

    release();
    await flush();
    expect(channel().pushes).toContainEqual({ event: "attention_ack", payload: { message_id: "m-1" } });
    c.disconnect();
  });

  test("a rejected handler sends no ack and lets the redelivery through", async () => {
    let calls = 0;
    const { c, channel } = client(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("stdio closed"));
    });

    channel().emit("attention", chat("m-2"));
    await flush();
    expect(channel().acks()).toEqual([]);

    channel().emit("attention", chat("m-2"));
    await flush();
    expect(calls).toBe(2);
    expect(channel().acks()).toEqual(["m-2"]);
    c.disconnect();
  });

  test("an attention without a message_id is delivered but never acked", async () => {
    const seen: unknown[] = [];
    const { c, channel } = client((p) => void seen.push(p));

    channel().emit("attention", { signal: { reason: "system_event", prompt: "do the review" } });
    await flush();
    expect(seen.length).toBe(1);
    expect(channel().acks()).toEqual([]);
    c.disconnect();
  });
});

describe("message_id dedupe", () => {
  test("a redelivery of a shown message is not shown again, and is re-acked", async () => {
    const seen: string[] = [];
    const { c, channel } = client((p) => void seen.push(p.signal.message_id));

    channel().emit("attention", chat("m-3"));
    await flush();
    // Seconds later, so the old 1s bucket would NOT have caught it.
    channel().emit("attention", chat("m-3"));
    await flush();

    expect(seen).toEqual(["m-3"]);
    expect(channel().acks()).toEqual(["m-3", "m-3"]);
    c.disconnect();
  });

  test("a copy arriving while the first is still in flight is dropped; the first acks", async () => {
    let release!: () => void;
    const handed = new Promise<void>((r) => (release = r));
    let calls = 0;
    const { c, channel } = client(() => {
      calls += 1;
      return handed;
    });

    channel().emit("attention", chat("m-4"));
    channel().emit("attention", chat("m-4"));
    await flush();
    expect(calls).toBe(1);

    release();
    await flush();
    expect(channel().acks()).toEqual(["m-4"]);
    c.disconnect();
  });

  test("the dedupe survives a reconnect: core's rejoin redelivery is shown once and acked on the new channel", async () => {
    const seen: string[] = [];
    const { c, channel } = client((p) => void seen.push(p.signal.message_id));

    channel().emit("attention", chat("m-5"));
    await flush();
    const first = channel();

    c.connect(); // a reconnect builds a new socket and channel on the same client
    const second = channel();
    expect(second).not.toBe(first);

    second.emit("attention", chat("m-5"));
    await flush();

    expect(seen).toEqual(["m-5"]);
    expect(second.acks()).toEqual(["m-5"]);
    c.disconnect();
  });

  test("distinct message_ids with identical content are both shown", async () => {
    const seen: string[] = [];
    const { c, channel } = client((p) => void seen.push(p.signal.message_id));

    channel().emit("attention", chat("m-6", "same"));
    channel().emit("attention", chat("m-7", "same"));
    await flush();

    expect(seen).toEqual(["m-6", "m-7"]);
    c.disconnect();
  });
});

describe("AttentionDedupe", () => {
  test("is bounded and evicts the least recently used id", () => {
    const lru = new AttentionDedupe(3);
    lru.set("a", "delivered");
    lru.set("b", "delivered");
    lru.set("c", "delivered");
    expect(lru.get("a")).toBe("delivered"); // touch: b is now oldest
    lru.set("d", "delivered");

    expect(lru.size).toBe(3);
    expect(lru.get("b")).toBeUndefined();
    expect(lru.get("a")).toBe("delivered");
    expect(lru.get("d")).toBe("delivered");
  });

  test("forget drops an id so it can be delivered again", () => {
    const lru = new AttentionDedupe(3);
    lru.set("a", "pending");
    lru.forget("a");
    expect(lru.get("a")).toBeUndefined();
  });
});
