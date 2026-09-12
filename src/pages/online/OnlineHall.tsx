import { Link } from 'react-router-dom'
import type { OnlineRoomSummary } from '../../lib/onlineProtocol'
import type { OnlineSocket } from '../../lib/onlineSocket'
import type { ServerPackage, ServerPackageCatalog, ServerPackageCatalogCard } from '../../lib/serverPackages'
import { CURATED_SERVER_PACKAGES } from '../../lib/serverPackages'
import { MAX_CANDIDATE_CARDS, MIN_CANDIDATE_CARDS } from './onlineConstants'
import { VirtualServerCardGrid } from './onlineViews'

type CuratedPackage = {
  meta: (typeof CURATED_SERVER_PACKAGES)[number]
  serverPackage: ServerPackage
}

export function OnlineHall({
  connected,
  audioButtonLabel,
  onUnlockAudio,
  nickname,
  onNicknameChange,
  roomName,
  onRoomNameChange,
  packagesLoading,
  catalogLoading,
  catalog,
  activePackageId,
  onPackageChange,
  onlinePackages,
  selectedPackage,
  boardCount,
  onBoardCountChange,
  keyword,
  onKeywordChange,
  selectedIds,
  eligibleCards,
  visibleCards,
  onToggleCard,
  onSelectAll,
  onCreateRoom,
  onJoinRoom,
  onSpectateRoom,
  joinCode,
  onJoinCodeChange,
  rooms,
  socket,
  busy,
  message,
}: {
  connected: boolean
  audioButtonLabel: string
  onUnlockAudio: () => void
  nickname: string
  onNicknameChange: (value: string) => void
  roomName: string
  onRoomNameChange: (value: string) => void
  packagesLoading: boolean
  catalogLoading: boolean
  catalog: ServerPackageCatalog | null
  activePackageId: string
  onPackageChange: (value: string) => void
  onlinePackages: CuratedPackage[]
  selectedPackage: CuratedPackage | null
  boardCount: number
  onBoardCountChange: (value: number) => void
  keyword: string
  onKeywordChange: (value: string) => void
  selectedIds: Set<string>
  eligibleCards: ServerPackageCatalogCard[]
  visibleCards: ServerPackageCatalogCard[]
  onToggleCard: (cardKey: string) => void
  onSelectAll: () => void
  onCreateRoom: () => void
  onJoinRoom: () => void
  onSpectateRoom: (code: string) => void
  joinCode: string
  onJoinCodeChange: (value: string) => void
  rooms: OnlineRoomSummary[]
  socket: OnlineSocket
  busy: boolean
  message: string | null
}) {
  return (
    <div className="online-page">
      <section className="hero">
        <div className="row spread">
          <div>
            <h1>在线 1v1 歌牌对战</h1>
            <p>双方看到同一组歌牌卡面，听到歌曲后抢先点击对应卡牌。</p>
          </div>
          <div className="row online-lobby-actions">
            <span className={`connection-chip${connected ? ' online' : ''}`}>
              {connected ? '在线服务已连接' : '正在连接…'}
            </span>
            <button className="btn btn-secondary online-lobby-audio" type="button" onClick={onUnlockAudio}>
              {audioButtonLabel}
            </button>
          </div>
        </div>
      </section>

      <div className="online-lobby-grid">
        <section className="panel warm stack">
          <div className="row spread">
            <strong>创建房间</strong>
            <span className="muted small">服务器牌组提供同一套歌牌卡面</span>
          </div>
          <div className="field">
            <label htmlFor="onlineNickname">你的昵称</label>
            <input id="onlineNickname" value={nickname} maxLength={20} onChange={(event) => onNicknameChange(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="roomName">房间名称</label>
            <input id="roomName" value={roomName} maxLength={40} onChange={(event) => onRoomNameChange(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="onlineDeck">使用服务器牌组</label>
            <select id="onlineDeck" value={activePackageId} onChange={(event) => onPackageChange(event.target.value)} disabled={packagesLoading || catalogLoading}>
              <option value="">{onlinePackages.length ? '请选择服务器牌组' : '服务器暂无可用牌组'}</option>
              {onlinePackages.map(({ meta, serverPackage }) => (
                <option key={serverPackage.id} value={serverPackage.id}>
                  {meta.name} · {serverPackage.name}
                </option>
              ))}
            </select>
          </div>
          {!packagesLoading && !onlinePackages.length ? (
            <p className="notice warn">在线歌牌只使用服务器上已发布的牌组，请联系管理员检查 data-packages。</p>
          ) : null}
          <div className="row">
            <div className="field" style={{ flex: '0 0 120px' }}>
              <label htmlFor="boardCount">候选牌数量</label>
              <input id="boardCount" type="number" min={MIN_CANDIDATE_CARDS} max={MAX_CANDIDATE_CARDS} step={1} value={boardCount} onChange={(event) => onBoardCountChange(Number(event.target.value))} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="onlineSearch">筛选卡面</label>
              <input id="onlineSearch" value={keyword} onChange={(event) => onKeywordChange(event.target.value)} placeholder="作品名或牌号" />
            </div>
          </div>
          <div className="row spread draft-selection-summary">
            <p className="muted small">已选 {selectedIds.size} / {boardCount} 张；超过 200 张时服务器会先随机抽 200 张，再由双方各分到 100 张并各选 30 张；奇数会先弃置 1 张。</p>
            <button className="btn btn-secondary" type="button" onClick={onSelectAll} disabled={!eligibleCards.length}>全选服务器牌组</button>
          </div>
          {catalogLoading ? <div className="empty-state">正在读取服务器牌组目录…</div> : null}
          {!catalogLoading && catalog?.packageId === activePackageId && eligibleCards.length ? (
            <VirtualServerCardGrid
              cards={visibleCards}
              packageId={activePackageId}
              selected={selectedIds}
              onToggle={onToggleCard}
            />
          ) : null}
          {!catalogLoading && !eligibleCards.length ? <div className="empty-state">服务器牌组没有可用于在线对战的卡牌</div> : null}
          <button className="btn btn-primary btn-lg" type="button" onClick={onCreateRoom} disabled={busy || !connected || catalogLoading || !selectedPackage}>
            {busy ? '创建中…' : '创建歌牌房间'}
          </button>
        </section>

        <section className="panel cool stack">
          <strong>加入房间</strong>
          <p className="muted small">输入朋友分享的 6 位房间码；加入后直接读取服务器牌组，不需要本机预先导入 ZIP。</p>
          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="joinCode">房间码</label>
              <input id="joinCode" value={joinCode} maxLength={6} onChange={(event) => onJoinCodeChange(event.target.value.toUpperCase())} placeholder="例如 A7K2PM" />
            </div>
            <button className="btn btn-primary" type="button" onClick={onJoinRoom} disabled={busy || !connected}>
              加入
            </button>
          </div>
          <div className="row spread">
            <strong>公开房间</strong>
            <button className="btn btn-secondary" type="button" onClick={() => socket.send({ t: 'listRooms' })} disabled={!connected}>
              刷新
            </button>
          </div>
          <div className="room-list">
            {!rooms.length ? <div className="empty-state">暂时没有公开房间</div> : null}
            {rooms.map((item) => (
              <button
                key={item.code}
                type="button"
                className={`room-list-item${item.status === 'playing' ? ' spectateable' : ''}`}
                onClick={() => (item.status === 'playing' ? onSpectateRoom(item.code) : item.status === 'preparing' ? undefined : onJoinCodeChange(item.code))}
                disabled={busy || item.status === 'preparing'}
                aria-label={item.status === 'playing' ? `观战 ${item.name}` : item.status === 'preparing' ? `准备中 ${item.name}` : `填写房间码 ${item.name}`}
              >
                <span>
                  <strong>{item.name}</strong>
                  <span className="muted small">{item.deckName} · {item.players}/2 人 · {item.status === 'playing' ? '对局进行中，点击观战' : item.status === 'preparing' ? '双方准备中' : item.status === 'full' ? '等待加入' : '等待对手'}</span>
                </span>
                <span className={`room-code${item.status === 'playing' ? ' spectate-label' : ''}`}>{item.status === 'playing' ? '观战' : item.status === 'preparing' ? '准备中' : item.code}</span>
              </button>
            ))}
          </div>
          <div className="online-rules stack">
            <strong>玩法</strong>
            <span className="muted small">1. 候选牌随机分成两份，双方各选 30 张并互换</span>
            <span className="muted small">2. 双方各从收到的 30 张中 BAN 5 张，剩余各 25 张</span>
            <span className="muted small">3. 开局排牌 3 分钟；3×11 是 33 个固定可放置槽位，只能调整自己的牌区</span>
            <span className="muted small">4. 空牌歌曲来自场外 20 首，单次出现后移出空牌池；没有对应卡面，点击任一卡面都会判错</span>
            <span className="muted small">5. 普通歌曲选错或正确收取对手牌后，进入 40 秒休息交牌阶段</span>
            <span className="muted small">6. 开局排牌和休息阶段都可提前准备；开局双方准备后 20 秒进入游戏，休息阶段双方准备后 5 秒进入下一回合</span>
            <span className="muted small">7. 无需换牌的收牌结算后，或完成换牌后某方手牌为 0，该方立即获胜并结束对局</span>
          </div>
          <Link className="btn btn-secondary" to="/admin">
            管理服务器牌组
          </Link>
        </section>
      </div>

      {message ? <div className="toast">{message}</div> : null}
    </div>
  )
}
