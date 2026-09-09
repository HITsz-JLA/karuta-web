export type FailureMode = 'PASS' | 'SKIP'

export type PackageMode = 'full' | 'lite'

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
  /** Original path inside a server data package, used by online audio serving. */
  sourcePath?: string
  /** Optional full-length source used by rest music in complete packages. */
  fullBlobKey?: string
}

export interface CardEntry {
  id: string
  /** Source/display number for fast entry; imports preserve this value. */
  number: number
  imageName: string
  imageBlobKey: string | null
  /** Original cover path inside a server data package, used to match cards across devices. */
  imagePath?: string
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
  /** Server package filename this local deck was imported from, when known. */
  sourcePackageId?: string
}

export interface DeckRecord {
  id: string
  name: string
  updatedAt: number
  cards: CardEntry[]
  /** Server package filename this local deck was imported from, when known. */
  sourcePackageId?: string
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
