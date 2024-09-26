const { SlashCommandBuilder } = require('discord.js');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('wishlist')
        .setDescription('Manage your wishlist')
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('Add an item to your wishlist')
                .addStringOption(option =>
                    option
                        .setName('item')
                        .setDescription('The item to add')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        ),

    async autocomplete(interaction) {
        const focusedValue = interaction.options.getString('item'); // Get the current input

        // Check if the input length is more than 3
        if (focusedValue.length > 3) {
            // Search in the database (adjust the query based on your actual database structure)
            const results = await prisma.kit.findMany({
                where: {
                    name: {
                        contains: focusedValue,
                        mode: 'insensitive', // Case insensitive search
                    },
                },
                take: 5, // Limit the number of results
            });

            // Prepare the options for autocomplete
            const options = results.map(kit => {
                return {
                    name: kit.name, // Display name in the suggestion list
                    value: kit.name, // Value to be passed when selected (use kit.name instead of kit.id for the string option)
                };
            });

            // Respond with the autocomplete options
            await interaction.respond(options);
        } else {
            // If the input is 3 letters or fewer, you can respond with an empty array or default options
            await interaction.respond([]);
        }
    },

    async execute(interaction) {
        const item = interaction.options.getString('item');

        // Add the item to the wishlist in the database
        await prisma.wishlist.create({
            data: {
                userId: interaction.user.id,
                item: item,
            },
        });

        await interaction.reply(`Added **${item}** to your wishlist!`);
    },
};
