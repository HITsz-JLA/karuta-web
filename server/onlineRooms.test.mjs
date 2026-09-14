import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { mock, test } from 'node:test'
import JSZip from 'jszip'
import { MATCH_AUDIO_PRELOAD_LIMIT, OnlineRoomManager, RESUME_TTL_MS } from './onlineRooms.mjs'

class FakeSocket {
  readyState = 1
  messages = []
  closeCalls = 0

  send(value) {
    this.messages.push(JSON.parse(value))
  }

  close() {
    this.closeCalls += 1
    this.readyState = 3
  }
}

async function writeCatalogPackage(directory, count = 60, songsPerCard = 1) {
  const zip = new JSZip()
  const rows = ['category,work_number,work_name,song_slot,song_title,audio_file,audio_path,cover_files,cover_paths']
  for (let index = 1; index <= count; index += 1) {
    for (let songIndex = 1; songIndex <= songsPerCard; songIndex += 1) {
      const songId = `${index}-${songIndex}`
      rows.push(`anime,${index},作品${index},${songIndex},歌曲${songId},${songId}.mp3,mp3_files/seg_30/anime/${songId}.mp3,${index}.jpg,images/${index}.jpg`)
      zip.file(`mp3_files/seg_30/anime/${songId}.mp3`, Buffer.from(`audio-${songId}`))
    }
    zip.file(`images/${index}.jpg`, Buffer.from(`image-${index}`))
  }
  const packageId = 'jla-muca-anime-lite.zip'
  zip.file('meta/metadata.csv', rows.join('\n'))
  await writeFile(path.join(directory, packageId), await zip.generateAsync({ type: 'nodebuffer' }))
  return packageId
}

async function writeCatalogPackageWithWideSpace(directory, count = 60) {
  const zip = new JSZip()
  const rows = ['category,work_number,work_name,song_slot,song_title,audio_file,audio_path,cover_files,cover_paths']
  for (let index = 1; index <= count; index += 1) {
    const workName = index === 1 ? 'マブラヴ　オルタネイティヴ' : `作品${index}`
    rows.push(`anime,${index},${workName},1,歌曲${index},${index}.mp3,mp3_files/seg_30/anime/${index}.mp3,${index}.jpg,images/${index}.jpg`)
    zip.file(`mp3_files/seg_30/anime/${index}.mp3`, Buffer.from(`audio-${index}`))
    zip.file(`images/${index}.jpg`, Buffer.from(`image-${index}`))
  }
  const packageId = 'jla-muca-anime-lite.zip'
  zip.file('meta/metadata.csv', rows.join('\n'))
  await writeFile(path.join(directory, packageId), await zip.generateAsync({ type: 'nodebuffer' }))
  return packageId
}

function latest(socket, type) {
  return [...socket.messages].reverse().find((message) => message.t === type)
}

function primeNetwork(manager, sessions, rttA = 20, rttB = 20) {
  for (let index = 0; index < 3; index += 1) {
    manager.recordPong(sessions[0], rttA)
    manager.recordPong(sessions[1], rttB)
  }
}

function recordPongs(manager, session, samples) {
  for (const sample of samples) manager.recordPong(session, sample)
}

async function prepareMatch(manager, host, guest, hostSocket, guestSocket) {
  const room = [...manager.rooms.values()][0]
  const hostDraft = latest(hostSocket, 'room').room
  const guestDraft = latest(guestSocket, 'room').room
  assert.equal(hostDraft.phase, 'draft_select')
  assert.equal(hostDraft.draft.poolCardKeys.length, 30)
  assert.equal(guestDraft.draft.poolCardKeys.length, 30)
  assert.equal(new Set([...hostDraft.draft.poolCardKeys, ...guestDraft.draft.poolCardKeys]).size, 60)

  await manager.handle(host, JSON.stringify({ t: 'selectCards', cardKeys: hostDraft.draft.poolCardKeys }))
  await manager.handle(guest, JSON.stringify({ t: 'selectCards', cardKeys: guestDraft.draft.poolCardKeys }))

  const hostBan = latest(hostSocket, 'room').room
  const guestBan = latest(guestSocket, 'room').room
  assert.equal(hostBan.phase, 'draft_ban')
  assert.equal(hostBan.draft.exchangeCardKeys.length, 30)
  assert.equal(guestBan.draft.exchangeCardKeys.length, 30)
  const hostOriginalPool = new Set(hostDraft.draft.poolCardKeys)
  assert.equal(hostBan.draft.exchangeCardKeys.some((key) => hostOriginalPool.has(key)), false)

  await manager.handle(host, JSON.stringify({ t: 'banCards', cardKeys: hostBan.draft.exchangeCardKeys.slice(0, 5) }))
  await manager.handle(guest, JSON.stringify({ t: 'banCards', cardKeys: guestBan.draft.exchangeCardKeys.slice(0, 5) }))

  const arranged = latest(hostSocket, 'room').room
  assert.equal(arranged.phase, 'arrange')
  assert.equal('emptyRemainingCount' in arranged, false)
  assert.equal('totalRounds' in arranged, false)
  assert.equal(arranged.players.A.handCardKeys.length, 25)
  assert.equal(arranged.players.B.handCardKeys.length, 25)
  assert.equal(new Set([...arranged.players.A.handCardKeys, ...arranged.players.B.handCardKeys]).size, 50)
  assert.deepEqual(arranged.players.A.handCardKeys, room.seats.A.handCardKeys)
  assert.deepEqual(arranged.players.B.handCardKeys, [...room.seats.B.handCardKeys].sort())
  const guestArranged = latest(guestSocket, 'room').room
  assert.deepEqual(guestArranged.players.B.handCardKeys, room.seats.B.handCardKeys)
  assert.deepEqual(guestArranged.players.A.handCardKeys, [...room.seats.A.handCardKeys].sort())
  return room
}

async function readyRoundAudio(manager, host, guest, hostSocket) {
  const prepare = latest(hostSocket, 'roundPrepare')
  assert.ok(prepare)
  await manager.handle(host, JSON.stringify({ t: 'audioReady', roundNo: prepare.roundNo }))
  assert.equal(latest(hostSocket, 'roundStart'), undefined)
  await manager.handle(guest, JSON.stringify({ t: 'audioReady', roundNo: prepare.roundNo }))
  const round = latest(hostSocket, 'roundStart')
  assert.ok(round)
  assert.ok(round.startAtServerTime - Date.now() >= 1_800)
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, round.startAtServerTime - Date.now()) + 25))
  return round
}

