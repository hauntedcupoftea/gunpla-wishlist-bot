const { SlashCommandBuilder } = require('discord.js');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const data = new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search for information on a kit')
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
            take: 8,
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

    const kit = await prisma.kit.findUnique({
        where: {
            id: kitId,
        },
    })

    if (!kit) {
        await interaction.reply("Kit not found in the database, please add it.")
    } else {
        const kitInfo = `- Release: ${kit.release_date}\n- Price in JPY: ¥${kit.jpy_price}\n- HLJ Stock: ${kit.availability}`
        if (kit.availability == "In Stock") {
            kitInfo += `\n- HLJ Stock Status: ${kit.stock_status}`
        }
        await interaction.reply(`Here's what we found about ${kit.product_name}\n${kitInfo}`)
    }
}

module.exports = {
    data,
    autocomplete,
    execute,
};