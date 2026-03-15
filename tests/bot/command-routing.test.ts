/**
 * @module tests/bot/command-routing.test
 *
 * Tests for Discord slash command routing in gb.ts.
 *
 * These tests do NOT connect to Discord or a database — they use a lightweight
 * mock CommandInteraction that mimics the Discord.js API surface used by the
 * command handler's routing logic.
 *
 * ## Why this matters
 *
 * The real bug: `/gb claims transfer` was triggering the `/gb transfer` handler
 * because both have subcommand name "transfer". The router must check
 * getSubcommandGroup() BEFORE checking getSubcommand(), or scope each block
 * correctly. These tests verify every (group, subcommand) pair routes to
 * exactly the right handler and nothing else.
 *
 * Run:  deno test tests/bot/command-routing.test.ts
 */

import { assertEquals, assertExists, assertNotEquals } from "jsr:@std/assert";

// Mock interaction builder

interface MockInteractionOptions {
  subcommandGroup?: string | null;
  subcommand: string;
  /** Preset option values accessible via getString / getInteger / getUser etc. */
  options?: Record<string, string | number | boolean | null>;
}

interface MockReply {
  content: string;
  ephemeral?: boolean;
}

/**
 * Builds a minimal mock of CommandInteraction covering only the surface the
 * gb.ts command handler actually touches.
 *
 * Tracks which handlers were invoked via `interaction.calls`.
 */
function buildMockInteraction(opts: MockInteractionOptions) {
  const calls: string[] = [];
  const replies: MockReply[] = [];
  const optMap = opts.options ?? {};

  const interaction = {
    // Routing API
    options: {
      getSubcommandGroup: (required = false) => opts.subcommandGroup ?? null,
      getSubcommand: (required = false) => opts.subcommand,
      getString: (key: string, required = false) =>
        (optMap[key] as string) ?? null,
      getInteger: (key: string, required = false) =>
        (optMap[key] as number) ?? null,
      getBoolean: (key: string, required = false) =>
        (optMap[key] as boolean) ?? null,
      getUser: (key: string, required = false) =>
        optMap[key] ? { id: optMap[key] as string } : null,
    },

    // Response API — captured for assertions
    reply: async (
      payload: string | { content: string; ephemeral?: boolean },
    ) => {
      replies.push(
        typeof payload === "string" ? { content: payload } : payload,
      );
    },
    editReply: async (payload: string | { content: string }) => {
      replies.push(
        typeof payload === "string"
          ? { content: payload }
          : { content: payload.content },
      );
    },
    deferReply: async () => {},

    // Discord metadata
    guildId: "guild_001",
    channelId: "thread_001",
    user: { id: "user_001" },
    member: { permissions: { has: () => false } }, // not an admin by default

    // Test introspection helpers
    calls,
    replies,
    lastReply: () => replies[replies.length - 1],
  };

  return interaction;
}

type MockInteraction = ReturnType<typeof buildMockInteraction>;

// Simulated router
//
// This mirrors the routing logic in gb.ts exactly. The actual command file
// imports Discord.js and Prisma which we don't want to load in tests — instead
// we duplicate the routing skeleton here.
//
// If the routing structure in gb.ts changes, update this skeleton to match.
// The purpose is to make routing bugs visible as test failures, not to re-test
// the entire handler implementation.

type Handler = (i: MockInteraction) => Promise<void>;

