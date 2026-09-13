import assert from 'node:assert/strict'
import test from 'node:test'
import {
  onlineAudioForeignMediaUrl,
  onlineAudioGestureMediaUrl,
  onlineAudioSessionSource,
  onlineAudioSourceAttached,
} from '../src/pages/online/onlineAudioSession.ts'

const ROUND = '/api/online/room/ABCDEF/audio/round-2'
const PREPARED = '/api/online/room/ABCDEF/audio/round-2'
const REST = '/api/online/room/ABCDEF/audio/rest-1'
const PREVIOUS_ROUND = '/api/online/room/ABCDEF/audio/round-1'
const ROUND_BLOB = 'blob:http://127.0.0.1:8787/round-2'
const PREVIOUS_BLOB = 'blob:http://127.0.0.1:8787/round-1'

function sources(overrides = {}) {
  return {
    roundAudioUrl: null,
    preparedAudioUrl: null,
    restAudioUrl: null,
    loadedLocalSource: null,
    loadedLocalUrl: null,
    mediaSrc: '',
    mediaCurrentSrc: '',
    ...overrides,
  }
}

test('a running round is the session source while the round is on the board', () => {
  assert.deepEqual(
    onlineAudioSessionSource(sources({ roundAudioUrl: ROUND, restAudioUrl: REST })),
    { role: 'listen', source: ROUND },
  )
  assert.deepEqual(
    onlineAudioSessionSource(sources({ preparedAudioUrl: PREPARED })),
    { role: 'listen', source: PREPARED },
  )
  assert.deepEqual(onlineAudioSessionSource(sources({ restAudioUrl: REST })), { role: 'rest', source: REST })
  assert.equal(onlineAudioSessionSource(sources()), null)
})

test('a gesture never starts the rest track that is still attached during a round', () => {
  // This is the reported spectator bug: the rest song stays attached (paused)
  // until the round audio has finished downloading, so a gesture used to play
  // the rest song and seek it to the running round's clock.
  const downloading = sources({
    roundAudioUrl: ROUND,
    restAudioUrl: null,
    mediaSrc: REST,
    mediaCurrentSrc: REST,
  })
  assert.equal(onlineAudioGestureMediaUrl(downloading), null)
  assert.equal(onlineAudioSourceAttached(downloading), false)
  assert.equal(onlineAudioForeignMediaUrl(downloading), REST)

  // Same situation while both players are still preparing the round.
  const preparing = sources({ preparedAudioUrl: PREPARED, mediaSrc: REST, mediaCurrentSrc: REST })
  assert.equal(onlineAudioGestureMediaUrl(preparing), null)
  assert.equal(onlineAudioForeignMediaUrl(preparing), REST)
})

test('a gesture resumes the downloaded round song once its blob is attached', () => {
  const ready = sources({
    roundAudioUrl: ROUND,
    loadedLocalSource: ROUND,
    loadedLocalUrl: ROUND_BLOB,
    mediaSrc: ROUND_BLOB,
    mediaCurrentSrc: ROUND_BLOB,
  })
  assert.equal(onlineAudioGestureMediaUrl(ready), ROUND_BLOB)
  assert.equal(onlineAudioSourceAttached(ready), true)
  assert.equal(onlineAudioForeignMediaUrl(ready), null)
})

test('a blob from an earlier round is treated as a foreign source', () => {
  const stale = sources({
    roundAudioUrl: ROUND,
    loadedLocalSource: PREVIOUS_ROUND,
    loadedLocalUrl: PREVIOUS_BLOB,
    mediaSrc: PREVIOUS_BLOB,
    mediaCurrentSrc: PREVIOUS_BLOB,
  })
  assert.equal(onlineAudioGestureMediaUrl(stale), null)
  assert.equal(onlineAudioSourceAttached(stale), false)
  assert.equal(onlineAudioForeignMediaUrl(stale), PREVIOUS_BLOB)
})

test('the rest window may start or resume the streamed rest track only', () => {
  const resting = sources({ restAudioUrl: REST, mediaSrc: REST, mediaCurrentSrc: REST })
  assert.equal(onlineAudioGestureMediaUrl(resting), REST)
  assert.equal(onlineAudioSourceAttached(resting), true)
  assert.equal(onlineAudioForeignMediaUrl(resting), null)

  // The rest window has begun but the element still holds the round blob.
  const staleRound = sources({
    restAudioUrl: REST,
    loadedLocalSource: ROUND,
    loadedLocalUrl: ROUND_BLOB,
    mediaSrc: ROUND_BLOB,
    mediaCurrentSrc: ROUND_BLOB,
  })
  assert.equal(onlineAudioGestureMediaUrl(staleRound), null)
  assert.equal(onlineAudioForeignMediaUrl(staleRound), ROUND_BLOB)
})

test('an empty element needs no detach and offers no gesture source', () => {
  const idle = sources({ roundAudioUrl: ROUND })
  assert.equal(onlineAudioForeignMediaUrl(idle), null)
  assert.equal(onlineAudioGestureMediaUrl(idle), null)
  assert.equal(onlineAudioGestureMediaUrl(sources()), null)
})
