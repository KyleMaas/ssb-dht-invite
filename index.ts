import run = require('promisify-tuple')
import {plugin, muxrpc} from 'secret-stack-decorators'
const crypto = require('crypto')
const pull = require('pull-stream')
const Pushable = require('pull-pushable')
const Notify = require('pull-notify')
const DHT = require('multiserver-dht')
const explain = require('explain-error')
const level = require('level')
const path = require('path')
const debug = require('debug')('ssb:dht-invite')

type Seed = string
type HostingInfo = {claimer: string; online: boolean}
type CB<T> = (err?: any, val?: T) => void

/**
 * The type of requests and responses exchanged during invite claiming.
 */
type Msg = {feed: string; seed: string}

type ParseInviteReturn =
  | [Error]
  | [undefined, {seed: string; addr: string; remoteId: string}]

function dhtPeerConnected(type: string, addr: string, key: string, det: any) {
  if (type !== 'connected') return false
  if (!addr.startsWith('dht:')) return false
  if (!key) return false
  if (!det?.rpc) return false
  if (det.rpc.meta !== 'dht') return false
  return true
}

/**
 * Checks if a remote DHT peer is the client, while we are the host
 */
function dhtClientConnected({type, address, key, details}: any) {
  if (!dhtPeerConnected(type, address, key, details)) return false
  return !details.isClient
}

/**
 * Checks if a remote DHT peer is the host, while we are the client
 */
function dhtServerConnected({type, address, key, details}: any) {
  if (!dhtPeerConnected(type, address, key, details)) return false
  return details.isClient
}

function dhtPeerDisconnected({type, address, key}: any) {
  if (type !== 'disconnected') return false
  if (!address.startsWith('dht:')) return false
  if (!key) return false
  return true
}

@plugin('1.0.0')
class dhtInvite {
  private readonly ssb: Record<string, any>
  private readonly config: Record<string, any>
  private readonly serverChannels: Record<string, any>
  private readonly serverCodesCache: Map<Seed, HostingInfo>
  private readonly serverCodesHosting: CallableFunction & Record<string, any>
  private readonly onlineRemoteClients: Set<string>
  private initialized: boolean
  private serverCodesDB: Record<string, any> | null

  constructor(ssb: any, config: any) {
    this.ssb = ssb
    this.config = config
    this.serverChannels = Pushable()
    this.serverCodesCache = new Map<Seed, HostingInfo>()
    this.serverCodesHosting = Notify()
    this.onlineRemoteClients = new Set<string>()
    this.initialized = false
    this.serverCodesDB = null

    this.init()
  }

  private init() {
    if (!this.ssb.conn?.connect || !this.ssb.conn?.hub) {
      throw new Error('plugin ssb-dht-invite requires ssb-conn to be installed')
    }
    if (!this.ssb.friends?.isFollowing) {
      debug(
        'this plugin works better with ssb-friends installed, ' +
          'but it was not found'
      )
    }

    // Install the multiserver plugin for DHT
    this.ssb.multiserver.transport({
      name: 'dht',
      create: (dhtConfig: any) =>
        DHT({keys: this.serverChannels, port: dhtConfig.port}),
    })

    // Update record of online RPC clients using DHT transport.
    pull(
      this.ssb.conn.hub().listen(),
      pull.filter(dhtClientConnected),
      pull.drain(({key}: {key: string}) => {
        this.onlineRemoteClients.add(key)
        if (this.initialized) {
          this.updateServerCodesCacheOnlineStatus()
          this.emitServerCodesHosting()
        }
      })
    )
    pull(
      this.ssb.conn.hub().listen(),
      pull.filter(dhtPeerDisconnected),
      pull.drain(({key}: {key: string}) => {
        if (!this.onlineRemoteClients.has(key)) return
        this.onlineRemoteClients.delete(key)
        if (this.initialized) {
          this.updateServerCodesCacheOnlineStatus()
          this.emitServerCodesHosting()
        }
      })
    )

    // Finish the accept() steps by calling the remote peer's use()
    pull(
      this.ssb.conn.hub().listen(),
      pull.filter(dhtServerConnected),
      pull.drain(({details, address}: any) => {
        const seed = this.addressToSeed(address)
        const req: Msg = {seed, feed: this.ssb.id}
        debug('connected to DHT host, will call its use(%o)', req)
        details.rpc.dhtInvite.use(req, (err: any) => {
          console.error('Could not claim invite code at DHT host because:', err)
        })
      })
    )
  }