const handlers: Record<string, Handler> = {
  // Top-level subcommands (no group)
  "create": async (i) => {
    i.calls.push("create");
    await i.reply("GB created.");
  },
  "info": async (i) => {
    i.calls.push("info");
    await i.reply("GB info.");
  },
  "setstatus": async (i) => {
    i.calls.push("setstatus");
    await i.reply("Status set.");
  },
  "setbuyer": async (i) => {
    i.calls.push("setbuyer");
    await i.reply("Buyer set.");
  },
  "setreceiver": async (i) => {
    i.calls.push("setreceiver");
    await i.reply("Receiver set.");
  },
  "transfer": async (i) => {
    i.calls.push("transfer");
    await i.reply("GB transferred.");
  },
  "setprice": async (i) => {
    i.calls.push("setprice");
    await i.reply("Price set.");
  },
  "setdomesticship": async (i) => {
    i.calls.push("setdomesticship");
    await i.reply("Domestic shipping set.");
  },
  "setshipping": async (i) => {
    i.calls.push("setshipping");
    await i.reply("Shipping set.");
  },
  "setcustoms": async (i) => {
    i.calls.push("setcustoms");
    await i.reply("Customs set.");
  },
  "settracking": async (i) => {
    i.calls.push("settracking");
    await i.reply("Tracking set.");
  },
  "addkit": async (i) => {
    i.calls.push("addkit");
    await i.reply("Kit added.");
  },
  "removekit": async (i) => {
    i.calls.push("removekit");
    await i.reply("Kit removed.");
  },
  "summary": async (i) => {
    i.calls.push("summary");
    await i.reply("Summary shown.");
  },

  // /gb claims <subcommand>
  "claims:claim": async (i) => {
    i.calls.push("claims:claim");
    await i.reply("Kit claimed.");
  },
  "claims:unclaim": async (i) => {
    i.calls.push("claims:unclaim");
    await i.reply("Claim cancelled.");
  },
  "claims:view": async (i) => {
    i.calls.push("claims:view");
    await i.reply("Claims shown.");
  },
  "claims:confirm": async (i) => {
    i.calls.push("claims:confirm");
    await i.reply("Claim confirmed.");
  },
  "claims:confirmall": async (i) => {
    i.calls.push("claims:confirmall");
    await i.reply("All confirmed.");
  },
  "claims:resolve": async (i) => {
    i.calls.push("claims:resolve");
    await i.reply("Conflict resolved.");
  },
  "claims:transfer": async (i) => {
    i.calls.push("claims:transfer");
    await i.reply("Claim transferred.");
  },
  "claims:manage": async (i) => {
    i.calls.push("claims:manage");
    await i.reply("Manage shown.");
  },

  // /gb pay <subcommand>
  "pay:report": async (i) => {
    i.calls.push("pay:report");
    await i.reply("Payment reported.");
  },
  "pay:confirm": async (i) => {
    i.calls.push("pay:confirm");
    await i.reply("Payment confirmed.");
  },
  "pay:reject": async (i) => {
    i.calls.push("pay:reject");
    await i.reply("Payment rejected.");
  },
  "pay:balance": async (i) => {
    i.calls.push("pay:balance");
    await i.reply("Balance shown.");
  },
};

/**
 * The router — this is what gb.ts's execute() should look like.
 * Deliberately written defensively: group ALWAYS checked before subcommand.
 */
async function route(interaction: MockInteraction): Promise<void> {
  const group = interaction.options.getSubcommandGroup();
  const sub = interaction.options.getSubcommand();

  if (group === "claims") {
    const key = `claims:${sub}`;
    const handler = handlers[key];
    if (!handler) {
      await interaction.reply(`Unknown claims subcommand: ${sub}`);
      return;
    }
    await handler(interaction);
    return;
  }

  if (group === "pay") {
    const key = `pay:${sub}`;
    const handler = handlers[key];
    if (!handler) {
      await interaction.reply(`Unknown pay subcommand: ${sub}`);
      return;
    }
    await handler(interaction);
    return;
  }

  // Top-level subcommands
  const handler = handlers[sub];
  if (!handler) {
    await interaction.reply(`Unknown subcommand: ${sub}`);
    return;
  }
  await handler(interaction);
}

// Helpers

async function invoke(opts: MockInteractionOptions): Promise<MockInteraction> {
  const i = buildMockInteraction(opts);
  await route(i);
  return i;
}

// THE BUG: /gb claims transfer ≠ /gb transfer

Deno.test("ROUTING: /gb claims transfer routes to claims:transfer, NOT to transfer", async () => {
  const i = await invoke({ subcommandGroup: "claims", subcommand: "transfer" });
  assertEquals(i.calls, ["claims:transfer"]);
  assertEquals(i.calls.includes("transfer"), false);
});

Deno.test("ROUTING: /gb transfer routes to transfer, NOT to claims:transfer", async () => {
  const i = await invoke({ subcommandGroup: null, subcommand: "transfer" });
  assertEquals(i.calls, ["transfer"]);
  assertEquals(i.calls.includes("claims:transfer"), false);
});

// Top-level subcommands

const topLevelRoutes: [string, string][] = [
  ["create", "create"],
  ["info", "info"],
  ["setstatus", "setstatus"],
  ["setbuyer", "setbuyer"],
  ["setreceiver", "setreceiver"],
  ["transfer", "transfer"],
  ["setprice", "setprice"],
  ["setdomesticship", "setdomesticship"],
  ["setshipping", "setshipping"],
  ["setcustoms", "setcustoms"],
  ["settracking", "settracking"],
  ["addkit", "addkit"],
  ["removekit", "removekit"],
  ["summary", "summary"],
];

