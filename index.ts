import sleep from 'delay'
import run = require('promisify-tuple')
const crypto = require('crypto')
const Pushable = require('pull-pushable')
const Notify = require('pull-notify')
const explain = require('explain-error')
const debug = require('debug')('ssb:dht-invite')
const pRetry = require('p-retry')

type Seed = string
type HostingInfo = {claimer: string; online: boolean}

function init(sbot: any, config: any) {
  let initialized: boolean = false
  let serverCodesDB: any = null
  let clientCodesDB: any = null
  const serverChannels = Pushable()
  const serverCodesCache = new Map<Seed, HostingInfo>()
  const serverCodesHosting = Notify()
  const clientCodesCache = new Set<string>()
  const clientCodesClaiming = Notify()
  const onlineRemoteClients = new Set<string>()

  /**
   * Update record of online RPC clients using DHT transport.
   */
  sbot.on('rpc:connect', (rpc: any, isClient: boolean) => {
    if (rpc.meta !== 'dht' || isClient) return

    onlineRemoteClients.add(rpc.id)
    if (initialized) {
      updateServerCodesCacheOnlineStatus()
      emitServerCodesHosting()
    }

    rpc.on('closed', () => {
      onlineRemoteClients.delete(rpc.id)
      if (initialized) {
        updateServerCodesCacheOnlineStatus()
        emitServerCodesHosting()
      }
    })
  })

  /**
   * Update the online status of the server codes cache.
   */
  function updateServerCodesCacheOnlineStatus() {
    serverCodesCache.forEach((hInfo: HostingInfo, seed: Seed) => {
      const claimer = hInfo.claimer
      if (claimer === 'unclaimed') return
      const online = onlineRemoteClients.has(claimer)
      if (hInfo.online !== online) {
        serverCodesCache.set(seed, {claimer, online})
      }
    })
  }

  /**
   * Emit an Array<{seed, claimer, online}> on the hostingInvites
   * notifier stream.
   */
  function emitServerCodesHosting() {
    serverCodesHosting(
      Array.from(serverCodesCache.entries()).map(
        ([seed, {claimer, online}]) => ({
          seed,
          claimer,
          online,
        })
      )
    )
  }

  function emitServerChannels(map: Map<Seed, any>) {
    serverChannels.push(
      Array.from(map.entries()).map(([seed]) => seed + ':' + sbot.id)
    )
  }

  function start() {
    if (clientCodesDB && serverCodesDB) return
    debug('start()')

    serverCodesDB = sbot.sublevel('dhtServerCodes')
    serverCodesDB.get = serverCodesDB.get.bind(serverCodesDB)
    serverCodesDB.put = serverCodesDB.put.bind(serverCodesDB)
    serverCodesDB.del = serverCodesDB.del.bind(serverCodesDB)
    serverCodesDB
      .createReadStream()
      .on('data', (data: {key: string; value: string}) => {
        const seed = data.key
        const claimer = data.value
        debug('server channels: emit %s', seed + ':' + sbot.id)
        serverCodesCache.set(seed, {claimer, online: false})
        emitServerChannels(serverCodesCache)
        emitServerCodesHosting()
        updateServerCodesCacheOnlineStatus()
      })

    clientCodesDB = sbot.sublevel('dhtClientCodes')
    clientCodesDB.get = clientCodesDB.get.bind(clientCodesDB)
    clientCodesDB.put = clientCodesDB.put.bind(clientCodesDB)
    clientCodesDB.del = clientCodesDB.del.bind(clientCodesDB)
    clientCodesDB
      .createReadStream({keys: true, values: false})
      .on('data', (seed: string) => {
        accept(seed, () => {})
      })

    initialized = true
  }

  async function create(cb: (err: any, inviteCode?: string) => void) {
    if (!serverCodesDB) {
      return cb(
        new Error('Cannot call dhtInvite.create() before dhtInvite.start()')
      )
    }
    const seed = crypto.randomBytes(32).toString('base64')
    const claimer = 'unclaimed'
    const [err] = await run(serverCodesDB.put)(seed, claimer)
    if (err) return cb(err)
    serverCodesCache.set(seed, {claimer, online: false})
    emitServerChannels(serverCodesCache)
    emitServerCodesHosting()
    cb(null, 'dht:' + seed + ':' + sbot.id)
  }

  /**
   * The type of requests and responses exchanged during invite claiming.
   */
  type Msg = {feed: string; seed: string}

  async function use(req: Msg, cb: (err: any, res?: Msg) => void) {
    if (!serverCodesDB) {
      return cb(
        new Error('Cannot call dhtInvite.use() before dhtInvite.start()')
      )
    }

    const seed = req.seed
    const friendId = req.feed
    debug('use() called with request %o', req)
    const [err, claimer] = await run<string>(serverCodesDB.get)(seed)
    if (err)
      return cb(explain(err, 'Cannot `use` an invite that does not exist'))
    if (claimer !== 'unclaimed') {
      return cb(new Error('Cannot `use` an already claimed invite'))
    }

    debug('use() will claim invite')
    const [err2] = await run(serverCodesDB.put)(seed, friendId)
    if (err2) return cb(err2)
    serverCodesCache.set(seed, {claimer: friendId, online: true})
    emitServerCodesHosting()

    debug('use() will follow remote friend')
    const [err3] = await run(sbot.publish)({
      type: 'contact',
      contact: friendId,
      following: true,
    })
    if (err3) return cb(err3)

    const res: Msg = {seed: seed, feed: sbot.id}
    debug('use() will respond with %o', res)
    cb(null, res)
  }

  type ParseInviteReturn = [any] | [undefined, {seed: string; remoteId: string}]

  /**
   * Given an invite code as a string, return the seed and remoteId.
   */
  function parseInvite(invite: string): ParseInviteReturn {
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

  async function accept(invite: string, cb: (err: any, done?: true) => void) {
    if (!clientCodesDB) {
      return cb(
        new Error('Cannot call dhtInvite.accept() before dhtInvite.start()')
      )
    }
    var [err] = await run(clientCodesDB.put)(invite, true)
    if (err) return cb(explain(err, 'Could not save to-claim invite locally'))
    clientCodesCache.add(invite)
    clientCodesClaiming(Array.from(clientCodesCache.values()))

    var [err, parsed] = parseInvite(invite)
    if (err) return cb(err)
    const {seed, remoteId} = parsed
    const transform = 'shs:' + remoteId
    const addr = invite + '~' + transform

    debug('accept() will sbot.connect to remote peer addr: %s', addr)
    const connect = () => run<any>(sbot.connect)(addr)
    var [err, rpc] = await pRetry(connect, {
      retries: 9999,
      factor: 2,
      minTimeout: 2000,
      maxTimeout: Infinity,
    })
    if (err) return cb(explain(err, 'Could not connect to DHT server'))
    debug('accept() connected to remote sbot')

    const req: Msg = {seed: seed, feed: sbot.id}
    debug("accept() will call remote's use(%o)", req)
    var [err, res] = await run<Msg>(rpc.dhtInvite.use)(req)
    if (err) return cb(explain(err, 'Could not tell friend to use DHT invite'))
    /**
     * Typically, we should close the RPC connection, but in the case of
     * DHT connections, it might take a lot more time for client and server
     * to rediscover each other. So instead of closing, we will recycle the
     * connection:
     */
    // rpc.close()

    var [err] = await run(clientCodesDB.del)(invite)
    if (err) return cb(explain(err, 'Could not delete to-claim invite'))
    clientCodesCache.delete(invite)
    clientCodesClaiming(Array.from(clientCodesCache.values()))

    await sleep(100)

    const friendId = res.feed
    debug('accept() will follow friend %s', friendId)
    var [err] = await run(sbot.publish)({
      type: 'contact',
      contact: friendId,
      following: true,
    })
    if (err) return cb(explain(err, 'Unable to follow friend behind invite'))

    debug('accept() will add address to gossip %s', addr)
    sbot.gossip.add(addr, 'dht')

    cb(null, true)
  }

  async function remove(invite: string, cb: (err: any, done?: true) => void) {
    if (!clientCodesDB || !serverCodesDB) {
      return cb(
        new Error('Cannot call dhtInvite.remove() before dhtInvite.start()')
      )
    }

    if (clientCodesCache.has(invite)) {
      const [err] = await run(clientCodesDB.del)(invite)
      if (err) return cb(explain(err, 'Could not delete client invite code'))
      clientCodesCache.delete(invite)
      clientCodesClaiming(Array.from(clientCodesCache.values()))
    } else if (serverCodesCache.has(invite)) {
      const [err] = await run(serverCodesDB.del)(invite)
      if (err) return cb(explain(err, 'Could not delete server invite code'))
      serverCodesCache.delete(invite)
      emitServerChannels(serverCodesCache)
      emitServerCodesHosting()
    }
    cb(null, true)
  }

  return {
    start: start,
    create: create,
    use: use,
    accept: accept,
    remove: remove,
    channels: () => serverChannels,
    hostingInvites: () => serverCodesHosting.listen(),
    claimingInvites: () => clientCodesClaiming.listen(),
  }
}

module.exports = {
  name: 'dhtInvite',
  version: '1.0.0',
  manifest: {
    start: 'async',
    create: 'async',
    use: 'async',
    accept: 'async',
    remove: 'async',
    channels: 'source',
    hostingInvites: 'source',
    claimingInvites: 'source',
  },
  permissions: {
    master: {
      allow: [
        'create',
        'start',
        'channels',
        'accept',
        'remove',
        'hostingInvites',
        'claimingInvites',
      ],
    },
    anonymous: {allow: ['use']},
  },
  init: init,
}