test('two players can create, join, ready, receive a round and claim a card', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-'))
  const manager = new OnlineRoomManager(temp, { maxRooms: 2 })
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({
      t: 'createRoom',
      nickname: '房主',
      name: '测试房',
      packageId,
      deckName: '测试数据集',
    }))
    const roomMessage = latest(hostSocket, 'room')
    assert.ok(roomMessage)
    assert.equal(roomMessage.room.players.A.nickname, '房主')
    assert.equal(roomMessage.room.cards[0].workName, '作品1')
    assert.match(roomMessage.room.cards[0].imageUrl, /card-image/)
    const image = await manager.getPackageCardImage(packageId, roomMessage.room.cards[0].key)
    assert.deepEqual(image.data, Buffer.from('image-1'))
    assert.equal('songs' in roomMessage.room.cards[0], false)

    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: roomMessage.room.code, nickname: '对手' }))
    const joined = latest(guestSocket, 'room')
    assert.equal(joined.room.players.B.nickname, '对手')
    primeNetwork(manager, [host, guest])
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    const room = await prepareMatch(manager, host, guest, hostSocket, guestSocket)
    room.startPlaying()
    const hostLayout = [...room.seats.A.handCardKeys, ...Array(8).fill(null)]
    await manager.handle(host, JSON.stringify({ t: 'arrangeLayout', cardKeys: hostLayout }))
    assert.equal(latest(hostSocket, 'room').room.players.A.layoutCardKeys, null)
    assert.deepEqual(latest(guestSocket, 'room').room.players.A.layoutCardKeys, hostLayout)
    await new Promise((resolve) => setTimeout(resolve, 2_850))
    const round = await readyRoundAudio(manager, host, guest, hostSocket)
    assert.ok(round)
    assert.match(round.audioUrl, new RegExp(`/api/online/room/${joined.room.code}/audio/`))
    assert.equal('cardKey' in round, false)
    assert.equal('song' in round, false)
    assert.equal('isEmpty' in round, false)

    if (room.current.isEmpty) {
      const cardKey = [...room.remaining][0]
      room.current.isEmpty = false
      room.current.cardKey = cardKey
      room.current.song = room.cardByKey.get(cardKey).songs[0]
    }
    const currentKey = room.current.cardKey
    await manager.handle(host, JSON.stringify({ t: 'claim', roundNo: round.roundNo, cardKey: currentKey, clientAt: 1 }))
    assert.equal(latest(hostSocket, 'roundResult'), undefined)
    await new Promise((resolve) => setTimeout(resolve, 160))
    const result = latest(hostSocket, 'roundResult')
    assert.equal(result.winner, 'A')
    assert.equal(result.song.displayName, room.cardByKey.get(currentKey).songs[0].displayName)
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('a round waits for both complete local audio acknowledgements before timing starts', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-audio-ready-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    primeNetwork(manager, [host, guest])
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    const room = await prepareMatch(manager, host, guest, hostSocket, guestSocket)
    room.startPlaying()
    clearTimeout(room.nextRoundTimer)
    room.nextRoundTimer = null
    room.nextRound()

    const prepare = latest(hostSocket, 'roundPrepare')
    assert.ok(prepare)
    assert.equal(room.current.startAt, null)
    assert.equal(room.current.endsAt, null)
    assert.equal(room.roundTimer, null)
    assert.equal(latest(hostSocket, 'roundStart'), undefined)

    await manager.handle(host, JSON.stringify({ t: 'audioReady', roundNo: prepare.roundNo }))
    assert.deepEqual([...room.current.audioReady], ['A'])
    assert.equal(room.current.startAt, null)
    assert.equal(room.roundTimer, null)
    assert.equal(latest(hostSocket, 'roundStart'), undefined)

    await manager.handle(guest, JSON.stringify({ t: 'audioReady', roundNo: prepare.roundNo }))
    assert.ok(room.current.startAt > Date.now())
    assert.equal(room.current.endsAt - room.current.startAt, 10_000)
    assert.ok(room.roundTimer)
    assert.equal(latest(hostSocket, 'roundStart').roundNo, prepare.roundNo)
    assert.equal(prepare.playId, prepare.roundNo)
    assert.equal(latest(hostSocket, 'roundStart').playId, prepare.roundNo)
    assert.equal(latest(hostSocket, 'room').room.players.A.audioReady, true)
    assert.equal(latest(hostSocket, 'room').room.players.B.audioReady, true)
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('arrange broadcasts match audio and start waits until both clients finish loading', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-match-audio-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp, 60, 2)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    primeNetwork(manager, [host, guest])
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    const room = await prepareMatch(manager, host, guest, hostSocket, guestSocket)
    const matchAudio = latest(hostSocket, 'matchAudio')
    assert.ok(matchAudio)
    assert.ok(matchAudio.total > 0)
    assert.equal(matchAudio.tracks.length, matchAudio.total)
    assert.ok(matchAudio.tracks.every((track) => typeof track.audioUrl === 'string' && track.audioUrl.includes('/audio/')))
    assert.equal(latest(hostSocket, 'room').room.matchAudioTotal, matchAudio.total)
    const expectedFormalAudioIds = new Set([
      ...[...room.remaining].flatMap((key) => room.cardByKey.get(key)?.songs || []),
      ...room.emptySongs,
    ].map((song) => JSON.stringify(song)))
    const expectedRestAudioIds = new Set(room.restSongs.map((song) => JSON.stringify(song)))
    const preloadedAudioIds = new Set(room.matchAudioPreloadTokens.map((token) => JSON.stringify(room.matchTracks.get(token))))
    assert.equal(matchAudio.total, MATCH_AUDIO_PRELOAD_LIMIT)
    assert.equal(matchAudio.total, room.matchAudioPreloadTokens.length)
    assert.equal(preloadedAudioIds.size, MATCH_AUDIO_PRELOAD_LIMIT)
    assert.equal([...preloadedAudioIds].every((id) => expectedFormalAudioIds.has(id)), true)
    assert.equal([...preloadedAudioIds].some((id) => expectedRestAudioIds.has(id)), false)
    assert.ok(room.matchTracks.size > matchAudio.total)

    room.requestStartPlaying()
    assert.equal(room.phase, 'arrange')
    assert.equal(latest(hostSocket, 'room').room.waitingMatchAudio, true)

    await manager.handle(host, JSON.stringify({ t: 'matchAudioReady' }))
    assert.equal(room.phase, 'arrange')
    assert.equal(latest(hostSocket, 'room').room.players.A.matchAudioReady, true)

    await manager.handle(guest, JSON.stringify({ t: 'matchAudioReady' }))
    assert.equal(room.phase, 'playing')
    assert.equal(latest(hostSocket, 'room').room.waitingMatchAudio, false)
    clearTimeout(room.nextRoundTimer)
    room.nextRoundTimer = null
    room.nextRound()
    const prepare = latest(hostSocket, 'roundPrepare')
    assert.ok(prepare)
    const prepareToken = prepare.audioUrl.split('/').at(-1)
    assert.ok(prepareToken)
    assert.ok(room.matchTracks.has(prepareToken))
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('match audio wait never starts before both seats are ready', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-match-audio-timeout-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    primeNetwork(manager, [host, guest])
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    const room = await prepareMatch(manager, host, guest, hostSocket, guestSocket)

    room.requestStartPlaying()
    assert.equal(room.phase, 'arrange')
    assert.equal(latest(hostSocket, 'room').room.waitingMatchAudio, true)
    assert.equal(room.matchAudioWaitTimer, null)
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(room.phase, 'arrange')
    assert.equal(latest(hostSocket, 'room').room.waitingMatchAudio, true)

    await manager.handle(host, JSON.stringify({ t: 'matchAudioReady' }))
    assert.equal(room.phase, 'arrange')
    await manager.handle(guest, JSON.stringify({ t: 'matchAudioReady' }))
    assert.equal(room.phase, 'playing')
    assert.equal(latest(hostSocket, 'room').room.waitingMatchAudio, false)
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('start proceeds immediately when both seats already cached match audio', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-match-audio-ready-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    primeNetwork(manager, [host, guest])
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    const room = await prepareMatch(manager, host, guest, hostSocket, guestSocket)

    await manager.handle(host, JSON.stringify({ t: 'matchAudioReady' }))
    await manager.handle(guest, JSON.stringify({ t: 'matchAudioReady' }))
    room.requestStartPlaying()
    assert.equal(room.phase, 'playing')
    assert.equal(latest(hostSocket, 'room').room.waitingMatchAudio, false)
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('disconnect during audio handshake drops that seat ready flag until it acks again', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-audio-resume-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    primeNetwork(manager, [host, guest])
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    const room = await prepareMatch(manager, host, guest, hostSocket, guestSocket)
    room.startPlaying()
    clearTimeout(room.nextRoundTimer)
    room.nextRoundTimer = null
    room.nextRound()

    const prepare = latest(hostSocket, 'roundPrepare')
    const resumeToken = latest(hostSocket, 'welcome').resumeToken
    await manager.handle(host, JSON.stringify({ t: 'audioReady', roundNo: prepare.roundNo }))
    assert.deepEqual([...room.current.audioReady], ['A'])
    assert.equal(latest(hostSocket, 'roundStart'), undefined)

    manager.disconnect(host)
    assert.deepEqual([...room.current.audioReady], [])
    assert.equal(room.current.startAt, null)

    await manager.handle(guest, JSON.stringify({ t: 'audioReady', roundNo: prepare.roundNo }))
    assert.deepEqual([...room.current.audioReady], ['B'])
    assert.equal(latest(guestSocket, 'roundStart'), undefined)

    const resumedSocket = new FakeSocket()
    const resumed = manager.connect(resumedSocket)
    await manager.handle(resumed, JSON.stringify({ t: 'hello', resumeToken }))
    assert.equal(latest(resumedSocket, 'roundPrepare').roundNo, prepare.roundNo)
    assert.equal(latest(resumedSocket, 'roundStart'), undefined)

    await manager.handle(resumed, JSON.stringify({ t: 'audioReady', roundNo: prepare.roundNo }))
    assert.equal(latest(resumedSocket, 'roundStart').roundNo, prepare.roundNo)
    assert.ok(room.current.startAt > Date.now())
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('odd candidate pools discard one server-side card before splitting', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-odd-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp, 61)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    assert.equal(created.room.cards.length, 60)
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    primeNetwork(manager, [host, guest])
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    const draft = latest(hostSocket, 'room').room
    assert.equal(draft.phase, 'draft_select')
    assert.equal(draft.draft.poolCardKeys.length, 30)
    assert.equal(latest(guestSocket, 'room').room.draft.poolCardKeys.length, 30)
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('candidate pools larger than 200 are sampled before the draft split', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-sample-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp, 240)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    assert.equal(created.room.cards.length, 200)
    assert.equal(new Set(created.room.cards.map((card) => card.key)).size, 200)

    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    primeNetwork(manager, [host, guest])
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    const hostDraft = latest(hostSocket, 'room').room
    const guestDraft = latest(guestSocket, 'room').room
    assert.equal(hostDraft.phase, 'draft_select')
    assert.equal(hostDraft.draft.poolCardKeys.length, 100)
    assert.equal(guestDraft.draft.poolCardKeys.length, 100)
    assert.equal(new Set([...hostDraft.draft.poolCardKeys, ...guestDraft.draft.poolCardKeys]).size, 200)
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('network measurements block unfair rooms before the match starts', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-network-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({
      t: 'createRoom',
      nickname: 'host',
      packageId,
    }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    const roomMessagesBeforeNetwork = hostSocket.messages.filter((message) => message.t === 'room').length
    recordPongs(manager, host, [120, 100, 120])
    recordPongs(manager, guest, [10, 10, 10])

    const measured = latest(hostSocket, 'network')
    assert.equal(hostSocket.messages.filter((message) => message.t === 'room').length, roomMessagesBeforeNetwork)
    assert.equal('cards' in measured, false)
    assert.equal(measured.fairness.status, 'unfair')
    assert.equal(measured.fairness.canStart, false)
    assert.match(measured.fairness.message, /不适合公平对战/)
    assert.equal(measured.players.A.rttMs, 120)
    assert.equal(measured.players.A.jitterMs, 20)
    assert.equal(measured.players.B.rttMs, 10)
    assert.deepEqual(latest(guestSocket, 'network').players, measured.players)

    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    assert.equal([...manager.rooms.values()][0].phase, 'lobby')
    assert.equal(latest(hostSocket, 'roundStart'), undefined)
    assert.equal(latest(hostSocket, 'error').code, 'network_unfair')
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('stable heartbeat metrics and idle cleanup do not fan out redundant updates', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-heartbeat-dedup-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))

    recordPongs(manager, host, Array.from({ length: 12 }, () => 20))
    const hostNetworkMessages = hostSocket.messages.filter((message) => message.t === 'network').length
    const guestNetworkMessages = guestSocket.messages.filter((message) => message.t === 'network').length
    recordPongs(manager, host, [20, 20, 20])
    assert.equal(hostSocket.messages.filter((message) => message.t === 'network').length, hostNetworkMessages)
    assert.equal(guestSocket.messages.filter((message) => message.t === 'network').length, guestNetworkMessages)

    const roomMessages = hostSocket.messages.filter((message) => message.t === 'room').length
    manager.cleanup()
    assert.equal(hostSocket.messages.filter((message) => message.t === 'room').length, roomMessages)
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('room snapshots reuse serialized views until room state changes', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-snapshot-cache-'))
  const manager = new OnlineRoomManager(temp)
  let viewCount = 0
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const spectatorSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    const spectator = manager.connect(spectatorSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    const room = [...manager.rooms.values()][0]
    spectator.room = room
    spectator.spectator = true
    room.addSpectator(spectator)

    const originalView = room.view.bind(room)
    room.view = (...args) => {
      viewCount += 1
      return originalView(...args)
    }
    room.sendRoom()
    const firstCount = viewCount
    assert.equal(firstCount, 3)
    room.sendRoom()
    assert.equal(viewCount, firstCount)
    room.touch()
    room.sendRoom()
    assert.equal(viewCount, firstCount + 3)
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('resumed clients receive a full room snapshot after incremental updates', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-resume-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    const resumeToken = latest(hostSocket, 'welcome').resumeToken
    assert.ok(resumeToken)
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))

    manager.disconnect(host)
    const resumedSocket = new FakeSocket()
    const resumed = manager.connect(resumedSocket)
    await manager.handle(resumed, JSON.stringify({ t: 'hello', resumeToken }))

    const restored = latest(resumedSocket, 'room')
    assert.ok(restored)
    assert.equal(restored.room.code, created.room.code)
    assert.equal(restored.room.you, 'A')
    assert.equal(restored.room.cards.length, 60)
    assert.equal(restored.room.players.B.nickname, 'guest')
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('a refresh can take over a still-open player socket without losing the seat', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-resume-takeover-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const replacementSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    const resumeToken = latest(hostSocket, 'welcome').resumeToken
    assert.ok(resumeToken)
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))

    // Keep the old socket registered to model a browser refresh racing the
    // delayed close event. The new connection must still restore player A.
    const replacement = manager.connect(replacementSocket)
    await manager.handle(replacement, JSON.stringify({ t: 'hello', resumeToken }))

    const room = [...manager.rooms.values()][0]
    assert.equal(latest(replacementSocket, 'welcome').resumed, true)
    assert.equal(latest(replacementSocket, 'room').room.you, 'A')
    assert.equal(room.seats.A.socket, replacement)
    assert.equal(room.seats.A.disconnectedAt, null)
    assert.equal(host.room, null)
    assert.equal(host.playerId, null)
    assert.equal(hostSocket.closeCalls, 1)

    // The old close callback must not disconnect the replacement session.
    manager.disconnect(host)
    assert.equal(room.seats.A.socket, replacement)
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('invalid resume tokens are rejected so clients can return to the lobby', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-resume-invalid-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const socket = new FakeSocket()
    const session = manager.connect(socket)
    await manager.handle(session, JSON.stringify({ t: 'hello', resumeToken: 'expired-or-unknown' }))
    const welcome = latest(socket, 'welcome')
    assert.equal(welcome.resumed, false)
    assert.equal(welcome.resumeRejected, true)
    assert.equal(welcome.resumeReason, 'invalid_or_expired')
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('an online seat keeps its resume credential past the restore window', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-resume-online-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    const resumeToken = latest(hostSocket, 'welcome').resumeToken
    assert.ok(resumeToken)
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))

    mock.timers.enable({ apis: ['Date'] })
    try {
      // The credential is armed by a real disconnect, not by the seat creation.
      assert.equal(manager.resumeIndex.get(resumeToken).expiresAt, null)
      mock.timers.tick(RESUME_TTL_MS + 5_000)
      manager.cleanup()
      assert.equal(manager.resumeIndex.has(resumeToken), true)

      // After 95 online seconds a refresh must still restore seat A, even when
      // the previous socket has not finished closing yet.
      const replacementSocket = new FakeSocket()
      const replacement = manager.connect(replacementSocket)
      await manager.handle(replacement, JSON.stringify({ t: 'hello', resumeToken }))
      assert.equal(latest(replacementSocket, 'welcome').resumed, true)
      assert.equal(latest(replacementSocket, 'room').room.you, 'A')
      const room = [...manager.rooms.values()][0]
      assert.equal(room.seats.A.socket, replacement)
      assert.equal(room.seats.A.disconnectedAt, null)
      assert.equal(manager.resumeIndex.get(resumeToken).expiresAt, null)

      // Now the window really starts: 90 seconds from the disconnect.
      manager.disconnect(replacement)
      const record = manager.resumeIndex.get(resumeToken)
      assert.equal(typeof record.expiresAt, 'number')
      assert.ok(record.expiresAt - Date.now() <= RESUME_TTL_MS)
      mock.timers.tick(RESUME_TTL_MS + 1_000)
      manager.cleanup()
      assert.equal(manager.resumeIndex.has(resumeToken), false)
      assert.equal(room.seats.A, null)

      const lateSocket = new FakeSocket()
      const late = manager.connect(lateSocket)
      await manager.handle(late, JSON.stringify({ t: 'hello', resumeToken }))
      const welcome = latest(lateSocket, 'welcome')
      assert.equal(welcome.resumeRejected, true)
      assert.equal(welcome.resumeReason, 'invalid_or_expired')
    } finally {
      mock.timers.reset()
    }
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('a repeated hello on the same connection re-sends the resumed room state', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-resume-repeat-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    const resumeToken = latest(hostSocket, 'welcome').resumeToken
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))

    manager.disconnect(host)
    const resumedSocket = new FakeSocket()
    const resumed = manager.connect(resumedSocket)
    await manager.handle(resumed, JSON.stringify({ t: 'hello', resumeToken }))
    assert.equal(latest(resumedSocket, 'welcome').resumed, true)
    const roomMessages = resumedSocket.messages.filter((message) => message.t === 'room').length

    // A dropped hello response must be recoverable: the client repeats hello on
    // the very same still-open connection.
    await manager.handle(resumed, JSON.stringify({ t: 'hello', resumeToken }))
    const repeatWelcome = latest(resumedSocket, 'welcome')
    assert.equal(repeatWelcome.resumed, true)
    assert.equal(repeatWelcome.resumeRejected, undefined)
    assert.ok(resumedSocket.messages.filter((message) => message.t === 'room').length > roomMessages)
    assert.equal(manager.sessions.get(resumedSocket).playerId, 'A')

    // A different credential must still be refused on a bound connection.
    await manager.handle(resumed, JSON.stringify({ t: 'hello', resumeToken: 'some-other-token' }))
    const rejection = latest(resumedSocket, 'welcome')
    assert.equal(rejection.resumeRejected, true)
    assert.equal(rejection.resumeReason, 'session_already_bound')
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('resume rejections carry structured reasons and leaving deletes the credential', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-resume-reason-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    const resumeToken = latest(hostSocket, 'welcome').resumeToken
    assert.ok(resumeToken)
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))

    // A connection that is already bound to a room must not be rebound through
    // another seat's credential.
    await manager.handle(guest, JSON.stringify({ t: 'hello', resumeToken }))
    const boundWelcome = latest(guestSocket, 'welcome')
    assert.equal(boundWelcome.resumeRejected, true)
    assert.equal(boundWelcome.resumeReason, 'session_already_bound')
    assert.equal(manager.sessions.get(guestSocket).playerId, 'B')

    // An unknown credential is reported as invalid/expired.
    const strangerSocket = new FakeSocket()
    const stranger = manager.connect(strangerSocket)
    await manager.handle(stranger, JSON.stringify({ t: 'hello', resumeToken: 'not-a-real-token' }))
    assert.equal(latest(strangerSocket, 'welcome').resumeReason, 'invalid_or_expired')

    // Leaving on purpose throws the credential away instead of parking it.
    await manager.handle(host, JSON.stringify({ t: 'leaveRoom' }))
    assert.equal(manager.resumeIndex.has(resumeToken), false)
    const afterLeaveSocket = new FakeSocket()
    const afterLeave = manager.connect(afterLeaveSocket)
    await manager.handle(afterLeave, JSON.stringify({ t: 'hello', resumeToken }))
    const afterLeaveWelcome = latest(afterLeaveSocket, 'welcome')
    assert.equal(afterLeaveWelcome.resumeRejected, true)
    assert.equal(afterLeaveWelcome.resumeReason, 'invalid_or_expired')
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('spectators receive a read-only full board and live claim events', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-spectator-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const spectatorSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    const spectator = manager.connect(spectatorSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    primeNetwork(manager, [host, guest])
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    assert.equal(latest(spectatorSocket, 'roomList').rooms.find((item) => item.code === created.room.code)?.status, 'preparing')
    await manager.handle(spectator, JSON.stringify({ t: 'spectateRoom', code: created.room.code }))
    assert.equal(latest(spectatorSocket, 'error').code, 'spectate_unavailable')
    assert.equal(spectator.room, null)
    const room = await prepareMatch(manager, host, guest, hostSocket, guestSocket)
    room.startPlaying()
    clearTimeout(room.nextRoundTimer)
    room.nextRoundTimer = null
    room.nextRound()
    await readyRoundAudio(manager, host, guest, hostSocket)
    assert.equal(latest(spectatorSocket, 'roomList').rooms.find((item) => item.code === room.code)?.status, 'playing')

    const hostLayout = [...room.seats.A.handCardKeys, ...Array(8).fill(null)]
    const guestLayout = [...room.seats.B.handCardKeys, ...Array(8).fill(null)]
    await manager.handle(host, JSON.stringify({ t: 'arrangeLayout', cardKeys: hostLayout }))
    await manager.handle(guest, JSON.stringify({ t: 'arrangeLayout', cardKeys: guestLayout }))
    await manager.handle(spectator, JSON.stringify({ t: 'spectateRoom', code: room.code }))

    const observed = latest(spectatorSocket, 'room').room
    assert.equal(observed.spectator, true)
    assert.deepEqual(observed.players.A.handCardKeys, room.seats.A.handCardKeys)
    assert.deepEqual(observed.players.B.handCardKeys, room.seats.B.handCardKeys)
    assert.deepEqual(observed.players.A.layoutCardKeys, hostLayout)
    assert.deepEqual(observed.players.B.layoutCardKeys, guestLayout)
    assert.ok(latest(spectatorSocket, 'roundStart'))
    assert.equal(room.spectators.has(spectator), true)

    const beforeA = [...room.seats.A.handCardKeys]
    const beforeB = [...room.seats.B.handCardKeys]
    await manager.handle(spectator, JSON.stringify({ t: 'claim', roundNo: room.current.roundNo, cardKey: beforeA[0], clientAt: 1 }))
    await manager.handle(spectator, JSON.stringify({ t: 'arrangeLayout', cardKeys: [...beforeA, ...Array(8).fill(null)] }))
    assert.deepEqual(room.seats.A.handCardKeys, beforeA)
    assert.deepEqual(room.seats.B.handCardKeys, beforeB)

    room.current.isEmpty = false
    room.current.cardKey = beforeA[0]
    room.current.song = room.cardByKey.get(beforeA[0]).songs[0]
    room.current.startAt = Date.now() - 100
    room.current.endsAt = Date.now() + 5_000
    await manager.handle(host, JSON.stringify({ t: 'claim', roundNo: room.current.roundNo, cardKey: beforeA[0], clientAt: 1 }))
    assert.equal(latest(spectatorSocket, 'claimFeedback').playerId, 'A')
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('spectator snapshots stay private, replay active events, and are idempotent', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-spectator-state-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const spectatorSocket = new FakeSocket()
    const lateSocket = new FakeSocket()
    const resolvedSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    const spectator = manager.connect(spectatorSocket)
    const lateSpectator = manager.connect(lateSocket)
    const resolvedSpectator = manager.connect(resolvedSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    primeNetwork(manager, [host, guest])
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    assert.equal(latest(spectatorSocket, 'roomList').rooms.find((item) => item.code === created.room.code)?.status, 'preparing')
    await manager.handle(spectator, JSON.stringify({ t: 'spectateRoom', code: created.room.code }))
    assert.equal(latest(spectatorSocket, 'error').code, 'spectate_unavailable')
    assert.equal(spectator.room, null)
    const room = await prepareMatch(manager, host, guest, hostSocket, guestSocket)

    assert.equal(latest(spectatorSocket, 'roomList').rooms.find((item) => item.code === room.code)?.status, 'playing')
    await manager.handle(spectator, JSON.stringify({ t: 'spectateRoom', code: room.code }))
    const observed = latest(spectatorSocket, 'room').room
    assert.equal(observed.you, null)
    assert.equal(observed.spectator, true)
    assert.deepEqual(observed.draft.poolCardKeys, [])
    assert.deepEqual(observed.draft.selectedCardKeys, [])
    assert.deepEqual(observed.draft.exchangeCardKeys, [])
    assert.deepEqual(observed.draft.bannedCardKeys, [])
    assert.equal(observed.players.A.layoutCardKeys.length, 33)
    assert.equal(observed.players.B.layoutCardKeys.length, 33)

    const errorsBeforeRepeat = spectatorSocket.messages.filter((message) => message.t === 'error').length
    await manager.handle(spectator, JSON.stringify({ t: 'spectateRoom', code: room.code }))
    assert.equal(spectatorSocket.messages.filter((message) => message.t === 'error').length, errorsBeforeRepeat)

    room.startPlaying()
    clearTimeout(room.nextRoundTimer)
    room.nextRoundTimer = null
    room.nextRound()
    const cardKey = [...room.remaining][0]
    room.current.isEmpty = false
    room.current.cardKey = cardKey
    room.current.song = room.cardByKey.get(cardKey).songs[0]
    room.current.startAt = Date.now() - 100
    room.current.endsAt = Date.now() + 5_000
    await manager.handle(host, JSON.stringify({ t: 'claim', roundNo: room.current.roundNo, cardKey, clientAt: 1 }))

    await manager.handle(lateSpectator, JSON.stringify({ t: 'spectateRoom', code: room.code }))
    assert.equal(latest(lateSocket, 'claimFeedback').playerId, 'A')
    assert.equal(latest(lateSocket, 'roundStart').roundNo, room.current.roundNo)

    room.resolveRound('A', 'claimed')
    await manager.handle(resolvedSpectator, JSON.stringify({ t: 'spectateRoom', code: room.code }))
    assert.equal(latest(resolvedSocket, 'roundResult').roundNo, room.current.roundNo)
    assert.equal(latest(resolvedSocket, 'roundResult').winner, 'A')
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('a spectator cannot be rebound through a player resume token', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-spectator-resume-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const spectatorSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    const spectator = manager.connect(spectatorSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    const resumeToken = latest(hostSocket, 'welcome').resumeToken
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    primeNetwork(manager, [host, guest])
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    const room = await prepareMatch(manager, host, guest, hostSocket, guestSocket)
    await manager.handle(spectator, JSON.stringify({ t: 'spectateRoom', code: room.code }))
    manager.disconnect(host)

    await manager.handle(spectator, JSON.stringify({ t: 'hello', resumeToken }))
    assert.equal(latest(spectatorSocket, 'welcome').resumeRejected, true)
    assert.equal(spectator.playerId, null)
    assert.equal(room.seats.A.socket, null)
    assert.equal(room.spectators.has(spectator), true)
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('claim settlement lets a later high-RTT claim win after compensation', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-compensation-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({
      t: 'createRoom',
      nickname: 'host',
      packageId,
    }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    primeNetwork(manager, [host, guest], 20, 20)
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    const room = await prepareMatch(manager, host, guest, hostSocket, guestSocket)
    room.startPlaying()
    await new Promise((resolve) => setTimeout(resolve, 2_850))
    const round = await readyRoundAudio(manager, host, guest, hostSocket)
    if (room.current.isEmpty) {
      const cardKey = [...room.remaining][0]
      room.current.isEmpty = false
      room.current.cardKey = cardKey
      room.current.song = room.cardByKey.get(cardKey).songs[0]
    }
    const currentKey = room.current.cardKey
    primeNetwork(manager, [host, guest], 120, 20)
    await manager.handle(guest, JSON.stringify({ t: 'claim', roundNo: round.roundNo, cardKey: currentKey, clientAt: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 35))
    await manager.handle(host, JSON.stringify({ t: 'claim', roundNo: round.roundNo, cardKey: currentKey, clientAt: 1 }))
    assert.equal(latest(hostSocket, 'roundResult'), undefined)
    await new Promise((resolve) => setTimeout(resolve, 160))
    assert.equal(latest(hostSocket, 'roundResult').winner, 'A')
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('a wrong claim pauses the round until the opponent gives one card', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-transfer-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({
      t: 'createRoom',
      nickname: 'host',
      packageId,
    }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    primeNetwork(manager, [host, guest])
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    const room = await prepareMatch(manager, host, guest, hostSocket, guestSocket)
    room.startPlaying()
    await new Promise((resolve) => setTimeout(resolve, 2_850))

    const round = await readyRoundAudio(manager, host, guest, hostSocket)
    if (room.current.isEmpty) {
      const cardKey = [...room.remaining][0]
      room.current.isEmpty = false
      room.current.cardKey = cardKey
      room.current.song = room.cardByKey.get(cardKey).songs[0]
    }
    const guestHandBefore = room.seats.B.handCardKeys.length
    await manager.handle(host, JSON.stringify({ t: 'claim', roundNo: round.roundNo, cardKey: '', clientAt: 1 }))
    assert.equal(room.pendingTransfer.from, 'A')
    assert.equal(room.pendingTransfer.to, 'B')
    assert.equal(room.pendingTransfer.reason, 'wrong_claim')
    assert.ok(room.pendingTransfer.expiresAtServerTime - Date.now() > 39_000)
    assert.ok(room.current.restEndsAtServerTime - Date.now() > 39_000)
    assert.equal(room.roundTimer, null)
    assert.equal(room.current.settlementTimer, null)
    assert.equal(room.scores.A, 0)
    assert.equal(room.scores.B, 1)
    assert.equal(room.seats.B.score, 1)
    assert.equal(latest(hostSocket, 'room').room.players.B.score, 1)
    assert.equal(latest(hostSocket, 'claimFeedback').penalty, true)

    const gift = room.seats.B.handCardKeys[0]
    await manager.handle(guest, JSON.stringify({ t: 'giveCard', cardKey: gift }))
    assert.equal(room.pendingTransfer, null)
    assert.equal(room.seats.A.handCardKeys.length, 26)
    assert.equal(room.seats.B.handCardKeys.length, guestHandBefore - 1)
    assert.equal(latest(hostSocket, 'cardTransfer').cardKey, gift)
    assert.equal(latest(hostSocket, 'roundResult').reason, 'wrong')
    assert.equal(latest(hostSocket, 'roundResult').remainingCardKeys.includes(room.current.cardKey), true)
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('a wrong claim automatically transfers one card when the transfer window expires', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-transfer-timeout-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    primeNetwork(manager, [host, guest])
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    const room = await prepareMatch(manager, host, guest, hostSocket, guestSocket)
    room.startPlaying()
    await new Promise((resolve) => setTimeout(resolve, 2_850))

    const round = await readyRoundAudio(manager, host, guest, hostSocket)
    if (room.current.isEmpty) {
      const cardKey = [...room.remaining][0]
      room.current.isEmpty = false
      room.current.cardKey = cardKey
      room.current.song = room.cardByKey.get(cardKey).songs[0]
    }
    const hostHandBefore = room.seats.A.handCardKeys.length
    const guestHandBefore = room.seats.B.handCardKeys.length
    await manager.handle(host, JSON.stringify({ t: 'claim', roundNo: round.roundNo, cardKey: '', clientAt: 1 }))
    assert.equal(room.pendingTransfer.reason, 'wrong_claim')
    assert.equal(room.roundTimer, null)
    assert.equal(room.current.settlementTimer, null)

    room.scheduleTransferFallback(room.current, 10)
    await new Promise((resolve) => setTimeout(resolve, 35))

    assert.equal(room.pendingTransfer, null)
    assert.equal(room.seats.A.handCardKeys.length, hostHandBefore + 1)
    assert.equal(room.seats.B.handCardKeys.length, guestHandBefore - 1)
    assert.equal(latest(hostSocket, 'cardTransfer').automatic, true)
    assert.equal(latest(hostSocket, 'roundResult').reason, 'wrong')
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('empty-song rounds use 20 outside songs once and treat every card click as wrong', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-empty-'))
  const manager = new OnlineRoomManager(temp)
  const originalRandom = Math.random
  try {
    const packageId = await writeCatalogPackage(temp, 160)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    const cardKeys = Array.from({ length: 60 }, (_, index) => `${index + 1}|images/${index + 1}.jpg|作品${index + 1}`)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId, cardKeys }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    primeNetwork(manager, [host, guest])
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    const room = await prepareMatch(manager, host, guest, hostSocket, guestSocket)
    assert.equal(room.emptySongs.length, 20)
    assert.equal(room.emptyRemainingSongs.length, 20)

    room.startPlaying()
    clearTimeout(room.nextRoundTimer)
    room.nextRoundTimer = null
    Math.random = () => 0.999
    room.nextRound()
    await readyRoundAudio(manager, host, guest, hostSocket)
    assert.equal(room.current.isEmpty, true)
    assert.equal(room.current.cardKey, '')
    assert.equal(room.emptyRemainingSongs.length, 19)
    const emptyRound = latest(hostSocket, 'roundStart')
    assert.equal('isEmpty' in emptyRound, false)
    assert.equal(emptyRound.windowMs, 10_000)
    assert.equal(room.current.endsAt - room.current.startAt, emptyRound.windowMs)
    room.current.startAt = Date.now() - 100
    room.current.endsAt = Date.now() + 5_000
    const cardKey = room.seats.A.handCardKeys[0]
    const before = new Set(room.remaining)
    const hostHandBefore = room.seats.A.handCardKeys.length
    const guestHandBefore = room.seats.B.handCardKeys.length
    await manager.handle(host, JSON.stringify({ t: 'claim', roundNo: room.current.roundNo, cardKey, clientAt: 1 }))
    assert.equal(room.pendingTransfer.reason, 'wrong_claim')
    assert.notEqual(room.current.resolved, true)
    assert.equal(latest(hostSocket, 'roundResult'), undefined)
    assert.deepEqual(new Set(room.remaining), before)
    assert.equal(room.seats.A.handCardKeys.length, hostHandBefore)
    assert.equal(room.seats.B.handCardKeys.length, guestHandBefore)

    const gift = room.seats.B.handCardKeys[0]
    await manager.handle(guest, JSON.stringify({ t: 'giveCard', cardKey: gift }))
    const result = latest(hostSocket, 'roundResult')
    assert.equal('isEmpty' in result, false)
    assert.equal(result.winner, null)
    assert.equal(result.reason, 'wrong')
    assert.equal(result.scores.A, 0)
    assert.equal(result.scores.B, 1)
    assert.deepEqual(new Set(result.remainingCardKeys), before)
    assert.equal(room.seats.A.handCardKeys.length, hostHandBefore + 1)
    assert.equal(room.seats.B.handCardKeys.length, guestHandBefore - 1)
    assert.ok(room.current.restSong)
    assert.ok(latest(hostSocket, 'room').room.restAudioUrl)
    const matchAudio = latest(hostSocket, 'matchAudio')
    const restAudioUrl = latest(hostSocket, 'room').room.restAudioUrl
    assert.equal(matchAudio.tracks.some((track) => track.audioUrl === restAudioUrl), false)
    const expectedPreloadedAudioIds = new Set(room.matchAudioPreloadTokens.map((token) => JSON.stringify(room.matchTracks.get(token))))
    const expectedRestAudioIds = new Set(room.restSongs.map((song) => JSON.stringify(song)))
    assert.equal(matchAudio.total, MATCH_AUDIO_PRELOAD_LIMIT)
    assert.equal(matchAudio.total, room.matchAudioPreloadTokens.length)
    assert.equal([...expectedPreloadedAudioIds].some((id) => expectedRestAudioIds.has(id)), false)
    const expectedMatchAudioIds = new Set([
      ...[...room.remaining].flatMap((key) => room.cardByKey.get(key)?.songs || []),
      ...room.emptySongs,
    ].map((song) => JSON.stringify(song)))
    assert.equal([...expectedPreloadedAudioIds].every((id) => expectedMatchAudioIds.has(id)), true)
    const fieldSongIds = new Set(room.cards.flatMap((card) => card.songs).map((song) => JSON.stringify(song)))
    const emptySongIds = new Set(room.emptySongs.map((song) => JSON.stringify(song)))
    assert.equal(fieldSongIds.has(JSON.stringify(room.current.restSong)), false)
    assert.equal(emptySongIds.has(JSON.stringify(room.current.restSong)), false)
  } finally {
    Math.random = originalRandom
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('both players can ready during rest and start the next round in five seconds', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-rest-ready-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    primeNetwork(manager, [host, guest])
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    const room = await prepareMatch(manager, host, guest, hostSocket, guestSocket)
    room.startPlaying()
    clearTimeout(room.nextRoundTimer)
    room.nextRoundTimer = null
    room.nextRound()
    await readyRoundAudio(manager, host, guest, hostSocket)
    room.current.isEmpty = false
    room.current.cardKey = room.seats.A.handCardKeys[0]
    room.current.song = room.cardByKey.get(room.current.cardKey).songs[0]
    room.current.startAt = Date.now() - 100
    room.current.endsAt = Date.now() + 5_000
    const round = latest(hostSocket, 'roundStart')
    await manager.handle(host, JSON.stringify({ t: 'claim', roundNo: round.roundNo, cardKey: room.current.cardKey, clientAt: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 160))
    assert.equal(room.current.resolved, true)
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    assert.equal(room.seats.A.restReady, true)
    assert.equal(room.restReadyStartAt, null)
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    assert.equal(room.seats.B.restReady, true)
    assert.ok(room.restReadyStartAt - Date.now() > 4_000)
    assert.equal(latest(hostSocket, 'room').room.restReadyStartAtServerTime, room.restReadyStartAt)
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: false }))
    assert.equal(room.restReadyStartAt, null)
    assert.equal(room.seats.A.restReady, false)
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('both players can ready during opening arrangement and start the game in twenty seconds', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-arrange-ready-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    primeNetwork(manager, [host, guest])
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    const room = await prepareMatch(manager, host, guest, hostSocket, guestSocket)

    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    assert.equal(room.seats.A.arrangeReady, true)
    assert.equal(room.arrangeReadyStartAt, null)
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    assert.equal(room.seats.B.arrangeReady, true)
    assert.ok(room.arrangeReadyStartAt - Date.now() > 19_000)
    const arranged = latest(hostSocket, 'room').room
    assert.equal(arranged.arrangeReadyStartAtServerTime, room.arrangeReadyStartAt)
    assert.equal(arranged.players.A.arrangeReady, true)
    assert.equal(arranged.players.B.arrangeReady, true)

    await manager.handle(host, JSON.stringify({ t: 'ready', ready: false }))
    assert.equal(room.arrangeReadyStartAt, null)
    assert.equal(room.seats.A.arrangeReady, false)
    assert.equal(room.seats.B.arrangeReady, true)
    assert.ok(room.arrangeTimer)
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('correctly claiming a card on the opponent side opens the reverse transfer', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-opponent-transfer-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    primeNetwork(manager, [host, guest])
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    const room = await prepareMatch(manager, host, guest, hostSocket, guestSocket)
    room.startPlaying()
    clearTimeout(room.nextRoundTimer)
    room.nextRoundTimer = null
    room.nextRound()
    const target = room.seats.B.handCardKeys[0]
    const targetCard = room.cardByKey.get(target)
    room.current.isEmpty = false
    room.current.cardKey = target
    room.current.song = targetCard.songs[0]
    room.current.startAt = Date.now() - 100
    room.current.endsAt = Date.now() + 5_000
    await manager.handle(host, JSON.stringify({ t: 'claim', roundNo: room.current.roundNo, cardKey: target, clientAt: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 160))

    assert.equal(latest(hostSocket, 'roundResult').winner, 'A')
    assert.equal(room.pendingTransfer.reason, 'opponent_card')
    assert.equal(room.pendingTransfer.from, 'B')
    assert.equal(room.pendingTransfer.to, 'A')
    assert.equal(room.seats.B.handCardKeys.includes(target), false)
    const gift = room.seats.A.handCardKeys.find((key) => key !== target)
    await manager.handle(host, JSON.stringify({ t: 'giveCard', cardKey: gift }))
    assert.equal(room.pendingTransfer, null)
    assert.equal(room.seats.A.handCardKeys.includes(gift), false)
    assert.equal(room.seats.B.handCardKeys.includes(gift), true)
    assert.ok(room.nextRoundTimer)
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('a player wins immediately when claiming their own last card without a transfer', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-empty-hand-no-transfer-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    primeNetwork(manager, [host, guest])
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    const room = await prepareMatch(manager, host, guest, hostSocket, guestSocket)
    room.startPlaying()
    clearTimeout(room.nextRoundTimer)
    room.nextRoundTimer = null
    room.nextRound()

    const ownLastCard = room.seats.A.handCardKeys[0]
    const guestCards = room.seats.B.handCardKeys.slice(0, 2)
    room.seats.A.handCardKeys = [ownLastCard]
    room.seats.B.handCardKeys = guestCards
    room.remaining = new Set([ownLastCard, ...guestCards])
    room.current.isEmpty = false
    room.current.cardKey = ownLastCard
    room.current.song = room.cardByKey.get(ownLastCard).songs[0]
    room.current.startAt = Date.now() - 100
    room.current.endsAt = Date.now() + 5_000

    await manager.handle(host, JSON.stringify({ t: 'claim', roundNo: room.current.roundNo, cardKey: ownLastCard, clientAt: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 160))

    assert.equal(room.seats.A.handCardKeys.length, 0)
    assert.equal(room.phase, 'over')
    assert.equal(room.pendingTransfer, null)
    assert.equal(latest(hostSocket, 'roundResult').winner, 'A')
    assert.equal(latest(hostSocket, 'matchOver').winner, 'A')
    assert.equal(latest(hostSocket, 'room').room.matchWinner, 'A')
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('a player wins after giving their last card in the required exchange', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-empty-hand-transfer-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    primeNetwork(manager, [host, guest])
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    const room = await prepareMatch(manager, host, guest, hostSocket, guestSocket)
    room.startPlaying()
    clearTimeout(room.nextRoundTimer)
    room.nextRoundTimer = null
    room.nextRound()

    const lastHostCard = room.seats.A.handCardKeys[0]
    const lastGuestCard = room.seats.B.handCardKeys[0]
    room.seats.A.handCardKeys = [lastHostCard]
    room.seats.B.handCardKeys = [lastGuestCard]
    room.remaining = new Set([lastHostCard, lastGuestCard])
    room.current.isEmpty = false
    room.current.cardKey = lastGuestCard
    room.current.song = room.cardByKey.get(lastGuestCard).songs[0]
    room.current.startAt = Date.now() - 100
    room.current.endsAt = Date.now() + 5_000

    await manager.handle(host, JSON.stringify({ t: 'claim', roundNo: room.current.roundNo, cardKey: lastGuestCard, clientAt: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 160))
    assert.equal(room.pendingTransfer.reason, 'opponent_card')
    assert.equal(room.seats.B.handCardKeys.length, 0)

    await manager.handle(host, JSON.stringify({ t: 'giveCard', cardKey: lastHostCard }))

    assert.equal(room.seats.A.handCardKeys.length, 0)
    assert.equal(room.seats.B.handCardKeys.length, 1)
    assert.equal(room.pendingTransfer, null)
    assert.equal(room.phase, 'over')
    assert.equal(room.nextRoundTimer, null)
    assert.equal(latest(hostSocket, 'matchOver').winner, 'A')
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('the card giver wins when a wrong-claim exchange removes their last card', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-empty-hand-wrong-transfer-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackage(temp)
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    primeNetwork(manager, [host, guest])
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    const room = await prepareMatch(manager, host, guest, hostSocket, guestSocket)
    room.startPlaying()
    clearTimeout(room.nextRoundTimer)
    room.nextRoundTimer = null
    room.nextRound()

    const hostCard = room.seats.A.handCardKeys[0]
    const guestLastCard = room.seats.B.handCardKeys[0]
    room.seats.A.handCardKeys = [hostCard]
    room.seats.B.handCardKeys = [guestLastCard]
    room.remaining = new Set([hostCard, guestLastCard])
    room.current.isEmpty = false
    room.current.cardKey = hostCard
    room.current.song = room.cardByKey.get(hostCard).songs[0]
    room.current.startAt = Date.now() - 100
    room.current.endsAt = Date.now() + 5_000

    await manager.handle(host, JSON.stringify({ t: 'claim', roundNo: room.current.roundNo, cardKey: '', clientAt: 1 }))
    assert.equal(room.pendingTransfer.reason, 'wrong_claim')

    await manager.handle(guest, JSON.stringify({ t: 'giveCard', cardKey: guestLastCard }))

    assert.equal(room.seats.B.handCardKeys.length, 0)
    assert.equal(room.seats.A.handCardKeys.length, 2)
    assert.equal(room.pendingTransfer, null)
    assert.equal(room.phase, 'over')
    assert.equal(room.matchWinner, 'B')
    assert.equal(latest(hostSocket, 'roundResult').reason, 'wrong')
    assert.equal(latest(hostSocket, 'matchOver').winner, 'B')
    assert.equal(latest(hostSocket, 'room').room.matchWinner, 'B')
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('room cards keep catalog keys intact so card images still resolve', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-card-key-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const packageId = await writeCatalogPackageWithWideSpace(temp)
    const catalog = await manager.getPackageCatalog(packageId)
    const oddCard = catalog.cards.find((card) => card.workName.includes('\u3000'))
    assert.ok(oddCard, 'catalog must contain the ideographic-space card')
    const catalogImage = await manager.getPackageCardImage(packageId, oddCard.key)
    assert.ok(catalogImage?.data?.length)

    const hostSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    await manager.handle(host, JSON.stringify({ t: 'createRoom', nickname: 'host', packageId }))
    const room = [...manager.rooms.values()][0]
    const roomCard = room.cards.find((card) => card.key === oddCard.key)
    assert.ok(roomCard, 'room must keep the card')
    // Whitespace normalisation used to rewrite the key and break the lookup.
    assert.equal(roomCard.key, oddCard.key)
    assert.ok(roomCard.key.includes('\u3000'))
    const roomImage = await manager.getPackageCardImage(packageId, roomCard.key)
    assert.ok(roomImage?.data?.length)
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})

test('invalid rooms fail closed before a room is created', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-invalid-'))
  const manager = new OnlineRoomManager(temp)
  try {
    const socket = new FakeSocket()
    const session = manager.connect(socket)
    await manager.handle(session, JSON.stringify({
      t: 'createRoom',
      nickname: '房主',
      packageId: '../secret.zip',
    }))
    const error = latest(socket, 'error')
    assert.equal(error.code, 'bad_room')
    assert.equal(manager.rooms.size, 0)
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})
