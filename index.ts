import sleep from 'delay'
import run = require('promisify-tuple')
const crypto = require('crypto')
const Pushable = require('pull-pushable')
const Notify = require('pull-notify')
const explain = require('explain-error')
const debug = require('debug')('ssb:dht-invite')

function init(sbot: any, config: any) {
  let serverCodesDB: any = null
  let clientCodesDB: any = null
  const serverChannels = Pushable()
  const serverCodesCache = new Map<string, string>()
  const serverCodesHosting = Notify()
  const clientCodesCache = new Set<string>()
  const clientCodesClaiming = Notify()

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
        const info = data.value
        const channel = seed + ':' + sbot.id
        debug('server channels: emit %s', channel)
        serverChannels.push(channel)
        serverCodesCache.set(seed, info)
        serverCodesHosting(Array.from(serverCodesCache.entries()))
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
  }

  async function create(cb: (err: any, inviteCode?: string) => void) {
    if (!serverCodesDB) {
      return cb(
        new Error('Cannot call dhtInvite.create() before dhtInvite.start()')
      )
    }
    const seed = crypto.randomBytes(32).toString('base64')
    const info = 'unclaimed'
    const [err] = await run(serverCodesDB.put)(seed, info)
    if (err) return cb(err)
    const channel = seed + ':' + sbot.id
    cb(null, 'dht:' + channel)
    serverChannels.push(channel)
    serverCodesCache.set(seed, info)
    serverCodesHosting(Array.from(serverCodesCache.entries()))
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
    const [err, info] = await run<string>(serverCodesDB.get)(seed)
    if (err)
      return cb(explain(err, 'Cannot `use` an invite that does not exist'))
    if (info !== 'unclaimed') {
      return cb(new Error('Cannot `use` an already claimed invite'))
    }

    debug('use() will claim invite')
    const [err2] = await run(serverCodesDB.put)(seed, friendId)
    if (err2) return cb(err2)
    serverCodesCache.set(seed, friendId)
    serverCodesHosting(Array.from(serverCodesCache.entries()))

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
    const [err] = await run(clientCodesDB.put)(invite, true)
    if (err) return cb(explain(err, 'Could not save to-claim invite locally'))
    clientCodesCache.add(invite)
    clientCodesClaiming(Array.from(clientCodesCache.values()))

    const [err2, {seed, remoteId}] = parseInvite(invite)
    if (err2) return cb(err2)
    const transform = 'shs:' + remoteId
    const addr = invite + '~' + transform

    debug('accept() will sbot.connect to remote peer addr: %s', addr)
    const [err3, rpc] = await run<any>(sbot.connect)(addr)
    if (err3) return cb(explain(err3, 'Could not connect to DHT server'))
    debug('accept() connected to remote sbot')

    const req: Msg = {seed: seed, feed: sbot.id}
    debug("accept() will call remote's use(%o)", req)
    const [err4, res] = await run<Msg>(rpc.dhtInvite.use)(req)
    if (err4)
      return cb(explain(err4, 'Could not tell friend to use DHT invite'))
    /**
     * Typically, we should close the RPC connection, but in the case of
     * DHT connections, it might take a lot more time for client and server
     * to rediscover each other. So instead of closing, we will recycle the
     * connection:
     */
    // rpc.close()

    const [err5] = await run(clientCodesDB.del)(invite)
    if (err5) return cb(explain(err5, 'Could not delete to-claim invite'))
    clientCodesCache.delete(invite)
    clientCodesClaiming(Array.from(clientCodesCache.values()))

    await sleep(100)

    const friendId = res.feed
    debug('accept() will follow friend %s', friendId)
    const [err6] = await run(sbot.publish)({
      type: 'contact',
      contact: friendId,
      following: true,
    })
    if (err6) return cb(explain(err6, 'Unable to follow friend behind invite'))

    debug('accept() will add address to gossip %s', addr)
    sbot.gossip.add(addr, 'dht')

    cb(null, true)
  }

  return {
    start: start,
    create: create,
    use: use,
    accept: accept,
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
        'hostingInvites',
        'claimingInvites',
      ],
    },
    anonymous: {allow: ['use']},
  },
  init: init,
}
