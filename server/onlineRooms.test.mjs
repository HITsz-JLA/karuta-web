import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { OnlineRoomManager } from './onlineRooms.mjs'

class FakeSocket {
  readyState = 1
  messages = []

  send(value) {
    this.messages.push(JSON.parse(value))
  }
}

function card(number, name) {
  return {
    key: `${number}|images/${number}.jpg|${name}`,
    number,
    imageName: `${number}.jpg`,
    imagePath: `images/${number}.jpg`,
    workName: name,
    songs: [{ fileName: `${number}.mp3`, displayName: `歌曲${number}`, sourcePath: `mp3_files/seg_30/answer/${number}.mp3` }],
  }
}

function candidateCards(count = 60) {
  return Array.from({ length: count }, (_, index) => card(index + 1, `作品${index + 1}`))
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
  assert.equal(arranged.totalRounds, 50)
  assert.equal(arranged.players.A.handCardKeys.length, 25)
  assert.equal(arranged.players.B.handCardKeys.length, 25)
  assert.equal(new Set([...arranged.players.A.handCardKeys, ...arranged.players.B.handCardKeys]).size, 50)
  return room
}

test('two players can create, join, ready, receive a round and claim a card', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-'))
  const manager = new OnlineRoomManager(temp, { maxRooms: 2 })
  try {
    await writeFile(path.join(temp, 'deck.zip'), Buffer.from('placeholder'))
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({
      t: 'createRoom',
      nickname: '房主',
      name: '测试房',
      packageId: 'deck.zip',
      deckName: '测试数据集',
      cards: candidateCards(),
    }))
    const roomMessage = latest(hostSocket, 'room')
    assert.ok(roomMessage)
    assert.equal(roomMessage.room.players.A.nickname, '房主')
    assert.equal(roomMessage.room.cards[0].workName, '作品1')
    assert.equal('songs' in roomMessage.room.cards[0], false)

    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: roomMessage.room.code, nickname: '对手' }))
    const joined = latest(guestSocket, 'room')
    assert.equal(joined.room.players.B.nickname, '对手')
    primeNetwork(manager, [host, guest])
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    const room = await prepareMatch(manager, host, guest, hostSocket, guestSocket)
    room.startPlaying()
    await new Promise((resolve) => setTimeout(resolve, 1_450))
    const round = latest(hostSocket, 'roundStart')
    assert.ok(round)
    assert.match(round.audioUrl, new RegExp(`/api/online/room/${joined.room.code}/audio/`))
    assert.equal('cardKey' in round, false)
    assert.equal('song' in round, false)

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

test('network measurements block unfair rooms before the match starts', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-network-'))
  const manager = new OnlineRoomManager(temp)
  try {
    await writeFile(path.join(temp, 'deck.zip'), Buffer.from('placeholder'))
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({
      t: 'createRoom',
      nickname: 'host',
      packageId: 'deck.zip',
      cards: candidateCards(),
    }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    recordPongs(manager, host, [120, 100, 120])
    recordPongs(manager, guest, [10, 10, 10])

    const measured = latest(hostSocket, 'room')
    assert.equal(measured.room.fairness.status, 'unfair')
    assert.equal(measured.room.fairness.canStart, false)
    assert.match(measured.room.fairness.message, /不适合公平对战/)
    assert.equal(measured.room.players.A.network.rttMs, 120)
    assert.equal(measured.room.players.A.network.jitterMs, 20)
    assert.equal(measured.room.players.B.network.rttMs, 10)

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

test('claim settlement lets a later high-RTT claim win after compensation', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-compensation-'))
  const manager = new OnlineRoomManager(temp)
  try {
    await writeFile(path.join(temp, 'deck.zip'), Buffer.from('placeholder'))
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({
      t: 'createRoom',
      nickname: 'host',
      packageId: 'deck.zip',
      cards: candidateCards(),
    }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    primeNetwork(manager, [host, guest], 20, 20)
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    const room = await prepareMatch(manager, host, guest, hostSocket, guestSocket)
    room.startPlaying()
    await new Promise((resolve) => setTimeout(resolve, 1_450))
    const round = latest(hostSocket, 'roundStart')
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

test('an empty or wrong claim pauses the round until the opponent gives one card', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-room-transfer-'))
  const manager = new OnlineRoomManager(temp)
  try {
    await writeFile(path.join(temp, 'deck.zip'), Buffer.from('placeholder'))
    const hostSocket = new FakeSocket()
    const guestSocket = new FakeSocket()
    const host = manager.connect(hostSocket)
    const guest = manager.connect(guestSocket)
    await manager.handle(host, JSON.stringify({
      t: 'createRoom',
      nickname: 'host',
      packageId: 'deck.zip',
      cards: candidateCards(),
    }))
    const created = latest(hostSocket, 'room')
    await manager.handle(guest, JSON.stringify({ t: 'joinRoom', code: created.room.code, nickname: 'guest' }))
    primeNetwork(manager, [host, guest])
    await manager.handle(host, JSON.stringify({ t: 'ready', ready: true }))
    await manager.handle(guest, JSON.stringify({ t: 'ready', ready: true }))
    const room = await prepareMatch(manager, host, guest, hostSocket, guestSocket)
    room.startPlaying()
    await new Promise((resolve) => setTimeout(resolve, 1_450))

    const round = latest(hostSocket, 'roundStart')
    const guestHandBefore = room.seats.B.handCardKeys.length
    await manager.handle(host, JSON.stringify({ t: 'claim', roundNo: round.roundNo, cardKey: '', clientAt: 1 }))
    assert.equal(room.pendingTransfer.from, 'A')
    assert.equal(room.pendingTransfer.to, 'B')
    assert.equal(latest(hostSocket, 'claimFeedback').penalty, true)

    const gift = room.seats.B.handCardKeys[0]
    await manager.handle(guest, JSON.stringify({ t: 'giveCard', cardKey: gift }))
    assert.equal(room.pendingTransfer, null)
    assert.equal(room.seats.A.handCardKeys.length, 26)
    assert.equal(room.seats.B.handCardKeys.length, guestHandBefore - 1)
    assert.equal(latest(hostSocket, 'cardTransfer').cardKey, gift)
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
      cards: candidateCards(),
    }))
    const error = latest(socket, 'error')
    assert.equal(error.code, 'bad_room')
    assert.equal(manager.rooms.size, 0)
  } finally {
    manager.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})
