const { SlashCommandBuilder } = require('discord.js');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const data = new SlashCommandBuilder()
    .setName('wishlist')
    .setDescription('Manage your wishlist')
    .addSubcommand(subcommand =>
        subcommand
            .setName('add')
            .setDescription('Add a kit to your wishlist')
            .addStringOption(option =>
                option
                    .setName('kit')
                    .setDescription('The kit to add')
                    .setRequired(true)
                    .setAutocomplete(true)
            )
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('remove')
            .setDescription('Remove a kit from your wishlist')
            .addStringOption(option =>
                option
                    .setName('kit')
                    .setDescription('The kit to remove')
                    .setRequired(true)
                    .setAutocomplete(true)
            )
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('view')
            .setDescription('View your wishlist')
    );

async function autocomplete(interaction) {
    const focusedValue = interaction.options.getString('kit');
    const subcommand = interaction.options.getSubcommand();

    if (focusedValue.length > 0) {
        let results;

        if (subcommand === 'add') {
            // Fetch kits from the available kits
            results = await prisma.kit.findMany({
                where: {
                    product_name: {
                        contains: focusedValue,
                        mode: 'insensitive',
                    },
                },
                take: 5,
            });
        } else if (subcommand === 'remove') {
            // Fetch kits from the user's wishlist
            results = await prisma.wishlist.findMany({
                where: {
                    userId: interaction.user.id,
                },
                include: {
                    kit: true, // Include related kit data
                },
                take: 5,
            });
        }

        const options = results.map(item => ({
            name: subcommand === 'add' ? item.product_name : item.kit.product_name, // Use the correct name based on the subcommand
            value: subcommand === 'add' ? item.id : item.kitId, // Use the correct ID based on the subcommand
        }));

        await interaction.respond(options);
    } else {
        await interaction.respond([]);
    }
}

async function execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const kitId = interaction.options.getString('kit');

    if (subcommand === 'add') {
        try {
            await prisma.wishlist.create({
                data: {
                    userId: interaction.user.id,
                    kitId: kitId, // Store the kitId from the autocomplete
                },
            });
            const kit = await prisma.kit.findUnique({ where: { id: kitId } });
            await interaction.reply({ content: `Added **${kit.product_name}** to your wishlist!`, ephemeral: true });
        } catch (error) {
            console.error(error);
            await interaction.reply({ content: 'There was an error while adding the kit to your wishlist.', ephemeral: true });
        }
    } else if (subcommand === 'remove') {
        const result = await prisma.wishlist.deleteMany({
            where: {
                userId: interaction.user.id,
                kitId: kitId, // Use kitId for the removal
            },
        });

        if (result.count > 0) {
            const kit = await prisma.kit.findUnique({ where: { id: kitId } });
            await interaction.reply({ content: `Removed **${kit.product_name}** from your wishlist!`, ephemeral: true});
        } else {
            await interaction.reply({content: `Kit **${kitId}** not found in your wishlist.`, ephemeral: true});
        }
    } else if (subcommand === 'view') {
        const wishlists = await prisma.wishlist.findMany({
            where: {
                userId: interaction.user.id,
            },
            include: {
                kit: true, // Include related kit data
            },
        });

        if (wishlists.length > 0) {
            const wishlistItems = wishlists.map(item => `- **${item.kit.product_name}**`).join('\n');
            await interaction.reply(`Your wishlist:\n${wishlistItems}`);
        } else {
            await interaction.reply("Your wishlist is empty.");
        }
    } else {
        await interaction.reply({ content: 'Invalid subcommand.', ephemeral: true });
    }
}

module.exports = {
    data,
    autocomplete,
    execute,
};