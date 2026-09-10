const ONLINE_LOG_PREFIX = '[karuta-online]'

function safeDetails(details) {
  if (!details || typeof details !== 'object') return {}
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined))
}

/**
 * Write one-line, journal-friendly online-game events.
 *
 * Deliberately do not accept or emit resume/audio tokens. These events are
 * intended for incident diagnosis, not request tracing with credentials.
 */
export function logOnlineEvent(event, details = {}) {
  const payload = {
    at: new Date().toISOString(),
    event,
    ...safeDetails(details),
  }
  console.info(`${ONLINE_LOG_PREFIX} ${JSON.stringify(payload)}`)
}
