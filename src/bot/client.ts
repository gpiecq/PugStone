import { Client, GatewayIntentBits, REST, Routes, type SlashCommandBuilder } from 'discord.js'
import { env } from '../config/env.js'
import { logger } from '../logger.js'

export interface CommandModule {
  data: SlashCommandBuilder
  execute: (interaction: never, deps: never) => Promise<void>
}

export function createClient(): Client {
  // Aucun intent privilégié : le bot ne lit jamais le contenu des messages,
  // seule la structure des serveurs/salons (Guilds) est nécessaire pour
  // router les interactions et publier des messages.
  return new Client({ intents: [GatewayIntentBits.Guilds] })
}

export async function registerCommands(commands: CommandModule[]): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(env().DISCORD_TOKEN)
  await rest.put(Routes.applicationCommands(env().DISCORD_APP_ID), {
    body: commands.map((c) => c.data.toJSON()),
  })
  logger.info({ count: commands.length }, 'commandes enregistrées')
}
