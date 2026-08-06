// Constructeur de roster : l'écran le plus utilisé par le Raid Leader. Une
// fonction pure de rendu (`renderRosterBuilder`) et des handlers minces qui
// relisent l'état en base avant de la ré-invoquer — le brouillon vit en base,
// jamais en mémoire côté bot.

import type { EventView } from '../domain/events.js'
import type { MessagePayload } from '../broadcast/gateway.js'
import { buildCustomId } from '../broadcast/render.js'
import { WOW_CLASSES, findClass, findSpec } from '../config/wow.js'
import { classEmoji, type EmojiMap } from '../config/emojis.js'
import { registerHandler, type HandlerContext } from '../bot/router.js'
import { addSlot, loadEventView, publishEvent, removeSlot } from '../domain/events.js'
import { NotAuthorized } from '../domain/errors.js'

/**
 * Le brouillon vit en base, pas en mémoire : le constructeur se ré-affiche à
 * l'identique après un redémarrage du bot ou un rechargement du client Discord.
 */
export function renderRosterBuilder(view: EventView, selectedClass: string | null, emojis: EmojiMap): MessagePayload {
  const { event, slots } = view
  const rows: unknown[] = [{
    type: 1,
    components: [{
      type: 3,
      custom_id: buildCustomId('roster', 'class', event.id),
      placeholder: 'Pick a class',
      options: WOW_CLASSES.map((c) => ({ label: c.label, value: c.name, default: c.name === selectedClass })),
    }],
  }]

  const cls = selectedClass ? findClass(selectedClass) : undefined
  if (cls) {
    rows.push({
      type: 1,
      components: [{
        type: 3,
        // `eventId|className` : le cuid fait 25 caractères, le plus long nom
        // de classe (DEATH_KNIGHT / DEMON_HUNTER) 12 — bien sous les 100
        // caractères imposés par Discord une fois le préfixe `pug:1:roster:spec:` ajouté.
        custom_id: buildCustomId('roster', 'spec', `${event.id}|${cls.name}`),
        placeholder: `Add a ${cls.label} spot`,
        options: cls.specs.map((s) => ({ label: s.label, value: s.name, description: s.role })),
      }],
    })
  }

  if (slots.length > 0) {
    rows.push({
      type: 1,
      components: [{
        type: 3,
        custom_id: buildCustomId('roster', 'remove', event.id),
        placeholder: 'Remove a spot',
        options: slots.slice(0, 25).map((s) => ({
          label: `${findSpec(s.className, s.specName)?.label ?? s.specName} (${s.className})`,
          value: s.id,
        })),
      }],
    })
  }

  rows.push({
    type: 1,
    components: [{
      type: 2, style: 3, label: 'Publish LFG',
      custom_id: buildCustomId('roster', 'publish', event.id),
      disabled: slots.length === 0,
    }],
  })

  return {
    embeds: [{
      title: `Draft — ${event.raidName} (${event.difficulty})`,
      description: slots.length === 0
        ? '_No spots yet. Pick a class, then a specialization._'
        : slots.map((s) => `🔸 ${classEmoji(emojis, s.className)} ${findSpec(s.className, s.specName)?.label ?? s.specName}`).join('\n'),
      color: 0x5865f2,
    }],
    components: rows,
  }
}

async function sendUpdate(ctx: HandlerContext, payload: unknown): Promise<void> {
  await (ctx.interaction as unknown as { update: (o: unknown) => Promise<unknown> }).update(payload)
}

/**
 * Charge le brouillon et vérifie que l'acteur de l'interaction est bien son
 * auteur. Le seul rempart qu'offrirait sinon un `custom_id` (message
 * éphémère, cuid imprévisible) n'est pas un contrôle d'accès : un tiers qui
 * rejoue l'identifiant pourrait sinon modifier ou publier le brouillon d'un
 * autre recruteur. Appelé avant toute mutation, dans les quatre handlers —
 * cohérent avec `cancelEvent`/`acceptApplication`, qui lèvent la même erreur
 * pour le même motif ailleurs dans le domaine.
 */
async function requireAuthor(ctx: HandlerContext, eventId: string): Promise<EventView> {
  const view = await loadEventView(ctx.deps.db, eventId)
  if (view.event.authorId !== ctx.interaction.user.id) {
    throw new NotAuthorized('managing this roster')
  }
  return view
}

async function refresh(ctx: HandlerContext, eventId: string, selectedClass: string | null): Promise<void> {
  const view = await loadEventView(ctx.deps.db, eventId)
  await sendUpdate(ctx, renderRosterBuilder(view, selectedClass, ctx.deps.emojis))
}

export function registerRosterHandlers(): void {
  registerHandler('roster', 'class', async (ctx) => {
    const view = await requireAuthor(ctx, ctx.id)
    const value = (ctx.interaction as unknown as { values: string[] }).values[0]!
    // Aucune mutation ici : la vue déjà chargée par requireAuthor reste à jour,
    // pas besoin de la relire.
    await sendUpdate(ctx, renderRosterBuilder(view, value, ctx.deps.emojis))
  })

  registerHandler('roster', 'spec', async (ctx) => {
    const [eventId, className] = ctx.id.split('|') as [string, string]
    await requireAuthor(ctx, eventId)
    const specName = (ctx.interaction as unknown as { values: string[] }).values[0]!
    // `addSlot` lève un DomainError générique pour une spé inconnue (elle ne
    // devrait jamais l'être : les options du select viennent de WOW_CLASSES) —
    // dispatchInteraction s'en charge, pas besoin de la distinguer ici.
    await addSlot(ctx.deps.db, eventId, { className, specName })
    await refresh(ctx, eventId, className)
  })

  registerHandler('roster', 'remove', async (ctx) => {
    await requireAuthor(ctx, ctx.id)
    const slotId = (ctx.interaction as unknown as { values: string[] }).values[0]!
    await removeSlot(ctx.deps.db, slotId)
    await refresh(ctx, ctx.id, null)
  })

  registerHandler('roster', 'publish', async (ctx) => {
    await requireAuthor(ctx, ctx.id)
    // `publishEvent` peut lever EmptyRoster ou NoActivePartners malgré le
    // bouton désactivé côté client (état re-synchronisé entre-temps, race
    // avec une suppression concurrente) : dispatchInteraction transforme ces
    // erreurs en message lisible, aucun try/catch local nécessaire.
    const { targets } = await publishEvent(ctx.deps.db, ctx.id)
    await sendUpdate(ctx, {
      content: `Listing published to ${targets} server(s). Your dashboard is on its way by DM.`,
      embeds: [], components: [],
    })
  })
}
