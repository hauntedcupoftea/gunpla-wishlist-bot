/**
 * @module bot/commands/wishlist
 *
 * Discord slash command for wishlist management.
 * Delegates all DB access to src/services/kit.service.ts.
 */

import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { Kit, Wishlist } from "../../generated/client.ts";
import type { Command } from "../lib/command.ts";
import { fmtJpy } from "../lib/util.ts";
import type { KitSearchResult } from "../services/kit.service.ts";
import * as KitService from "../services/kit.service.ts";

type WishlistWithKit = Wishlist & { kit: Kit };

export default {
  data: new SlashCommandBuilder()
    .setName("wishlist")
    .setDescription("Manage your wishlist")
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Add a kit to your wishlist")
        .addStringOption((o) =>
          o
            .setName("kit")
            .setDescription("Kit to add")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove a kit from your wishlist")
        .addStringOption((o) =>
          o
            .setName("kit")
            .setDescription("Kit to remove")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("view").setDescription("View your wishlist")
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getString("kit") ?? "";
    const subcommand = interaction.options.getSubcommand();

    if (focused.length === 0) {
      await interaction.respond([]);
      return;
    }

    if (subcommand === "add") {
      const results = await KitService.searchKits(focused, 5);
      await interaction.respond(
        results.map((k: KitSearchResult) => ({
          name: k.product_name,
          value: k.id,
        })),
      );
    } else if (subcommand === "remove") {
      const wishlist = await KitService.getUserWishlist(interaction.user.id);
      const filtered = wishlist.filter((w: WishlistWithKit) =>
        w.kit.product_name.toLowerCase().includes(focused.toLowerCase())
      );
      await interaction.respond(
        filtered
          .slice(0, 5)
          .map((w: WishlistWithKit) => ({
            name: w.kit.product_name,
            value: w.kitId,
          })),
      );
    } else {
      await interaction.respond([]);
    }
  },

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (subcommand === "add") {
      const kitId = interaction.options.getString("kit", true);
      try {
        await KitService.addToWishlist(userId, kitId);
        const kit = await KitService.getKitById(kitId);
        await interaction.reply({
          content: `✅ Added **${kit?.product_name}** to your wishlist!`,
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        await interaction.reply({
          content: "That kit is already on your wishlist.",
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    if (subcommand === "remove") {
      const kitId = interaction.options.getString("kit", true);
      const removed = await KitService.removeFromWishlist(userId, kitId);

      if (removed) {
        const kit = await KitService.getKitById(kitId);
        await interaction.reply({
          content: `Removed **${kit?.product_name}** from your wishlist.`,
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: "That kit isn't on your wishlist.",
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    if (subcommand === "view") {
      const wishlist = await KitService.getUserWishlist(userId);

      if (wishlist.length === 0) {
        await interaction.reply({
          content: "Your wishlist is empty.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const lines = wishlist.map(
        (w: WishlistWithKit) =>
          `- **${w.kit.product_name}** (${fmtJpy(w.kit.jpy_price)})`,
      );
      await interaction.reply({
        content: `Your wishlist (${wishlist.length} kit${
          wishlist.length !== 1 ? "s" : ""
        }):\n${lines.join("\n")}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  },
} satisfies Command;