  /**
   * Update the online status of the server codes cache.
   */
  private updateServerCodesCacheOnlineStatus() {
    this.serverCodesCache.forEach((hInfo: HostingInfo, seed: Seed) => {
      const claimer = hInfo.claimer
      if (claimer === 'unclaimed') return
      const online = this.onlineRemoteClients.has(claimer)
      if (hInfo.online !== online) {
        this.serverCodesCache.set(seed, {claimer, online})
      }
    })
  }

  /**
   * Emit an Array<{seed, claimer, online}> on the hostingInvites
   * notifier stream.
   */
  private emitServerCodesHosting() {
    this.serverCodesHosting(
      Array.from(
        this.serverCodesCache.entries()
      ).map(([seed, {claimer, online}]) => ({seed, claimer, online}))
    )
  }

  private emitServerChannels(map: Map<Seed, any>) {
    this.serverChannels.push(
      Array.from(map.entries()).map(([seed]) => seed + ':' + this.ssb.id)
    )
  }

  private async setupServerCodesDB() {
    const dbPath = path.join(this.config.path, 'dhtServerCodes')
    const opts = {valueEncoding: 'json'}
    const [err2, db] = await run<any>(level)(dbPath, opts)
    if (err2) throw err2

    this.serverCodesDB = db
    this.serverCodesDB!.get = this.serverCodesDB!.get.bind(this.serverCodesDB)
    this.serverCodesDB!.put = this.serverCodesDB!.put.bind(this.serverCodesDB)
    this.serverCodesDB!.del = this.serverCodesDB!.del.bind(this.serverCodesDB)
    this.serverCodesDB!.createReadStream().on(
      'data',
      (data: {key: string; value: string}) => {
        const seed = data.key
        const claimer = data.value
        debug('server channels: emit %s', seed + ':' + this.ssb.id)
        this.serverCodesCache.set(seed, {claimer, online: false})
        this.emitServerChannels(this.serverCodesCache)
        this.emitServerCodesHosting()
        this.updateServerCodesCacheOnlineStatus()
      }
    )
  }

  /**
   * Given an invite code as a string, return the seed and remoteId.
   */
  private parseInvite(invite: string): ParseInviteReturn {
    if (typeof invite !== 'string' || invite.length === 0) {
      return [new Error('Cannot `accept` the DHT invite, it is missing')]
    }
    const parts = invite.split(':')
    if (parts.length !== 3) {
      return [
        new Error('Cannot `accept` the DHT invite, it is missing some parts'),
      ]
    }
    if (parts[0] !== 'dht') {
      return [
        new Error('Cannot `accept` the DHT invite, it should start with "dht"'),
      ]
    }
    const seed = parts[1]
    if (seed.length === 0) {
      return [
        new Error('Cannot `accept` the DHT invite, the seed part is missing'),
      ]
    }
    const remoteId = parts[2]
    if (remoteId.length === 0) {
      return [
        new Error(
          'Cannot `accept` the DHT invite, the feed id part is missing'
        ),
      ]
    }
    const pubkey = remoteId.replace(/^\@/, '').replace(/\.ed25519$/, '')
    const transform = `shs:${pubkey}`
    const addr = invite + '~' + transform
    return [undefined, {seed, addr, remoteId}]
  }

  private addressToSeed(address: string): string {
    const parts = address.split(':')
    if (parts.length < 2 || parts[0] !== 'dht' || !parts[1]) {
      throw new Error('Cannot get seed from address: ' + address)
    }
    return parts[1]
  }

  @muxrpc('async', {master: 'allow'})
  public start = (cb: CB<true>) => {
    if (this.initialized) return cb(null, true)
    debug('start()')
    this.setupServerCodesDB()
    this.initialized = true
    cb(null, true)
  }

  @muxrpc('async', {master: 'allow'})
  public create = async (cb: CB<string>) => {
    if (!this.initialized || !this.serverCodesDB) {
      return cb(
        new Error('Cannot call dhtInvite.create() before dhtInvite.start()')
      )
    }
    const seed = crypto.randomBytes(32).toString('base64')
    const claimer = 'unclaimed'
    const [err] = await run(this.serverCodesDB.put)(seed, claimer)
    if (err) return cb(err)
    this.serverCodesCache.set(seed, {claimer, online: false})
    this.emitServerChannels(this.serverCodesCache)
    this.emitServerCodesHosting()
    cb(null, 'dht:' + seed + ':' + this.ssb.id)
  }

