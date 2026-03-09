/**
 * @module bot/commands/kit
 *
 * Discord slash command for kit catalogue management.
 * Delegates all DB access to src/services/kit.service.ts.
 */

import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from "discord.js";
import type { Wishlist } from "../../generated/client.ts";
import type { Command } from "../lib/command.ts";
import { fmtJpy } from "../lib/util.ts";
import * as KitService from "../services/kit.service.ts";

export default {
  data: new SlashCommandBuilder()
    .setName("kit")
    .setDescription("Kit catalogue commands")
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Add a new kit to the database")
        .addStringOption((o) =>
          o
            .setName("product_name")
            .setDescription("Full kit name")
            .setRequired(true)
        )
        .addIntegerOption((o) =>
          o
            .setName("jpy_price")
            .setDescription("MSRP in JPY")
            .setRequired(true)
        )
        .addIntegerOption((o) =>
          o
            .setName("weight_grams")
            .setDescription("Kit weight in grams (used for shipping split)")
            .setRequired(true)
        )
        .addStringOption((o) =>
          o
            .setName("availability")
            .setDescription("Source / availability")
            .setRequired(true)
        )
        .addStringOption((o) =>
          o
            .setName("item_code")
            .setDescription(
              "Supplier item code (e.g. BAN123456). Defaults to product name.",
            )
            .setRequired(false)
        )
        .addStringOption((o) =>
          o
            .setName("release_date")
            .setDescription('Release date (e.g. "September 2024")')
            .setRequired(false)
        )
        .addStringOption((o) =>
          o
            .setName("stock_status")
            .setDescription("Stock status")
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("info")
        .setDescription("View details for a kit")
        .addStringOption((o) =>
          o
            .setName("kit")
            .setDescription("Kit to look up")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("wanted")
        .setDescription("See which members have a kit on their wishlist")
        .addStringOption((o) =>
          o
            .setName("kit")
            .setDescription("Kit to look up")
            .setRequired(true)
            .setAutocomplete(true)
        )
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getString("kit") ?? "";
    if (focused.length === 0) {
      await interaction.respond([]);
      return;
    }

    const results = await KitService.searchKits(focused, 5);
    await interaction.respond(
      results.map((k) => ({ name: k.product_name, value: k.id })),
    );
  },

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "add") {
      try {
        const kit = await KitService.createKit({
          product_name: interaction.options.getString("product_name", true),
          jpy_price: interaction.options.getInteger("jpy_price", true),
          weight_grams: interaction.options.getInteger("weight_grams", true),
          availability: interaction.options.getString("availability", true),
          item_code: interaction.options.getString("item_code") ?? undefined,
          release_date: interaction.options.getString("release_date"),
          stock_status: interaction.options.getString("stock_status"),
        });
        await interaction.reply(
          `✅ Added **${kit.product_name}** to the catalogue.`,
        );
      } catch (err: any) {
        const isDupe = err.message?.includes("Unique constraint");
        await interaction.reply({
          content: isDupe
            ? "❌ A kit with that item code already exists."
            : "❌ Failed to add kit. Please try again.",
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    if (subcommand === "info") {
      const kitId = interaction.options.getString("kit", true);
      const kit = await KitService.getKitById(kitId);

      if (!kit) {
        await interaction.reply({
          content: "Kit not found.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(kit.product_name)
        .setColor(0x2b82cb)
        .addFields(
          { name: "Item Code", value: kit.item_code, inline: true },
          { name: "MSRP", value: fmtJpy(kit.jpy_price), inline: true },
          { name: "Availability", value: kit.availability, inline: true },
          {
            name: "Release Date",
            value: kit.release_date ?? "Unknown",
            inline: true,
          },
          {
            name: "Stock Status",
            value: kit.stock_status ?? "Unknown",
            inline: true,
          },
          {
            name: "Weight",
            value: kit.weight_grams ? `${kit.weight_grams}g` : "Unknown",
            inline: true,
          },
          {
            name: "Wishlisted",
            value: `${kit.wishlistCount} member${
              kit.wishlistCount !== 1 ? "s" : ""
            }`,
            inline: true,
          },
        );

      await interaction.reply({ embeds: [embed] });
    }

    if (subcommand === "wanted") {
      const kitId = interaction.options.getString("kit", true);
      const kit = await KitService.getKitById(kitId);

      if (!kit) {
        await interaction.reply({
          content: "Kit not found.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const wishlisters = await KitService.getKitWishlisters(kitId);

      if (wishlisters.length === 0) {
        await interaction.reply(
          `Nobody has **${kit.product_name}** on their wishlist yet.`,
        );
        return;
      }

      await interaction.reply(
        `Members wanting **${kit.product_name}** (${wishlisters.length}):\n` +
          wishlisters.map((w: Wishlist) => `- <@${w.userId}>`).join("\n"),
      );
    }
  },
} satisfies Command;
