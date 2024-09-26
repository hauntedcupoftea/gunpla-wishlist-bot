const { SlashCommandBuilder } = require('discord.js');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

export const data = new SlashCommandBuilder()
    .setName('wishlist')
    .setDescription('Manage your wishlist')
    .addSubcommand(subcommand => subcommand
        .setName('remove')
        .setDescription('Remove an item from your wishlist')
        .addStringOption(option => option
            .setName('item')
            .setDescription('The item to remove')
            .setRequired(true)
            .setAutocomplete(true)
        )
    );
export async function autocomplete(interaction) {
    const focusedValue = interaction.options.getString('item');
    if (focusedValue.length > 3) {
        const results = await prisma.wishlist.findMany({
            where: {
                userId: interaction.user.id,
                item: {
                    contains: focusedValue,
                    mode: 'insensitive',
                },
            },
            take: 5,
        });

        const options = results.map(wishlistItem => {
            return {
                name: wishlistItem.item,
                value: wishlistItem.item,
            };
        });

        await interaction.respond(options);
    } else {
        await interaction.respond([]);
    }
}
export async function execute(interaction) {
    const item = interaction.options.getString('item');
    const result = await prisma.wishlist.deleteMany({
        where: {
            userId: interaction.user.id,
            item: item,
        },
    });

    if (result.count > 0) {
        await interaction.reply(`Removed **${item}** from your wishlist!`);
    } else {
        await interaction.reply(`Item **${item}** not found in your wishlist.`);
    }
}
