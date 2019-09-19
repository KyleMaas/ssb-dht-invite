import sleep from 'delay'
import run = require('promisify-tuple')
import {plugin, muxrpc} from 'secret-stack-decorators'
const crypto = require('crypto')
const pull = require('pull-stream')
const Pushable = require('pull-pushable')
const Notify = require('pull-notify')
const DHT = require('multiserver-dht')
const explain = require('explain-error')
const level = require('level')
const sublevel = require('level-sublevel/bytewise')
const path = require('path')
const debug = require('debug')('ssb:dht-invite')

type Seed = string
type HostingInfo = {claimer: string; online: boolean}
type CB<T> = (err?: any, val?: T) => void

/**
 * The type of requests and responses exchanged during invite claiming.
 */
type Msg = {feed: string; seed: string}

type ParseInviteReturn = [Error] | [undefined, {seed: string; remoteId: string}]

function dhtClientConnected({type, address, key, details}: any) {
  if (type !== 'connected') return false
  if (!address.startsWith('dht:')) return false
  if (!key) return false
  if (!details || !details.rpc) return false
  if (details.rpc.meta !== 'dht') return false
  if (details.isClient /* == "they are not the client, WE are" */) return false
  return true
}

@plugin('1.0.0')
class dhtInvite {
  private readonly ssb: any
  private readonly config: any
  private readonly serverChannels: any
  private readonly serverCodesCache: Map<Seed, HostingInfo>
  private readonly serverCodesHosting: any
  private readonly clientCodesCache: Set<string>
  private readonly clientCodesClaiming: any
  private readonly onlineRemoteClients: Set<string>
  private initialized: boolean = false
  private serverCodesDB: any = null
  private clientCodesDB: any = null

  constructor(ssb: any, config: any) {
    this.ssb = ssb
    this.config = config
    this.serverChannels = Pushable()
    this.serverCodesCache = new Map<Seed, HostingInfo>()
    this.serverCodesHosting = Notify()
    this.clientCodesCache = new Set<string>()
    this.clientCodesClaiming = Notify()
    this.onlineRemoteClients = new Set<string>()
    this.initialized = false
    this.serverCodesDB = null
    this.clientCodesDB = null

    this.init()
  }

