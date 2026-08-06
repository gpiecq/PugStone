import pino from 'pino'
import { logLevelSchema } from './config/env.js'

// Écart assumé par rapport au brief (qui lisait process.env.LOG_LEVEL en
// direct) : on valide le niveau via le même schéma que env(), mais sans
// invoquer env() elle-même. env() exige DISCORD_TOKEN/DISCORD_APP_ID/
// DATABASE_URL — des variables sans rapport avec le niveau de log — et les
// tests du routeur (Tâche 12) importent ce module sans les fournir. Un
// niveau absent ou invalide retombe silencieusement sur 'info' plutôt que de
// faire échouer l'import : un logger qui ne peut pas se construire ne peut
// pas non plus rapporter l'erreur qui l'en empêche.
const level = logLevelSchema.catch('info').parse(process.env.LOG_LEVEL)

export const logger = pino({ level })
export type Logger = typeof logger
