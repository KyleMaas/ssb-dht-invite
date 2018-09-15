import sleep from 'delay'
import run = require('promisify-tuple')
const crypto = require('crypto')
const Pushable = require('pull-pushable')
const explain = require('explain-error')

function init(sbot: any, config: any) {
  const serverChannels = Pushable()
  let clientCodesDB: any = null
  let serverCodesDB: any = null

  function start() {
    if (clientCodesDB && serverCodesDB) return
    console.error('dhtinvite.start')

    serverCodesDB = sbot.sublevel('dhtServerCodes')
    serverCodesDB.get = serverCodesDB.get.bind(serverCodesDB)
    serverCodesDB.put = serverCodesDB.put.bind(serverCodesDB)
    serverCodesDB.del = serverCodesDB.del.bind(serverCodesDB)
    serverCodesDB
      .createReadStream({keys: true, values: false})
      .on('data', (seed: string) => {
        const channel = seed + ':' + sbot.id
        console.error('dhtinvite.channels emit ' + channel)
        serverChannels.push(channel)
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
  }

  type Msg = {
    feed: string
    seed: string
  }

  async function use(req: Msg, cb: (err: any, res?: Msg) => void) {
    if (!serverCodesDB) {
      return cb(
        new Error('Cannot call dhtInvite.use() before dhtInvite.start()')
      )
    }

    const seed = req.seed
    const friendId = req.feed
    console.error('dhtinvite.use called with arg ' + JSON.stringify(req))
    const [err, info] = await run<string>(serverCodesDB.get)(seed)
    if (err)
      return cb(explain(err, 'Cannot `use` an invite that does not exist'))
    if (info !== 'unclaimed') {
      return cb(new Error('Cannot `use` an already claimed invite'))
    }

    console.error('dhtinvite.use will claim invite')
    const [err2] = await run(serverCodesDB.put)(seed, friendId)
    if (err2) return cb(err2)
    console.error('dhtinvite.use claimed invite and will follow remote friend')

    const res: Msg = {seed: seed, feed: sbot.id}
    console.error('dhtinvite.use will return ' + JSON.stringify(res))
    const [err3] = await run(sbot.publish)({
      type: 'contact',
      contact: friendId,
      following: true,
    })
    cb(err3, res)
  }

  type ParseInviteReturn = [any] | [undefined, {seed: string; remoteId: string}]

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

    const [err2, {seed, remoteId}] = parseInvite(invite)
    if (err2) return cb(err2)
    const transform = 'shs:' + remoteId
    const addr = invite + '~' + transform

    console.error('dhtinvite.accept calculated remote addr: ' + addr)
    console.error('  will get RPC connection')
    const [err3, rpc] = await run<any>(sbot.connect)(addr)
    if (err3) return cb(explain(err3, 'Could not connect to DHT server'))
    console.error('  got RPC connection')

    const req: Msg = {seed: seed, feed: sbot.id}
    console.error(
      'dhtinvite.accept will call remote dhtinvite.use: ' + JSON.stringify(req)
    )
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

    await sleep(100)

    const friendId = res.feed
    console.error('dhtinvite.accept will follow friend ' + friendId)
    const [err6] = await run(sbot.publish)({
      type: 'contact',
      contact: friendId,
      following: true,
    })
    if (err6) return cb(explain(err6, 'Unable to follow friend behind invite'))

    console.error('dhtinvite.accept will add to gossip: ' + addr)
    sbot.gossip.add(addr, 'dht')

    cb(null, true)
  }

  return {
    start: start,
    create: create,
    use: use,
    channels: () => serverChannels,
    accept: accept,
  }
}

module.exports = {
  name: 'dhtInvite',
  version: '1.0.0',
  manifest: {
    start: 'async',
    create: 'async',
    use: 'async',
    channels: 'source',
    accept: 'async',
  },
  permissions: {
    master: {allow: ['create', 'start', 'channels', 'accept']},
    anonymous: {allow: ['use']},
  },
  init: init,
}
