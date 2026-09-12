import type { OnlinePlayerId } from '../../lib/onlineProtocol'

export type AudioStatus = 'idle' | 'ready' | 'loaded' | 'loading' | 'playing' | 'blocked' | 'error'
export type BattleStyle = 'text' | 'card'

export interface ClaimState {
  cardKey: string
  correct: boolean | null
}

export type BattleAnimation =
  | { id: number; kind: 'claim'; playerId: OnlinePlayerId; cardKey: string }
  | { id: number; kind: 'wrong'; playerId: OnlinePlayerId; cardKey: string }
  | { id: number; kind: 'transfer'; from: OnlinePlayerId; to: OnlinePlayerId; cardKey: string; automatic: boolean }
  | {
      id: number
      kind: 'layout'
      playerId: OnlinePlayerId
      cardKey: string
      sourceSlot: number
      targetSlot: number | null
      exchangeCardKey: string | null
    }
  | { id: number; kind: 'discard'; winner: OnlinePlayerId | null; cardKey: string }

export type BattleAnimationPayload =
  | Omit<Extract<BattleAnimation, { kind: 'claim' }>, 'id'>
  | Omit<Extract<BattleAnimation, { kind: 'wrong' }>, 'id'>
  | Omit<Extract<BattleAnimation, { kind: 'transfer' }>, 'id'>
  | Omit<Extract<BattleAnimation, { kind: 'layout' }>, 'id'>
  | Omit<Extract<BattleAnimation, { kind: 'discard' }>, 'id'>
