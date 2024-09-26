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
        const focusedValue = interaction.options.getString('item');
        if (focusedValue.length > 3) {
            const results = await prisma.kit.findMany({
                where: {
                    name: {
                        contains: focusedValue,
                        mode: 'insensitive',
                    },
                },
                take: 5,
            });
            const options = results.map(kit => ({
                name: kit.name,
                value: kit.name,
            }));
            await interaction.respond(options);
        } else {
            await interaction.respond([]);
        }
    },
    async execute(interaction) {
        if (interaction.options.getSubcommand() === 'add') {
            const item = interaction.options.getString('item');
            try {
                await prisma.wishlist.create({
                    data: {
                        userId: interaction.user.id,
                        item: item,
                    },
                });
                await interaction.reply(`Added **${item}** to your wishlist!`);
            } catch (error) {
                console.error(error);
                await interaction.reply({ content: 'There was an error while adding the item to your wishlist.', ephemeral: true });
            }
        } else {
            await interaction.reply({ content: 'Invalid subcommand.', ephemeral: true });
        }
    },
};