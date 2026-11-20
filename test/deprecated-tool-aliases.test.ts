// The `suite_*` tool names are deprecated aliases of the `burrow_*` tools.
//
// Agents started before the rename still call `suite_reply` and friends, and
// they cannot all be restarted at once, so each old name must stay listed and
// must reach exactly the same handler as its new name. These tests pin both:
// the ListTools surface (every alias listed, same schema, description points
// at the new name) and the dispatcher (an alias call produces the same client
// calls and the same result as the primary call).

import { describe, expect, test } from "bun:test";

import { callTool, DEPRECATED_TOOL_ALIASES, TOOL_DEFINITIONS } from "../src/tools.ts";

const SPACE = "0199aaaa-bbbb-cccc-dddd-eeeeffff0001";

function recordingSuite() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const suite = {
    sendReply: (...args: unknown[]) => {
      calls.push({ fn: "sendReply", args });
      return Promise.resolve({ message_id: "msg-1" });
    },
    sendReplyWithMedia: (...args: unknown[]) => {
      calls.push({ fn: "sendReplyWithMedia", args });
      return Promise.resolve({ message_id: "msg-2" });
    },
    sendTyping: (...args: unknown[]) => {
      calls.push({ fn: "sendTyping", args });
    },
    lastTypingRefusal: () => undefined,
    sendReplyChunk: (...args: unknown[]) => {
      calls.push({ fn: "sendReplyChunk", args });
    },
    lastChunkRefusal: () => undefined,
  };
  return { suite, calls };
}

const ARGS: Record<string, unknown> = {
  burrow_reply: { space_id: SPACE, content: "hi", context: "ctx" },
  burrow_reply_with_media: {
    space_id: SPACE,
    content: "see attached",
    attachments: [{ filename: "a.png", content_type: "image/png", data: "AAAA" }],
  },
  burrow_typing: { space_id: SPACE, typing: true },
  burrow_reply_chunk: { space_id: SPACE, chunk_id: "c1", text: "all", done: true },
};

describe("deprecated suite_* tool aliases", () => {
  test("the four burrow_* tools are listed first, then the four aliases", () => {
    expect(TOOL_DEFINITIONS.map((d) => d.name)).toEqual([
      "burrow_reply",
      "burrow_reply_with_media",
      "burrow_typing",
      "burrow_reply_chunk",
      "suite_reply",
      "suite_reply_with_media",
      "suite_typing",
      "suite_reply_chunk",
    ]);
  });

  for (const [alias, target] of Object.entries(DEPRECATED_TOOL_ALIASES)) {
    test(`${alias} lists the same schema as ${target} and says it is deprecated`, () => {
      const a = TOOL_DEFINITIONS.find((d) => d.name === alias)!;
      const p = TOOL_DEFINITIONS.find((d) => d.name === target)!;
      expect(a.inputSchema).toEqual(p.inputSchema);
      expect(a.description).toStartWith(`Deprecated alias of \`${target}\``);
      expect(p.description).not.toContain("Deprecated");
    });

    test(`${alias} dispatches exactly like ${target}`, async () => {
      const viaAlias = recordingSuite();
      const viaPrimary = recordingSuite();
      const r1 = await callTool(viaAlias.suite, alias, ARGS[target]);
      const r2 = await callTool(viaPrimary.suite, target, ARGS[target]);
      expect(viaPrimary.calls.length).toBeGreaterThan(0);
      expect(viaAlias.calls).toEqual(viaPrimary.calls);
      expect(r1).toEqual(r2);
    });
  }

  test("an unknown name is still refused (control: the alias map is not a catch-all)", async () => {
    const { suite } = recordingSuite();
    await expect(callTool(suite, "suite_nope", {})).rejects.toThrow("unknown tool: suite_nope");
  });
});
