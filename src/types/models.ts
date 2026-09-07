export type FailureMode = 'PASS' | 'SKIP'

export type RoundState =
  | 'IDLE'
  | 'CARD_SELECTED'
  | 'EMPTY_CARD'
  | 'MUSIC_PLAYING'
  | 'WAITING_RESULT'
  | 'ROUND_COMPLETE'
  | 'REST_MUSIC'
  | 'GAME_OVER'

export type RoundResult = 'SUCCESS' | 'FAILURE'

export interface SongEntry {
  id: string
  fileName: string
  displayName: string
  blobKey: string
}

export interface CardEntry {
  id: string
  /** 1-based deck order number for fast entry */
  number: number
  imageName: string
  imageBlobKey: string | null
  workName: string
  songs: SongEntry[]
  emptyCard?: boolean
}

export interface DeckMeta {
  id: string
  name: string
  updatedAt: number
  cardCount: number
  songCount: number
}

export interface DeckRecord {
  id: string
  name: string
  updatedAt: number
  cards: CardEntry[]
}

export interface GameSettings {
  cardLimit: number
  failureMode: FailureMode
  enableRestMusic: boolean
  minDuration: number
  maxDuration: number
  volume: number
}

export interface SelectionResult {
  selected: CardEntry[]
  restPool: SongEntry[]
  emptySources: CardEntry[]
}

export type PrintMode = 'STANDARD' | 'ALBUM'

export const DEFAULT_SETTINGS: GameSettings = {
  cardLimit: 50,
  failureMode: 'PASS',
  enableRestMusic: true,
  minDuration: 10,
  maxDuration: 30,
  volume: 0.8,
}
