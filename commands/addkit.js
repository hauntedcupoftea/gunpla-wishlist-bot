const { SlashCommandBuilder } = require('discord.js');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const data = new SlashCommandBuilder()
    .setName('addkit')
    .setDescription('Add a new kit to the lookup')
    .addStringOption(option =>
        option
            .setName('product_name')
            .setDescription('The full name of the kit.')
            .setRequired(true)
    )
    .addIntegerOption(option =>
        option
            .setName('jpy_price')
            .setDescription('Price of the kit in JPY. Use of market value is discouraged, unless it is not sold in Japan.')
            .setRequired(true)
    )
    .addStringOption(option =>
        option
            .setName('availability')
            .setDescription('Availability status of the kit. You may enter Sources here if you wish.')
            .setRequired(true)
    )
    .addStringOption(option =>
        option
            .setName('release_date')
            .setDescription('The release date of the kit (optional). Month Year format is appreciated (eg. September 2024)')
            .setRequired(false)
    )
    .addStringOption(option =>
        option
            .setName('stock_status')
            .setDescription('Stock status of the kit (optional)')
            .setRequired(false)
    );

async function execute(interaction) {
    const releaseDate = interaction.options.getString('release_date');
    const jpyPrice = interaction.options.getInteger('jpy_price');
    const availability = interaction.options.getString('availability');
    const stockStatus = interaction.options.getString('stock_status');
    const productName = interaction.options.getString('product_name');

    try {
        const newKit = await prisma.kit.create({
            data: {
                release_date: releaseDate,
                jpy_price: jpyPrice,
                availability: availability,
                stock_status: stockStatus,
                product_name: productName,
                item_code: productName
            },
        });
        await interaction.reply(`Successfully added the kit **${newKit.product_name}**!`);
    } catch (error) {
        console.error(error);
        await interaction.reply({ content: 'There was an error while adding the kit.', ephemeral: true });
    }
}

module.exports = {
    data,
    execute,
};
