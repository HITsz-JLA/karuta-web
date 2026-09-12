import { type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { OnlineCardView, OnlinePlayerId, OnlineRoomView } from '../../lib/onlineProtocol'
import { serverCardImageUrl, type ServerPackageCatalogCard } from '../../lib/serverPackages'
import type { OnlineSocket } from '../../lib/onlineSocket'
import {
  BATTLE_STYLE_STORAGE_KEY,
  COUNTDOWN_EARLY_WAKE_MS,
  DEFAULT_ONLINE_VOLUME,
  EMPTY_CARD_KEYS,
  MAX_HAND_SLOTS,
  MEDIA_READY_TIMEOUT_MS,
  ONLINE_VOLUME_STORAGE_KEY,
} from './onlineConstants'
import type { BattleAnimation, BattleAnimationPayload, BattleStyle } from './onlineTypes'

export function setCountdownRemaining(setter: Dispatch<SetStateAction<number>>, nextValue: number) {
  const next = Math.max(0, nextValue)
  setter((previous) => {
    if ((previous > 0) === (next > 0) && Math.ceil(previous / 1000) === Math.ceil(next / 1000)) return previous
    return next
  })
}

/**
 * Countdown text only changes at one-second boundaries. A 250ms interval was
 * waking every active match several times more often than the UI can display.
 * Schedule the next wake close to the next boundary and keep the small early
 * margin so background timer rounding cannot leave a stale second visible.
 */
export function scheduleCountdown(getRemaining: () => number, setter: Dispatch<SetStateAction<number>>) {
  let timer: number | null = null
  const update = () => {
    const remaining = Math.max(0, getRemaining())
    setCountdownRemaining(setter, remaining)
    if (remaining <= 0) {
      timer = null
      return
    }
    const untilBoundary = remaining % 1000 || 1000
    timer = window.setTimeout(update, Math.min(1000, untilBoundary + COUNTDOWN_EARLY_WAKE_MS))
  }
  update()
  return () => {
    if (timer !== null) window.clearTimeout(timer)
    timer = null
  }
}

export function readBattleStyle(): BattleStyle {
  try {
    return localStorage.getItem(BATTLE_STYLE_STORAGE_KEY) === 'text' ? 'text' : 'card'
  } catch {
    return 'card'
  }
}

export function clampOnlineVolume(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : DEFAULT_ONLINE_VOLUME))
}

export function readOnlineVolume() {
  try {
    const raw = localStorage.getItem(ONLINE_VOLUME_STORAGE_KEY)
    if (raw === null) return DEFAULT_ONLINE_VOLUME
    const stored = Number(raw)
    return Number.isFinite(stored) ? clampOnlineVolume(stored) : DEFAULT_ONLINE_VOLUME
  } catch {
    return DEFAULT_ONLINE_VOLUME
  }
}

export function createSilentAudioUrl() {
  const sampleRate = 8_000
  const sampleCount = 80
  const buffer = new ArrayBuffer(44 + sampleCount)
  const view = new DataView(buffer)
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + sampleCount, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate, true)
  view.setUint16(32, 1, true)
  view.setUint16(34, 8, true)
  writeText(36, 'data')
  view.setUint32(40, sampleCount, true)
  new Uint8Array(buffer, 44).fill(128)
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }))
}

export function mediaHasUrl(audio: HTMLAudioElement, url: string) {
  return Boolean(url) && (audio.src === url || audio.currentSrc === url)
}

export function isMediaPlayable(audio: HTMLAudioElement) {
  return audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
}

export function resetRoundPlaybackToStart(audio: HTMLAudioElement) {
  if (audio.currentTime > 0.05) audio.currentTime = 0
}

/** Align a late-arriving player to the server's authoritative round clock. */
export function syncRoundPlayback(audio: HTMLAudioElement, elapsedMs: number) {
  if (elapsedMs <= 50) {
    resetRoundPlaybackToStart(audio)
    return true
  }
  const targetSeconds = elapsedMs / 1000
  if (Number.isFinite(audio.duration) && audio.duration <= targetSeconds + 0.05) return false
  try {
    audio.currentTime = targetSeconds
    return true
  } catch {
    return false
  }
}

export function waitForMediaReady(audio: HTMLAudioElement, timeoutMs = MEDIA_READY_TIMEOUT_MS): Promise<void> {
  if (isMediaPlayable(audio)) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let timer: number | null = null
    const cleanup = () => {
      audio.removeEventListener('loadeddata', onReady)
      audio.removeEventListener('canplay', onReady)
      audio.removeEventListener('canplaythrough', onReady)
      audio.removeEventListener('error', onError)
      if (timer !== null) window.clearTimeout(timer)
    }
    const succeed = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onReady = () => {
      if (isMediaPlayable(audio)) succeed()
    }
    const onError = () => fail(new Error('音频解码失败'))
    audio.addEventListener('loadeddata', onReady)
    audio.addEventListener('canplay', onReady)
    audio.addEventListener('canplaythrough', onReady)
    audio.addEventListener('error', onError)
    timer = window.setTimeout(() => {
      if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) succeed()
      else fail(new Error('音频解码超时'))
    }, timeoutMs)
    onReady()
  })
}

export function roundAudioReadyKey(roundNo: number, audioUrl: string) {
  return `${roundNo}:${audioUrl}`
}

export function acknowledgeRoundAudio(
  socket: OnlineSocket,
  roundNo: number,
  audioUrl: string,
  sentRef: MutableRefObject<string | null>,
) {
  const key = roundAudioReadyKey(roundNo, audioUrl)
  if (sentRef.current === key) return true
  if (!socket.send({ t: 'audioReady', roundNo })) return false
  sentRef.current = key
  return true
}

