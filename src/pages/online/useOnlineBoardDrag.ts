import { useCallback, useEffect, useRef, useState, type Dispatch, type DragEvent, type MutableRefObject, type PointerEvent, type SetStateAction } from 'react'
import type { OnlinePlayerId } from '../../lib/onlineProtocol'
import { BATTLE_ANIMATION_LOCAL_ECHO_WINDOW_MS, MAX_HAND_SLOTS } from './onlineConstants'
import type { BattleAnimationPayload } from './onlineTypes'
import { battleAnimationKey, createLayoutAnimation } from './onlineHelpers'

export function useOnlineBoardDrag({
  canArrange,
  pinMode,
  boardSlots,
  setBoardSlots,
  viewerId,
  pendingLocalLayoutKeysRef,
  showBattleAnimation,
}: {
  canArrange: boolean
  pinMode: boolean
  boardSlots: Array<string | null>
  setBoardSlots: Dispatch<SetStateAction<Array<string | null>>>
  viewerId: OnlinePlayerId
  pendingLocalLayoutKeysRef: MutableRefObject<Map<string, number>>
  showBattleAnimation: (payload: BattleAnimationPayload) => void
}) {
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [dragOverSlot, setDragOverSlot] = useState<number | null>(null)
  const draggingKeyRef = useRef<string | null>(null)
  const dragOverSlotRef = useRef<number | null>(null)
  const pointerPositionRef = useRef<{ clientX: number; clientY: number } | null>(null)
  const pointerFrameRef = useRef<number | null>(null)

  const cancelPointerFrame = useCallback(() => {
    if (pointerFrameRef.current !== null) window.cancelAnimationFrame(pointerFrameRef.current)
    pointerFrameRef.current = null
    pointerPositionRef.current = null
  }, [])

  const clearDrag = useCallback(() => {
    cancelPointerFrame()
    draggingKeyRef.current = null
    dragOverSlotRef.current = null
    setDraggingKey(null)
    setDragOverSlot(null)
  }, [cancelPointerFrame])

  const moveCardToSlot = useCallback(
    (sourceKey: string, targetSlot: number) => {
      if (!canArrange || !sourceKey) return
      const target = Math.max(0, Math.min(MAX_HAND_SLOTS - 1, Math.round(targetSlot)))
      const sourceIndex = boardSlots.indexOf(sourceKey)
      if (sourceIndex < 0 || sourceIndex === target) return
      const preview = [...boardSlots]
      const displaced = preview[target]
      preview[target] = sourceKey
      preview[sourceIndex] = displaced && displaced !== sourceKey ? displaced : null
      const layoutAnimation = createLayoutAnimation(boardSlots, preview, viewerId)
      if (layoutAnimation) {
        pendingLocalLayoutKeysRef.current.set(battleAnimationKey(layoutAnimation), Date.now() + BATTLE_ANIMATION_LOCAL_ECHO_WINDOW_MS)
        showBattleAnimation(layoutAnimation)
      }
      setBoardSlots((previous) => {
        const next = [...previous]
        const currentIndex = next.indexOf(sourceKey)
        if (currentIndex < 0 || currentIndex === target) return previous
        const displacedCard = next[target]
        next[target] = sourceKey
        next[currentIndex] = displacedCard && displacedCard !== sourceKey ? displacedCard : null
        return next
      })
    },
    [boardSlots, canArrange, pendingLocalLayoutKeysRef, setBoardSlots, showBattleAnimation, viewerId],
  )

  const updateDragOverSlot = useCallback(
    (clientX: number, clientY: number) => {
      if (!canArrange || !draggingKeyRef.current) return
      const hovered = document.elementFromPoint(clientX, clientY)
      const slotElement = hovered instanceof HTMLElement ? hovered.closest<HTMLElement>('[data-online-slot-index]') : null
      const slotIndex = Number.parseInt(slotElement?.dataset.onlineSlotIndex || '', 10)
      if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= MAX_HAND_SLOTS || slotIndex === dragOverSlotRef.current) return
      dragOverSlotRef.current = slotIndex
      setDragOverSlot(slotIndex)
    },
    [canArrange],
  )

  useEffect(() => {
    if (canArrange || !draggingKeyRef.current) return
    clearDrag()
  }, [canArrange, clearDrag])

  useEffect(() => {
    return () => cancelPointerFrame()
  }, [cancelPointerFrame])

  const handleDragStart = useCallback(
    (event: DragEvent<HTMLButtonElement>, cardKey: string) => {
      if (!canArrange) {
        event.preventDefault()
        return
      }
      draggingKeyRef.current = cardKey
      dragOverSlotRef.current = Math.max(0, boardSlots.indexOf(cardKey))
      setDraggingKey(cardKey)
      setDragOverSlot(dragOverSlotRef.current)
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', cardKey)
    },
    [boardSlots, canArrange],
  )

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLButtonElement>, slotIndex: number) => {
      if (!canArrange || !draggingKeyRef.current) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      dragOverSlotRef.current = slotIndex
      setDragOverSlot(slotIndex)
    },
    [canArrange],
  )

  const handleDrop = useCallback(
    (event: DragEvent<HTMLButtonElement>, targetSlot: number) => {
      if (!canArrange) return
      event.preventDefault()
      const sourceKey = event.dataTransfer.getData('text/plain') || draggingKeyRef.current || ''
      moveCardToSlot(sourceKey, targetSlot)
      clearDrag()
    },
    [canArrange, clearDrag, moveCardToSlot],
  )

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>, cardKey: string) => {
      if (!canArrange || event.pointerType === 'touch') return
      event.preventDefault()
      draggingKeyRef.current = cardKey
      dragOverSlotRef.current = Math.max(0, boardSlots.indexOf(cardKey))
      setDraggingKey(cardKey)
      setDragOverSlot(dragOverSlotRef.current)
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [boardSlots, canArrange],
  )

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (!canArrange || event.pointerType === 'touch' || !draggingKeyRef.current) return
      pointerPositionRef.current = { clientX: event.clientX, clientY: event.clientY }
      if (pointerFrameRef.current !== null) return
      pointerFrameRef.current = window.requestAnimationFrame(() => {
        pointerFrameRef.current = null
        const point = pointerPositionRef.current
        pointerPositionRef.current = null
        if (point) updateDragOverSlot(point.clientX, point.clientY)
      })
    },
    [canArrange, updateDragOverSlot],
  )

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === 'touch') return
      if (canArrange && draggingKeyRef.current && dragOverSlotRef.current !== null) {
        cancelPointerFrame()
        updateDragOverSlot(event.clientX, event.clientY)
        moveCardToSlot(draggingKeyRef.current, dragOverSlotRef.current)
      }
      clearDrag()
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    },
    [canArrange, cancelPointerFrame, clearDrag, moveCardToSlot, updateDragOverSlot],
  )

  const handlePointerCancel = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === 'touch') return
      clearDrag()
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    },
    [clearDrag],
  )

  const selectArrangeCard = useCallback(
    (cardKey: string) => {
      if (!canArrange || pinMode) return
      const slotIndex = boardSlots.indexOf(cardKey)
      if (slotIndex < 0) return
      if (draggingKeyRef.current === cardKey) {
        clearDrag()
        return
      }
      cancelPointerFrame()
      draggingKeyRef.current = cardKey
      dragOverSlotRef.current = slotIndex
      setDraggingKey(cardKey)
      setDragOverSlot(slotIndex)
    },
    [boardSlots, canArrange, cancelPointerFrame, clearDrag, pinMode],
  )

  const handleArrangeSlotClick = useCallback(
    (targetSlot: number) => {
      if (!canArrange) return
      const sourceKey = draggingKeyRef.current
      if (!sourceKey) return
      moveCardToSlot(sourceKey, targetSlot)
      clearDrag()
    },
    [canArrange, clearDrag, moveCardToSlot],
  )

  return {
    draggingKey,
    dragOverSlot,
    draggingKeyRef,
    applyBoardMove: moveCardToSlot,
    clearDrag,
    handleDragStart,
    handleDragOver,
    handleDrop,
    handleDragEnd: clearDrag,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    selectArrangeCard,
    handleArrangeSlotClick,
  }
}
