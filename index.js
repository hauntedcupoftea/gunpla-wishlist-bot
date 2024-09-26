const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const fs = require('fs');
const path = require('path');

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

client.commands = new Collection();
const commands = [];

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
        commands.push(command.data.toJSON());
        console.log(`Loaded command: ${command.data.name}`);
    } else {
        console.warn(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
    }
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');
        let data;
        if (process.env.GUILD_ID) {
            // Guild-specific commands
            data = await rest.put(
                Routes.applicationGuildCommands(process.env.APPLICATION_ID, process.env.GUILD_ID),
                { body: commands }
            );
            console.log(`Successfully reloaded ${data.length} guild-specific application (/) commands.`);
        } else {
            // Global commands
            data = await rest.put(
                Routes.applicationCommands(process.env.APPLICATION_ID),
                { body: commands }
            );
            console.log(`Successfully reloaded ${data.length} global application (/) commands.`);
        }
    } catch (error) {
        console.error('Error refreshing commands:', error);
    }
})();

client.on('interactionCreate', async interaction => {
    if (interaction.isCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) return;

        try {
            await command.execute(interaction);
        } catch (error) {
            console.error(error);
            await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
        }
    } else if (interaction.isAutocomplete()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) return;

        try {
            await command.autocomplete(interaction);
        } catch (error) {
            console.error(error);
        }
    }
});

client.once('ready', () => {
    console.log('Bot is starting up...');
    setTimeout(() => {
        console.log('Bot is now ready!');
        client.user.setActivity('commands', { type: 'LISTENING' });
    }, 5000); // 5 second delay
});

client.login(process.env.DISCORD_TOKEN);