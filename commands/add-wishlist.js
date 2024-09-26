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
                .setDescription('Add an kit to your wishlist')
                .addStringOption(option =>
                    option
                        .setName('kit')
                        .setDescription('The kit to add')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
                .addStringOption(option =>
                    option
                        .setName('notes')
                        .setDescription('Any notes (such as looking for decals, or any special condition)')
                        .setRequired(false)
                )
        ),
    async autocomplete(interaction) {
        const focusedValue = interaction.options.getString('kit');
        if (focusedValue.length > 2) {
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
            const kit = interaction.options.getString('kit');
            try {
                await prisma.wishlist.create({
                    data: {
                        userId: interaction.user.id,
                        kit: kit,
                    },
                });
                await interaction.reply(`Added **${kit}** to your wishlist!`);
            } catch (error) {
                console.error(error);
                await interaction.reply({ content: 'There was an error while adding the kit to your wishlist.', ephemeral: true });
            }
        } else {
            await interaction.reply({ content: 'Invalid subcommand.', ephemeral: true });
        }
    },
};