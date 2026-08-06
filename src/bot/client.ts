import { Client, GatewayIntentBits, REST, Routes, type SlashCommandBuilder } from 'discord.js'
import { env } from '../config/env.js'
import { logger } from '../logger.js'

export interface CommandModule {
  data: SlashCommandBuilder
  execute: (interaction: never, deps: never) => Promise<void>
  // Optionnel : seul /cancel en a besoin aujourd'hui (Tâche 17, revue —
  // sans ce champ, `cancelCommand.autocomplete` n'était atteignable par
  // aucun type exposé et l'écouteur `interactionCreate` devait le
  // contourner par un cast ad hoc).
  autocomplete?: (interaction: never, deps: never) => Promise<void>
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