  private init() {
    if (!this.ssb.conn || !this.ssb.conn.connect || !this.ssb.conn.hub) {
      throw new Error('plugin ssb-dht-invite requires ssb-conn to be installed')
    }

    // Update record of online RPC clients using DHT transport.
    pull(
      this.ssb.conn.hub().listen(),
      pull.filter(dhtClientConnected),
      pull.drain(({key, details}: any) => {
        this.onlineRemoteClients.add(key)
        if (this.initialized) {
          this.updateServerCodesCacheOnlineStatus()
          this.emitServerCodesHosting()
        }

        details.rpc.on('closed', () => {
          this.onlineRemoteClients.delete(key)
          if (this.initialized) {
            this.updateServerCodesCacheOnlineStatus()
            this.emitServerCodesHosting()
          }
        })
      })
    )

    this.ssb.multiserver.transport({
      name: 'dht',
      create: (dhtConfig: any) =>
        DHT({keys: this.serverChannels, port: dhtConfig.port}),
    })
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
      Array.from(this.serverCodesCache.entries()).map(
        ([seed, {claimer, online}]) => ({seed, claimer, online})
      )
    )
  }

  private emitServerChannels(map: Map<Seed, any>) {
    this.serverChannels.push(
      Array.from(map.entries()).map(([seed]) => seed + ':' + this.ssb.id)
    )
  }

  private async getSublevel(name: string) {
    // 1st attempt: use sublevel() provided by ssb-server, if exists
    if (this.ssb.sublevel) return this.ssb.sublevel(name)

    // 2nd attempt: create a sublevel db dependent on a root db
    const opts = {valueEncoding: 'json'}
    const rootPath = path.join(this.config.path, 'db')
    const [err, rootDb] = await run(level)(rootPath, opts)
    if (!err && rootDb) return sublevel(rootDb).sublevel(name)

    // 3rd attempt: create an independent level db
    const targetPath = path.join(this.config.path, name)
    const [err2, targetDb] = await run(level)(targetPath, opts)
    if (!err2 && targetDb) return targetDb

    // Quit:
    throw err2
  }

  private async setupServerCodesDB() {
    this.serverCodesDB = await this.getSublevel('dhtServerCodes')
    this.serverCodesDB.get = this.serverCodesDB.get.bind(this.serverCodesDB)
    this.serverCodesDB.put = this.serverCodesDB.put.bind(this.serverCodesDB)
    this.serverCodesDB.del = this.serverCodesDB.del.bind(this.serverCodesDB)
    this.serverCodesDB
      .createReadStream()
      .on('data', (data: {key: string; value: string}) => {
        const seed = data.key
        const claimer = data.value
        debug('server channels: emit %s', seed + ':' + this.ssb.id)
        this.serverCodesCache.set(seed, {claimer, online: false})
        this.emitServerChannels(this.serverCodesCache)
        this.emitServerCodesHosting()
        this.updateServerCodesCacheOnlineStatus()
      })
  }

  private async setupClientCodesDB() {
    this.clientCodesDB = await this.getSublevel('dhtClientCodes')
    this.clientCodesDB.get = this.clientCodesDB.get.bind(this.clientCodesDB)
    this.clientCodesDB.put = this.clientCodesDB.put.bind(this.clientCodesDB)
    this.clientCodesDB.del = this.clientCodesDB.del.bind(this.clientCodesDB)
    this.clientCodesDB
      .createReadStream({keys: true, values: false})
      .on('data', (invite: string) => {
        this.accept(invite, () => {})
      })
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
    return [undefined, {seed, remoteId}]
  }

  @muxrpc('async', {master: 'allow'})
  public start = (cb: CB<true>) => {
    if (this.clientCodesDB && this.serverCodesDB) return cb(null, true)

    debug('start()')
    this.setupServerCodesDB()
    this.setupClientCodesDB()
    this.initialized = true
    cb(null, true)
  }

  @muxrpc('async', {master: 'allow'})
  public create = async (cb: CB<string>) => {
    if (!this.serverCodesDB) {
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
    if (!this.serverCodesDB) {
      return cb(
        new Error('Cannot call dhtInvite.use() before dhtInvite.start()')
      )
    }

    const seed = req.seed
    const friendId = req.feed
    debug('use() called with request %o', req)
    const [err, claimer] = await run<string>(this.serverCodesDB.get)(seed)
    if (err)
      return cb(explain(err, 'Cannot `use` an invite that does not exist'))
    if (claimer !== 'unclaimed') {
      return cb(new Error('Cannot `use` an already claimed invite'))
    }

    debug('use() will claim invite')
    const [err2] = await run(this.serverCodesDB.put)(seed, friendId)
    if (err2) return cb(err2)
    this.serverCodesCache.set(seed, {claimer: friendId, online: true})
    this.emitServerCodesHosting()

    debug('use() will follow remote friend')
    const [err3] = await run(this.ssb.publish)({
      type: 'contact',
      contact: friendId,
      following: true,
    })
    if (err3) return cb(err3)

    const res: Msg = {seed: seed, feed: this.ssb.id}
    debug('use() will respond with %o', res)
    cb(null, res)
  }

  @muxrpc('async', {master: 'allow'})
  public accept = async (invite: string, cb: CB<true>) => {
    if (!this.clientCodesDB) {
      return cb(
        new Error('Cannot call dhtInvite.accept() before dhtInvite.start()')
      )
    }
    const [err] = await run(this.clientCodesDB.put)(invite, true)
    if (err) return cb(explain(err, 'Could not save to-claim invite locally'))
    this.clientCodesCache.add(invite)
    this.clientCodesClaiming(Array.from(this.clientCodesCache.values()))

    const [err2, parsed] = this.parseInvite(invite)
    if (err2) return cb(err2)
    const {seed, remoteId} = parsed!
    const pubkey = remoteId.replace(/^\@/, '').replace(/\.ed25519$/, '')
    const transform = `shs:${pubkey}`
    const addr = invite + '~' + transform

    debug('accept() will ssb.conn.connect to remote peer addr: %s', addr)
    const [e3, rpc] = await run<any>(this.ssb.conn.connect)(addr, {type: 'dht'})
    if (e3) return cb(explain(e3, 'Could not connect to DHT server'))
    debug('accept() connected to remote DHT peer')

    const req: Msg = {seed: seed, feed: this.ssb.id}
    debug("accept() will call remote's use(%o)", req)
    const [err4, res] = await run<Msg>(rpc.dhtInvite.use)(req)
    if (err4)
      return cb(explain(err4, 'Could not tell friend to use DHT invite'))

    const [err5] = await run(this.clientCodesDB.del)(invite)
    if (err5) return cb(explain(err5, 'Could not delete to-claim invite'))
    this.clientCodesCache.delete(invite)
    this.clientCodesClaiming(Array.from(this.clientCodesCache.values()))

    await sleep(100)

    const friendId = res.feed
    debug('accept() will follow friend %s', friendId)
    const [err6] = await run(this.ssb.publish)({
      type: 'contact',
      contact: friendId,
      following: true,
    })
    if (err6) return cb(explain(err6, 'Unable to follow friend behind invite'))

    debug('accept() will remember the address %s in ConnDB', addr)
    this.ssb.conn.remember(addr, {type: 'dht'})

    cb(null, true)
  }

  @muxrpc('async', {master: 'allow'})
  public remove = async (invite: string, cb: CB<true>) => {
    if (!this.clientCodesDB || !this.serverCodesDB) {
      return cb(
        new Error('Cannot call dhtInvite.remove() before dhtInvite.start()')
      )
    }

    if (this.clientCodesCache.has(invite)) {
      const [err] = await run(this.clientCodesDB.del)(invite)
      if (err) return cb(explain(err, 'Could not delete client invite code'))
      this.clientCodesCache.delete(invite)
      this.clientCodesClaiming(Array.from(this.clientCodesCache.values()))
    } else if (this.serverCodesCache.has(invite)) {
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

  @muxrpc('source', {master: 'allow'})
  public claimingInvites = () => this.clientCodesClaiming.listen()
}

module.exports = dhtInvite
