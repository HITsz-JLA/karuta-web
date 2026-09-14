/**
 * The online room keeps a single shared media element for the rest track and
 * the round song. When a rest window ends, the rest track stays attached to
 * that element (paused) until the next round's audio has been downloaded
 * completely, so anything that can start playback has to check which source
 * the element actually holds. Starting the leftover rest track and seeking it
 * to the running round's clock is what made spectators hear rest music at the
 * beginning of a round and only then hear the round song.
 */
export interface OnlineAudioAttachSources {
  /** Round song that is already running, if any. */
  roundAudioUrl: string | null
  /** Round song both players are still loading, if any. */
  preparedAudioUrl: string | null
  /** Rest-window audio URL of the current room snapshot, if any. */
  restAudioUrl: string | null
  /** Source the page finished downloading (round songs only). */
  loadedLocalSource: string | null
  /** Blob URL that belongs to loadedLocalSource. */
  loadedLocalUrl: string | null
  /** HTMLMediaElement.src (absolute, empty when nothing is attached). */
  mediaSrc: string
  /** HTMLMediaElement.currentSrc, empty until the browser selected it. */
  mediaCurrentSrc: string
}

export type OnlineAudioRole = 'listen' | 'rest'

function mediaMatches(mediaSrc: string, mediaCurrentSrc: string, url: string | null) {
  return Boolean(url) && (mediaSrc === url || mediaCurrentSrc === url)
}

/**
 * The source a session must have attached before playback may start: the fully
 * downloaded blob for a round song, or the streamed rest URL for a rest window.
 */
export function onlineAudioSessionSource(sources: OnlineAudioAttachSources): {
  role: OnlineAudioRole
  source: string
} | null {
  const listenSource = sources.roundAudioUrl || sources.preparedAudioUrl
  if (listenSource) return { role: 'listen', source: listenSource }
  if (sources.restAudioUrl) return { role: 'rest', source: sources.restAudioUrl }
  return null
}

/**
 * Whether the shared element currently holds the exact source this session
 * prepared. A round song only counts once its blob is attached; a rest track
 * only counts while the element still points at the streamed rest URL.
 */
export function onlineAudioSourceAttached(sources: OnlineAudioAttachSources): boolean {
  const session = onlineAudioSessionSource(sources)
  if (!session) return false
  if (session.role === 'rest') {
    return mediaMatches(sources.mediaSrc, sources.mediaCurrentSrc, session.source)
  }
  const localUrl = sources.loadedLocalSource === session.source ? sources.loadedLocalUrl : null
  return mediaMatches(sources.mediaSrc, sources.mediaCurrentSrc, localUrl)
}

/**
 * Returns the media URL a user gesture may start, or null when the element does
 * not hold the source the current session prepared. Callers keep the gesture
 * useful through the silent unlock element in that case: the loader starts the
 * prepared source as soon as it is ready, and a leftover track (typically the
 * rest song) is never played in its place.
 */
export function onlineAudioGestureMediaUrl(sources: OnlineAudioAttachSources): string | null {
  const session = onlineAudioSessionSource(sources)
  if (!session) return null
  if (session.role === 'rest') {
    return mediaMatches(sources.mediaSrc, sources.mediaCurrentSrc, session.source) ? session.source : null
  }
  const localUrl = sources.loadedLocalSource === session.source ? sources.loadedLocalUrl : null
  return mediaMatches(sources.mediaSrc, sources.mediaCurrentSrc, localUrl) ? localUrl : null
}

/**
 * A source that must be detached from the shared element because it does not
 * belong to the current session. Empty when the element holds nothing or the
 * right source already.
 */
export function onlineAudioForeignMediaUrl(sources: OnlineAudioAttachSources): string | null {
  if (!sources.mediaSrc) return null
  return onlineAudioSourceAttached(sources) ? null : sources.mediaSrc
}