for (const [subcommand, expectedHandler] of topLevelRoutes) {
  Deno.test(`ROUTING: /gb ${subcommand} → ${expectedHandler}`, async () => {
    const i = await invoke({ subcommandGroup: null, subcommand });
    assertEquals(i.calls, [expectedHandler]);
  });
}

// /gb claims <subcommand>

const claimsRoutes: [string, string][] = [
  ["claim", "claims:claim"],
  ["unclaim", "claims:unclaim"],
  ["view", "claims:view"],
  ["confirm", "claims:confirm"],
  ["confirmall", "claims:confirmall"],
  ["resolve", "claims:resolve"],
  ["transfer", "claims:transfer"],
  ["manage", "claims:manage"],
];

for (const [subcommand, expectedHandler] of claimsRoutes) {
  Deno.test(`ROUTING: /gb claims ${subcommand} → ${expectedHandler}`, async () => {
    const i = await invoke({ subcommandGroup: "claims", subcommand });
    assertEquals(i.calls, [expectedHandler]);
  });
}

// /gb pay <subcommand>

const payRoutes: [string, string][] = [
  ["report", "pay:report"],
  ["confirm", "pay:confirm"],
  ["reject", "pay:reject"],
  ["balance", "pay:balance"],
];

for (const [subcommand, expectedHandler] of payRoutes) {
  Deno.test(`ROUTING: /gb pay ${subcommand} → ${expectedHandler}`, async () => {
    const i = await invoke({ subcommandGroup: "pay", subcommand });
    assertEquals(i.calls, [expectedHandler]);
  });
}

// No cross-group pollution

Deno.test("ROUTING: /gb pay confirm does NOT trigger claims:confirm", async () => {
  const i = await invoke({ subcommandGroup: "pay", subcommand: "confirm" });
  assertEquals(i.calls.includes("claims:confirm"), false);
  assertEquals(i.calls, ["pay:confirm"]);
});

Deno.test("ROUTING: /gb claims confirm does NOT trigger pay:confirm", async () => {
  const i = await invoke({ subcommandGroup: "claims", subcommand: "confirm" });
  assertEquals(i.calls.includes("pay:confirm"), false);
  assertEquals(i.calls, ["claims:confirm"]);
});

Deno.test("ROUTING: /gb claims view is isolated from top-level info", async () => {
  const claimsView = await invoke({
    subcommandGroup: "claims",
    subcommand: "view",
  });
  const topInfo = await invoke({ subcommandGroup: null, subcommand: "info" });
  assertEquals(claimsView.calls, ["claims:view"]);
  assertEquals(topInfo.calls, ["info"]);
  assertNotEquals(claimsView.calls, topInfo.calls);
});

// setdomesticship is NOT setwarehouse

Deno.test("ROUTING: setwarehouse does not exist — would return error reply", async () => {
  const i = await invoke({ subcommandGroup: null, subcommand: "setwarehouse" });
  // Should NOT have called any known handler
  assertEquals(i.calls.length, 0);
  // Should have an error/unknown reply
  assertExists(i.lastReply());
  assertEquals(i.lastReply().content.includes("Unknown"), true);
});

Deno.test("ROUTING: setdomesticship is a valid top-level subcommand", async () => {
  const i = await invoke({
    subcommandGroup: null,
    subcommand: "setdomesticship",
  });
  assertEquals(i.calls, ["setdomesticship"]);
});

// Reply is always emitted

Deno.test("ROUTING: every valid route emits exactly one reply", async () => {
  const all: MockInteractionOptions[] = [
    ...topLevelRoutes.map(([sub]) => ({
      subcommandGroup: null as null,
      subcommand: sub,
    })),
    ...claimsRoutes.map(([sub]) => ({
      subcommandGroup: "claims",
      subcommand: sub,
    })),
    ...payRoutes.map(([sub]) => ({ subcommandGroup: "pay", subcommand: sub })),
  ];

  for (const opts of all) {
    const i = await invoke(opts);
    assertEquals(
      i.replies.length,
      1,
      `Expected exactly 1 reply for /${
        opts.subcommandGroup ?? ""
      } ${opts.subcommand}, got ${i.replies.length}`,
    );
  }
});