  @muxrpc('async', {anonymous: 'allow'})
  public use = async (req: Msg, cb: CB<Msg>) => {
    if (!this.initialized || !this.serverCodesDB) {
      return cb(
        new Error('Cannot call dhtInvite.use() before dhtInvite.start()')
      )
    }

    const seed = req.seed
    const friendId = req.feed
    debug('use() called with request %o', req)

    // fetch claimer
    const [err, claimer] = await run<string>(this.serverCodesDB.get)(seed)
    if (err)
      return cb(explain(err, 'Cannot `use` an invite that does not exist'))
    if (claimer === friendId) {
      debug('use() is redundant, has already happened')
      return cb(null, {seed: seed, feed: this.ssb.id})
    } else if (claimer !== 'unclaimed') {
      return cb(new Error('Cannot `use` an already claimed invite'))
    }

    // claimer is definitely "unclaimed"
    debug('use() will claim invite')
    const [err2] = await run(this.serverCodesDB.put)(seed, friendId)
    if (err2) return cb(err2)
    this.serverCodesCache.set(seed, {claimer: friendId, online: true})
    this.emitServerCodesHosting()

    // follow the remote peer if we got ssb-friends and they're not yet followed
    if (this.ssb.friends) {
      const [err3, alreadyFollow] = await run<boolean>(
        this.ssb.friends.isFollowing
      )({source: this.ssb.id, dest: friendId})
      if (err3) return cb(err3)

      if (alreadyFollow) {
        debug(
          'use() will not follow remote peer because they are already followed'
        )
      } else {
        debug('use() will follow remote peer')
        const [err4] = await run(this.ssb.publish)({
          type: 'contact',
          contact: friendId,
          following: true,
        })
        if (err4) return cb(err4)
      }
    } else {
      debug('no ssb-friends plugin found, so we wont follow the remote peer')
      console.error(
        'ssb-dht-invite requires ssb-friends when following remote peers'
      )
    }

    const res: Msg = {seed: seed, feed: this.ssb.id}
    debug('use() will respond with %o', res)
    cb(null, res)
  }

  @muxrpc('async', {master: 'allow'})
  public accept = async (invite: string, cb: CB<true>) => {
    // parse invite code
    const [e1, parsed] = this.parseInvite(invite)
    if (e1) return cb(e1)
    const {remoteId, addr, seed} = parsed!

    // follow the remote peer if we got ssb-friends and they're not yet followed
    if (this.ssb.friends) {
      const [err3, alreadyFollow] = await run<boolean>(
        this.ssb.friends.isFollowing
      )({source: this.ssb.id, dest: remoteId})
      if (err3) return cb(err3)

      if (alreadyFollow) {
        debug(
          'accept() wont follow remote peer because they are already followed'
        )
      } else {
        debug('accept() will follow friend %s', remoteId)
        const [e2] = await run(this.ssb.publish)({
          type: 'contact',
          contact: remoteId,
          following: true,
        })
        if (e2) return cb(explain(e2, 'Unable to follow friend behind invite'))
      }
    } else {
      debug('no ssb-friends plugin found, so we wont follow the remote peer')
      console.error(
        'ssb-dht-invite requires ssb-friends when following remote peers'
      )
    }

    debug('accept() will remember the address %s in ConnDB', addr)
    this.ssb.conn.remember(addr, {type: 'dht'})

    debug('accept() will ssb.conn.connect to remote peer %s', addr)
    const [e3, rpc] = await run<any>(this.ssb.conn.connect)(addr, {type: 'dht'})
    if (e3) return cb(explain(e3, 'Could not connect to DHT server'))
    debug('accept() has ssb.conn.connected to remote peer %s', addr)

    cb(null, true)
  }

  @muxrpc('async', {master: 'allow'})
  public remove = async (invite: string, cb: CB<true>) => {
    if (!this.initialized || !this.serverCodesDB) {
      return cb(
        new Error('Cannot call dhtInvite.remove() before dhtInvite.start()')
      )
    }

    if (this.serverCodesCache.has(invite)) {
      const [err] = await run(this.serverCodesDB.del)(invite)
      if (err) return cb(explain(err, 'Could not delete server invite code'))
      this.serverCodesCache.delete(invite)
      this.emitServerChannels(this.serverCodesCache)
      this.emitServerCodesHosting()
    }
    cb(null, true)
  }

  @muxrpc('source', {master: 'allow'})
  public hostingInvites = () => this.serverCodesHosting.listen()
}

module.exports = dhtInvite
