// Doit précéder tout autre import : `src/db/client.ts` lit la configuration
// validée dès son évaluation, donc `.env` doit être chargé avant.
// En conteneur, les variables viennent de l'environnement et l'absence de
// fichier `.env` est sans conséquence.
import 'dotenv/config'

import { Events } from 'discord.js'
import { readFileSync } from 'node:fs'
import { env } from './config/env.js'
import { loadEmojiMap } from './config/emojis.js'
import { prisma } from './db/client.js'
import { logger } from './logger.js'
import { createClient, registerCommands, type CommandModule } from './bot/client.js'
import { DiscordJsGateway } from './bot/gateway.js'
import { dispatchInteraction, type BotDeps } from './bot/router.js'
import { registerRosterHandlers } from './interactions/roster.js'
import { registerApplyHandlers } from './interactions/apply.js'
import { registerDashboardHandlers } from './interactions/dashboard.js'
import { runOutboxTick } from './broadcast/outbox.js'
import { expireDueEvents } from './scheduler/expiration.js'
import { purgeOldEvents } from './scheduler/retention.js'
import { suspendGuild } from './domain/network.js'
import { networkCommand } from './commands/network.js'
import { setLfgChannelCommand } from './commands/set-lfg-channel.js'
import { recruitCommand } from './commands/recruit.js'
import { cancelCommand } from './commands/cancel.js'
import { DomainError } from './domain/errors.js'

export interface Loop { stop: () => void }

/** Une itération en échec ne doit jamais arrêter la boucle : on journalise et on continue. */
export function startLoop(name: string, intervalMs: number, task: () => Promise<unknown>): Loop {
  let stopped = false
  const timer = setInterval(() => {
    if (stopped) return
    void task().catch((error) => logger.error({ err: error, loop: name }, 'itération en échec'))
  }, intervalMs)
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

async function main(): Promise<void> {
  const commands: CommandModule[] = [networkCommand, setLfgChannelCommand, recruitCommand, cancelCommand]
  const client = createClient()
  const deps: BotDeps = {
    db: prisma,
    gateway: new DiscordJsGateway(client),
    emojis: loadEmojiMap(JSON.parse(readFileSync('config/emojis.json', 'utf8'))),
    ownerId: env().OWNER_DISCORD_ID,
  }

  registerRosterHandlers()
  registerApplyHandlers()
  registerDashboardHandlers()

  client.on(Events.InteractionCreate, async (interaction) => {
    // Le try/catch englobe tout le corps de l'écouteur : une erreur qui
    // s'échappe d'ici (y compris l'échec de la réponse d'erreur elle-même,
    // par exemple un jeton d'interaction expiré) deviendrait sinon un rejet
    // de promesse non géré côté EventEmitter de discord.js, susceptible
    // d'abattre le process (revue Tâche 17).
    try {
      if (interaction.isAutocomplete()) {
        if (interaction.commandName === 'cancel' && cancelCommand.autocomplete) {
          await cancelCommand.autocomplete(interaction as never, deps as never)
        }
        return
      }
      if (interaction.isChatInputCommand()) {
        const command = commands.find((c) => c.data.name === interaction.commandName)
        if (!command) return
        try {
          await command.execute(interaction as never, deps as never)
        } catch (error) {
          const content = error instanceof DomainError ? error.userMessage : 'Something went wrong. The issue has been logged.'
          if (!(error instanceof DomainError)) logger.error({ err: error, command: interaction.commandName }, 'commande en échec')
          if (interaction.deferred || interaction.replied) await interaction.editReply({ content })
          else await interaction.reply({ content, ephemeral: true })
        }
        return
      }
      await dispatchInteraction(interaction, deps)
    } catch (error) {
      logger.error({ err: error }, 'interaction non traitée')
    }
  })

  // Expulsion du bot : le serveur sort du réseau et ses émissions cessent immédiatement.
  client.on(Events.GuildDelete, async (guild) => {
    await suspendGuild(prisma, guild.id)
    logger.warn({ guildId: guild.id }, 'bot retiré d\'un serveur partenaire')
  })

  await registerCommands(commands)
  await client.login(env().DISCORD_TOKEN)
  logger.info('client Discord connecté')

  const loops = [
    startLoop('outbox', 3_000, () => runOutboxTick({ db: prisma, gateway: deps.gateway, emojis: deps.emojis, now: () => new Date(), ownerId: deps.ownerId })),
    startLoop('expiration', 60_000, () => expireDueEvents(prisma, new Date())),
    startLoop('retention', 24 * 60 * 60 * 1000, () => purgeOldEvents(prisma, new Date())),
  ]

  const shutdown = async () => {
    logger.info('arrêt demandé')
    loops.forEach((loop) => loop.stop())
    await client.destroy()
    await prisma.$disconnect()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

// Ne démarre pas quand le module est importé par les tests.
if (process.env.NODE_ENV !== 'test' && process.argv[1]?.includes('index')) {
  void main().catch((error) => {
    logger.fatal({ err: error }, 'démarrage impossible')
    process.exit(1)
  })
}
