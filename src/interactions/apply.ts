// Parcours de candidature : bouton [⚔️ Apply] -> (select de rôle si plusieurs
// places sont ouvertes) -> modal -> soumission. Le joueur qui postule n'est
// pas l'auteur de l'annonce : contrairement au constructeur de roster
// (Tâche 14), aucun contrôle de propriété n'a de sens ici, c'est volontaire.
//
// Contrainte Discord déterminante : un modal doit être la toute première
// réponse à une interaction — impossible de `deferReply` puis d'ouvrir un
// modal. `app:open` se limite donc à des lectures courtes avant d'appeler
// `showModal` (place unique) ou `reply` en éphémère (select de rôle,
// plusieurs places). Le chemin « select puis modal » ne fonctionne que parce
// que la sélection déclenche une nouvelle interaction, avec sa propre
// fenêtre de première réponse.

import type { Slot } from '@prisma/client'
import type { MessagePayload } from '../broadcast/gateway.js'
import { buildCustomId } from '../broadcast/render.js'
import { classEmoji, type EmojiMap } from '../config/emojis.js'
import { findClass, findSpec } from '../config/wow.js'
import { registerHandler } from '../bot/router.js'
import { openSlots, submitApplication, validateApplicationInput } from '../domain/applications.js'
import { EventClosed } from '../domain/errors.js'

/** Interfaces minimales de discord.js réellement utilisées par ce module (aucune dépendance directe au paquet, cf. tests/architecture.test.ts). */
interface ShowsModal { showModal(modal: unknown): Promise<void> }
interface Replies { reply(options: unknown): Promise<void> }
interface HasValues { values: string[] }
interface HasUser { user: { id: string; username: string } }
interface HasFields { fields: { getTextInputValue(id: string): string } }

function textInput(id: string, label: string, style: 1 | 2, required: boolean, placeholder?: string) {
  return {
    type: 1,
    components: [{
      type: 4,
      custom_id: id,
      label,
      style,
      required,
      max_length: style === 2 ? 300 : 100,
      ...(placeholder ? { placeholder } : {}),
    }],
  }
}

/**
 * Structure de modal Discord (type `unknown` : ce module ne dépend pas de
 * discord.js, seul le handler `app:submit` a besoin de la lire).
 */
export function buildApplyModal(slotId: string, specLabel: string): unknown {
  return {
    custom_id: buildCustomId('app', 'submit', slotId),
    title: `Apply — ${specLabel}`.slice(0, 45),
    components: [
      textInput('ignRealm', 'In-game Name & Realm', 1, true, 'Pug-Hyjal'),
      textInput('itemLevel', 'Item Level (iLvl)', 1, true, '626'),
      textInput('logsUrl', 'WarcraftLogs Link', 1, true, 'https://www.warcraftlogs.com/character/...'),
      textInput('comment', 'Comments for the raid leader', 2, false),
    ],
  }
}

function slotLabel(slot: Slot): string {
  const spec = findSpec(slot.className, slot.specName)?.label ?? slot.specName
  const cls = findClass(slot.className)?.label ?? slot.className
  return `${spec} (${cls})`
}

/** Select éphémère proposé quand plusieurs places sont encore ouvertes sur l'annonce. */
export function buildRoleSelect(eventId: string, slots: Slot[], emojis: EmojiMap): MessagePayload {
  return {
    content: 'Which role are you applying for?',
    embeds: [],
    components: [{
      type: 1,
      components: [{
        type: 3,
        custom_id: buildCustomId('app', 'role', eventId),
        placeholder: 'Pick a spot',
        options: slots.slice(0, 25).map((slot) => ({
          label: slotLabel(slot),
          value: slot.id,
          description: `${classEmoji(emojis, slot.className)} ${slot.role}`.slice(0, 100),
        })),
      }],
    }],
  }
}

/** Lit les quatre champs du modal ; un commentaire blanc devient `null` plutôt qu'une chaîne vide. */
export function readModalFields(fields: { getTextInputValue(id: string): string }): {
  ignRealm: string
  itemLevel: string
  logsUrl: string
  comment: string | null
} {
  const comment = fields.getTextInputValue('comment').trim()
  return {
    ignRealm: fields.getTextInputValue('ignRealm'),
    itemLevel: fields.getTextInputValue('itemLevel'),
    logsUrl: fields.getTextInputValue('logsUrl'),
    comment: comment.length > 0 ? comment : null,
  }
}

export function registerApplyHandlers(): void {
  // Aucun deferReply dans ce handler : Discord exige que le modal (ou, à
  // défaut, le select de rôle) soit la toute première réponse à l'interaction.
  registerHandler('app', 'open', async (ctx) => {
    const slots = await openSlots(ctx.deps.db, ctx.id)
    const event = await ctx.deps.db.event.findUniqueOrThrow({ where: { id: ctx.id } })
    if (event.status !== 'PUBLISHED' || slots.length === 0) throw new EventClosed()

    const interaction = ctx.interaction as unknown as ShowsModal & Replies
    if (slots.length === 1) {
      const slot = slots[0]!
      await interaction.showModal(buildApplyModal(slot.id, slotLabel(slot)))
      return
    }
    await interaction.reply({ ...buildRoleSelect(ctx.id, slots, ctx.deps.emojis), ephemeral: true })
  })

  registerHandler('app', 'role', async (ctx) => {
    const slotId = (ctx.interaction as unknown as HasValues).values[0]!
    const slot = await ctx.deps.db.slot.findUniqueOrThrow({ where: { id: slotId } })
    const interaction = ctx.interaction as unknown as ShowsModal
    await interaction.showModal(buildApplyModal(slot.id, slotLabel(slot)))
  })

  registerHandler('app', 'submit', async (ctx) => {
    const interaction = ctx.interaction as unknown as HasFields & HasUser & Replies
    const validation = validateApplicationInput(readModalFields(interaction.fields))
    if (!validation.ok) {
      // Discord ne conserve pas la saisie d'un modal refusé : le message
      // doit lister tous les problèmes d'un coup, sinon le joueur tâtonne.
      await interaction.reply({
        content: ['Your application was not submitted:', ...validation.errors.map((e) => `• ${e}`)].join('\n'),
        ephemeral: true,
      })
      return
    }

    // Ni contrôle de propriété ni vérification d'identité ici : n'importe
    // quel joueur peut postuler sur n'importe quelle place ouverte.
    // `submitApplication` lève EventClosed / SlotAlreadyFilled / SlotNotFound
    // au besoin — dispatchInteraction les transforme en message éphémère lisible.
    await submitApplication(ctx.deps.db, {
      slotId: ctx.id,
      applicantId: interaction.user.id,
      applicantTag: interaction.user.username,
      ...validation.value,
    })
    await interaction.reply({
      content: 'Application sent. The raid leader will contact you if you are picked.',
      ephemeral: true,
    })
  })
}