export function battleAnimationKey(payload: BattleAnimationPayload | BattleAnimation) {
  switch (payload.kind) {
    case 'claim':
    case 'wrong':
      return `${payload.kind}:${payload.playerId}:${payload.cardKey}`
    case 'transfer':
      return `${payload.kind}:${payload.from}:${payload.to}:${payload.cardKey}:${payload.automatic ? 'auto' : 'manual'}`
    case 'layout':
      return `${payload.kind}:${payload.playerId}:${payload.cardKey}:${payload.sourceSlot}:${payload.targetSlot ?? 'none'}:${payload.exchangeCardKey || ''}`
    case 'discard':
      return `${payload.kind}:${payload.winner || 'none'}:${payload.cardKey}`
  }
}

export function createLayoutAnimation(
  before: Array<string | null> | null | undefined,
  after: Array<string | null> | null | undefined,
  playerId: OnlinePlayerId,
): Extract<BattleAnimationPayload, { kind: 'layout' }> | null {
  let changedIndex = -1
  for (let index = 0; index < MAX_HAND_SLOTS; index += 1) {
    if ((before?.[index] || null) !== (after?.[index] || null)) {
      changedIndex = index
      break
    }
  }
  if (changedIndex < 0) return null

  const beforeSlots = Array.from({ length: MAX_HAND_SLOTS }, (_, index) => before?.[index] || null)
  const afterSlots = Array.from({ length: MAX_HAND_SLOTS }, (_, index) => after?.[index] || null)
  const beforeKeys = beforeSlots.filter((key): key is string => Boolean(key))
  const afterKeys = afterSlots.filter((key): key is string => Boolean(key))
  const beforeSet = new Set(beforeKeys)
  const afterSet = new Set(afterKeys)
  if (
    beforeKeys.length !== beforeSet.size ||
    afterKeys.length !== afterSet.size ||
    beforeKeys.length !== afterKeys.length ||
    beforeKeys.some((key) => !afterSet.has(key)) ||
    afterKeys.some((key) => !beforeSet.has(key))
  ) {
    return null
  }

  const movedKey = afterSlots.find(
    (key, index) => Boolean(key) && key !== beforeSlots[index] && beforeSlots.indexOf(key) !== index,
  )
  const cardKey = movedKey || afterSlots[changedIndex] || beforeSlots[changedIndex]
  if (!cardKey) return null
  const sourceSlot = beforeSlots.indexOf(cardKey)
  const targetSlot = afterSlots.indexOf(cardKey)
  if (sourceSlot < 0 || targetSlot < 0 || sourceSlot === targetSlot) return null
  const exchangeCardKey = beforeSlots[targetSlot] && beforeSlots[targetSlot] !== cardKey ? beforeSlots[targetSlot] : null
  return { kind: 'layout', playerId, cardKey, sourceSlot, targetSlot, exchangeCardKey }
}

export function readNickname() {
  try {
    return localStorage.getItem('karuta-online-nickname') || '玩家'
  } catch {
    return '玩家'
  }
}

export function packageCardMeta(card: ServerPackageCatalogCard, packageId: string): OnlineCardView {
  return {
    key: card.key,
    number: card.number,
    imageName: card.imageName,
    workName: card.workName,
    imageUrl: serverCardImageUrl(packageId, card.key),
  }
}

export function otherPlayer(player: 'A' | 'B') {
  return player === 'A' ? 'B' : 'A'
}

export function normalizeBoardLayout(layout: Array<string | null> | null, fallback: string[]) {
  const hand = new Set(fallback)
  const used = new Set<string>()
  const source = Array.from({ length: MAX_HAND_SLOTS }, (_, index) => {
    const key = layout?.[index]
    if (typeof key !== 'string' || !hand.has(key) || used.has(key)) return null
    used.add(key)
    return key
  })
  const unplaced = fallback.filter((key) => !used.has(key))
  let nextUnplaced = 0
  for (let index = 0; index < source.length && nextUnplaced < unplaced.length; index += 1) {
    if (source[index] === null) source[index] = unplaced[nextUnplaced++]
  }
  return source
}

export function mirrorBoardLayout(layout: Array<string | null> | null, fallback: string[]) {
  const source = normalizeBoardLayout(layout, fallback)
  const mirrored = Array<string | null>(MAX_HAND_SLOTS).fill(null)
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 11; column += 1) {
      mirrored[(2 - row) * 11 + column] = source[row * 11 + column]
    }
  }
  return mirrored
}

export function formatNetworkMetric(value: number | null) {
  return value === null ? '测量中' : `${value} ms`
}

export function playerName(room: { players: Record<OnlinePlayerId, { nickname?: string } | null | undefined> }, playerId: OnlinePlayerId) {
  return room.players[playerId]?.nickname || `玩家 ${playerId}`
}

export function handCardsForSpectator(room: OnlineRoomView, playerId: OnlinePlayerId) {
  const player = room.players[playerId]
  const handKeys = player?.handCardKeys || EMPTY_CARD_KEYS
  const layout = player?.layoutCardKeys || null
  const slotKeys = playerId === 'A' ? mirrorBoardLayout(layout, handKeys) : normalizeBoardLayout(layout, handKeys)
  const byKey = new Map(room.cards.map((card) => [card.key, card]))
  return slotKeys.map((key) => (key ? byKey.get(key) || null : null))
}
