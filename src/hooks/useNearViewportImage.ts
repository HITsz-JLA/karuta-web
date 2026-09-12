import { useCallback, useEffect, useRef, useState } from 'react'

const DEFAULT_ROOT_SELECTOR = '.local-select-viewport, .online-select-viewport, .draft-card-grid'
const observers = new Map<string, IntersectionObserver>()
const observedTargets = new Map<Element, () => void>()
const rootIds = new WeakMap<Element, number>()
let nextRootId = 1

function observerKey(root: Element | null, rootMargin: string) {
  if (!root) return `${rootMargin}::document`
  let id = rootIds.get(root)
  if (!id) {
    id = nextRootId
    nextRootId += 1
    rootIds.set(root, id)
  }
  return `${rootMargin}::root-${id}`
}

export function observeNearViewport(
  element: HTMLElement,
  onVisible: () => void,
  root: Element | null,
  rootMargin = '240px',
) {
  if (typeof IntersectionObserver === 'undefined') {
    onVisible()
    return () => undefined
  }

  const key = observerKey(root, rootMargin)
  let observer = observers.get(key)
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const callback = observedTargets.get(entry.target)
          if (!callback) continue
          observedTargets.delete(entry.target)
          observer?.unobserve(entry.target)
          callback()
        }
      },
      { root, rootMargin },
    )
    observers.set(key, observer)
  }

  observedTargets.set(element, onVisible)
  observer.observe(element)
  return () => {
    if (observedTargets.get(element) !== onVisible) return
    observedTargets.delete(element)
    observer?.unobserve(element)
  }
}

export function useNearViewportImage(
  hasSource: boolean,
  rootSelector = DEFAULT_ROOT_SELECTOR,
  rootMargin = '240px',
): [boolean, (element: HTMLElement | null) => void] {
  const targetRef = useRef<HTMLElement | null>(null)
  const [shouldLoad, setShouldLoad] = useState(() => typeof IntersectionObserver === 'undefined' || !hasSource)

  const setTarget = useCallback((element: HTMLElement | null) => {
    targetRef.current = element
  }, [])

  useEffect(() => {
    if (!hasSource) {
      setShouldLoad(false)
      return
    }
    if (typeof IntersectionObserver === 'undefined') {
      setShouldLoad(true)
      return
    }

    const target = targetRef.current
    if (!target) {
      setShouldLoad(true)
      return
    }

    setShouldLoad(false)
    const root = target.closest(rootSelector)
    return observeNearViewport(target, () => setShouldLoad(true), root, rootMargin)
  }, [hasSource, rootMargin, rootSelector])

  return [shouldLoad, setTarget]
}
