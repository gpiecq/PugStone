// Erreurs métier communes au domaine PugStone. Chaque sous-classe porte un
// `userMessage` en anglais : c'est le texte montré tel quel à l'utilisateur
// Discord, les handlers n'ont donc jamais à traduire un code d'erreur en phrase.

export class DomainError extends Error {
  constructor(message: string, readonly userMessage: string) {
    super(message)
    this.name = new.target.name
  }
}

export class InviteCodeUnusable extends DomainError {
  constructor() { super('code invalide, consommé ou révoqué', 'This invite code is invalid or has already been used.') }
}
export class NotAuthorized extends DomainError {
  constructor(what = 'this action') { super('action non autorisée', `You are not allowed to perform ${what}.`) }
}
export class EmptyRoster extends DomainError {
  constructor() { super('roster vide', 'Add at least one spot before publishing.') }
}
export class NoActivePartners extends DomainError {
  constructor() { super('aucun partenaire actif', 'No partner server is currently available to receive this listing.') }
}
export class RaidTimeInvalid extends DomainError {
  constructor(userMessage: string) { super('heure de raid invalide', userMessage) }
}
export class SlotAlreadyFilled extends DomainError {
  constructor() { super('place déjà pourvue', 'This spot has just been filled.') }
}
export class EventClosed extends DomainError {
  constructor() { super('annonce close', 'This listing is no longer accepting applications.') }
}
export class SlotNotFound extends DomainError {
  constructor() { super('place introuvable', 'This spot no longer exists.') }
}
