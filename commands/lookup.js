const { SlashCommandBuilder } = require('discord.js');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const data = new SlashCommandBuilder()
    .setName('lookup')
    .setDescription('Find users looking for a specific kit.')
    .addStringOption(option =>
        option
            .setName('kit')
            .setDescription('The kit to look up')
            .setRequired(true)
            .setAutocomplete(true)
    );

async function autocomplete(interaction) {
    const focusedValue = interaction.options.getString('kit');

    if (focusedValue.length > 0) {
        const results = await prisma.kit.findMany({
            where: {
                product_name: {
                    contains: focusedValue,
                    mode: 'insensitive',
                },
            },
            take: 5,
        });

        const options = results.map(item => ({
            name: item.product_name,
            value: item.id,
        }));

        await interaction.respond(options);
    } else {
        await interaction.respond([]);
    }
}

async function execute(interaction) {
    const kitId = interaction.options.getString('kit');

    const wishlists = await prisma.wishlist.findMany({
        where: {
            kitId: kitId,
        },
    });

    if (wishlists.length > 0) {
        const usersLookingForKit = wishlists.map(item => `- <@${item.userId}>`).join('\n'); // Adjust based on how you store user information
        await interaction.reply(`Users looking for this kit:\n${usersLookingForKit}`);
    } else {
        await interaction.reply("No users are currently looking for this kit.");
    }
}

module.exports = {
    data,
    autocomplete,
    execute,
};
