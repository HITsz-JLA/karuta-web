export type OnlinePlayerId = 'A' | 'B'
export type OnlineRoomPhase = 'lobby' | 'draft_select' | 'draft_ban' | 'arrange' | 'playing' | 'over'
export type OnlineDraftPhase = 'waiting' | 'select' | 'ban' | 'arrange'

export interface OnlineCardView {
  key: string
  number: number
  imageName: string
  workName: string
  imageUrl?: string
}

export interface OnlinePlayerView {
  id: OnlinePlayerId
  nickname: string
  connected: boolean
  ready: boolean
  arrangeReady: boolean
  restReady: boolean
  score: number
  correctClaims: number
  network: OnlineNetworkView
  selectedCount: number
  bannedCount: number
  handCardKeys: string[]
  layoutCardKeys: Array<string | null> | null
}

export interface OnlineNetworkView {
  rttMs: number | null
  jitterMs: number | null
  samples: number
}

export type OnlineFairnessStatus = 'measuring' | 'ready' | 'unfair'

export interface OnlineFairnessView {
  status: OnlineFairnessStatus
  canStart: boolean
  rttGapMs: number | null
  jitterGapMs: number | null
  maxJitterMs: number | null
  message: string
}

export interface OnlineDraftView {
  phase: OnlineDraftPhase
  poolCardKeys: string[]
  selectedCardKeys: string[]
  exchangeCardKeys: string[]
  bannedCardKeys: string[]
  selectionSize: number
  banSize: number
  opponentSelectedCount: number
  opponentBannedCount: number
  arrangeEndsAtServerTime: number | null
}

export interface OnlinePendingTransferView {
  from: OnlinePlayerId
  to: OnlinePlayerId
  reason: 'wrong_claim' | 'opponent_card'
  expiresAtServerTime: number
}

export interface OnlineRoomView {
  code: string
  name: string
  packageId: string
  deckName: string
  you: OnlinePlayerId
  phase: OnlineRoomPhase
  players: Record<OnlinePlayerId, OnlinePlayerView | null>
  cards: OnlineCardView[]
  remainingCardKeys: string[]
  restEndsAtServerTime: number | null
  restAudioUrl: string | null
  arrangeReadyStartAtServerTime: number | null
  restReadyStartAtServerTime: number | null
  roundNo: number
  matchWinner: OnlinePlayerId | null
  fairness: OnlineFairnessView
  draft: OnlineDraftView
  pendingTransfer: OnlinePendingTransferView | null
}

export interface OnlineRoomSummary {
  code: string
  name: string
  deckName: string
  players: number
  status: 'waiting' | 'full' | 'playing'
}

export type OnlineClientMessage =
  | { t: 'hello'; resumeToken?: string }
  | { t: 'listRooms' }
  | {
      t: 'createRoom'
      nickname: string
      name: string
      packageId: string
      deckName: string
      cardKeys: string[]
    }
  | { t: 'joinRoom'; code: string; nickname: string }
  | { t: 'ready'; ready: boolean }
  | { t: 'selectCards'; cardKeys: string[] }
  | { t: 'banCards'; cardKeys: string[] }
  | { t: 'arrangeLayout'; cardKeys: Array<string | null> }
  | { t: 'giveCard'; cardKey: string }
  | { t: 'claim'; roundNo: number; cardKey: string; clientAt: number }
  | { t: 'leaveRoom' }
  | { t: 'ping'; clientAt: number }

export interface OnlineRoundStart {
  t: 'roundStart'
  roundNo: number
  startAtServerTime: number
  windowMs: number
  audioUrl: string
}

export interface OnlineRoundResult {
  t: 'roundResult'
  roundNo: number
  cardKey: string
  winner: OnlinePlayerId | null
  reason: 'claimed' | 'timeout' | 'wrong'
  song: { displayName: string; fileName: string }
  scores: Record<OnlinePlayerId, number>
  remainingCardKeys: string[]
  nextRoundAtServerTime: number | null
}

export type OnlineServerMessage =
  | { t: 'welcome'; resumed: boolean; resumeToken?: string }
  | { t: 'room'; room: OnlineRoomView }
  | { t: 'roomList'; rooms: OnlineRoomSummary[] }
  | OnlineRoundStart
  | {
      t: 'claimFeedback'
      playerId: OnlinePlayerId
      cardKey: string
      correct: boolean
      penalty?: boolean
      transferTo?: OnlinePlayerId
    }
  | { t: 'cardTransfer'; from: OnlinePlayerId; to: OnlinePlayerId; cardKey: string; automatic?: boolean }
  | OnlineRoundResult
  | {
      t: 'matchOver'
      winner: OnlinePlayerId | null
      scores: Record<OnlinePlayerId, number>
      rounds: number
    }
  | { t: 'peer'; playerId: OnlinePlayerId; connected: boolean }
  | {
      t: 'network'
      players: Record<OnlinePlayerId, OnlineNetworkView>
      fairness: OnlineFairnessView
    }
  | { t: 'pong'; clientAt: number; serverAt: number }
  | { t: 'error'; code: string; message: string }

export function onlineCardViewKey(card: OnlineCardView): string {
  return card.key
}
