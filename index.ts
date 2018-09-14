const crypto = require('crypto')
const Pushable = require('pull-pushable')
const explain = require('explain-error')

function start() {
  //#region preconditions
  if (this.clientCodesDB && this.serverCodesDB) return
  console.error('dhtinvite.start')
  //#endregion
  this.serverCodesDB = this.sbot.sublevel('dhtServerCodes')
  this.serverCodesDB
    .createReadStream({keys: true, values: false})
    .on('data', (seed: string) => {
      const channel = seed + ':' + this.sbot.id
      console.error('dhtinvite.channels emit ' + channel)
      this.serverChannels.push(channel)
    })

  this.clientCodesDB = this.sbot.sublevel('dhtClientCodes')
  this.clientCodesDB
    .createReadStream({keys: true, values: false})
    .on('data', (seed: string) => {
      this.accept(seed, () => {})
    })
}

function create(cb: (err: any, inviteCode?: string) => void) {
  //#region preconditions
  if (!this.serverCodesDB) {
    return cb(
      new Error('Cannot call dhtInvite.create() before dhtInvite.start()')
    )
  }
  //#endregion
  const seed = crypto.randomBytes(32).toString('base64')
  const info = 'unclaimed'
  this.serverCodesDB.put(seed, info, (err: any) => {
    //#region preconditions
    if (err) return cb(err)
    //#endregion
    const channel = seed + ':' + this.sbot.id
    cb(null, 'dht:' + channel)
    this.serverChannels.push(channel)
  })
}

type Msg = {
  feed: string
  seed: string
}

function use(req: Msg, cb: (err: any, res?: Msg) => void) {
  //#region preconditions
  if (!this.serverCodesDB) {
    return cb(new Error('Cannot call dhtInvite.use() before dhtInvite.start()'))
  }
  //#endregion
  const seed = req.seed
  const friendId = req.feed
  console.error('dhtinvite.use called with arg ' + JSON.stringify(req))
  this.serverCodesDB.get(seed, (err: any, info: string) => {
    //#region preconditions
    if (err) {
      return cb(explain(err, 'Cannot `use` an invite that does not exist'))
    }
    if (info !== 'unclaimed') {
      return cb(new Error('Cannot `use` an already claimed invite'))
    }
    //#endregion
    console.error('dhtinvite.use will claim invite')
    this.serverCodesDB.put(seed, friendId, (err: any) => {
      //#region preconditions
      if (err) return cb(err)
      //#endregion
      console.error(
        'dhtinvite.use claimed invite and will follow remote friend'
      )
      const res: Msg = {seed: seed, feed: this.sbot.id}
      console.error('dhtinvite.use will return ' + JSON.stringify(res))
      this.sbot.publish(
        {type: 'contact', contact: friendId, following: true},
        (err: any) => cb(err, res)
      )
    })
  })
}

function accept(invite: string, cb: (err: any, done?: true) => void) {
  //#region preconditions
  if (!this.clientCodesDB) {
    return cb(
      new Error('Cannot call dhtInvite.accept() before dhtInvite.start()')
    )
  }
  //#endregion
  this.clientCodesDB.put(invite, true, (err: any) => {
    if (err) return cb(explain(err, 'Could not save to-claim invite locally'))
  })
  let seed: string, remoteId: string
  //#region parse the invite
  if (typeof invite !== 'string' || invite.length === 0) {
    return cb(new Error('Cannot `accept` the DHT invite, it is missing'))
  }
  const parts = invite.split(':')
  if (parts.length !== 3) {
    return cb(
      new Error('Cannot `accept` the DHT invite, it is missing some parts')
    )
  }
  if (parts[0] !== 'dht') {
    return cb(
      new Error('Cannot `accept` the DHT invite, it should start with "dht"')
    )
  }
  seed = parts[1]
  if (seed.length === 0) {
    return cb(
      new Error('Cannot `accept` the DHT invite, the seed part is missing')
    )
  }
  remoteId = parts[2]
  if (remoteId.length === 0) {
    return cb(
      new Error('Cannot `accept` the DHT invite, the feed id part is missing')
    )
  }
  //#endregion
  const transform = 'shs:' + remoteId
  const addr = invite + '~' + transform
  console.error('dhtinvite.accept calculated remote addr: ' + addr)
  console.error('  will get RPC connection')
  let beenHere = false
  this.sbot.connect(
    addr,
    (err: any, rpc: any) => {
      //#region preconditions
      if (beenHere) return
      else beenHere = true
      if (err) return cb(explain(err, 'Could not connect to DHT server'))
      //#endregion
      console.error('  got RPC connection')
      const req: Msg = {seed: seed, feed: this.sbot.id}
      console.error(
        'dhtinvite.accept will call remote dhtinvite.use: ' +
          JSON.stringify(req)
      )
      rpc.dhtInvite.use(req, (err2: any, res: Msg) => {
        //#region preconditions
        if (err2) {
          return cb(explain(err2, 'Could not tell friend to use DHT invite'))
        }
        //#endregion
        this.clientCodesDB.del(invite, (err3: any) => {
          if (err3)
            return cb(explain(err3, 'Could not save delete to-claim invite'))
        })
        // rpc.close() // instead of closing, will recycle the connection
        const friendId = res.feed
        console.error('dhtinvite.accept will follow friend ' + friendId)
        setTimeout(() => {
          this.sbot.publish(
            {
              type: 'contact',
              contact: friendId,
              following: true,
            },
            () => {
              console.error('dhtinvite.accept will add to gossip: ' + addr)
              this.sbot.gossip.add(addr, 'dht')
              cb(null, true)
            }
          )
        }, 100)
      })
    }
  )
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
  init: function(sbot: any, config: any) {
    const serverChannels = Pushable()

    return {
      sbot: sbot,
      serverChannels: serverChannels,
      clientCodesDB: null,
      serverCodesDB: null,

      start: start,
      create: create,
      use: use,
      channels: () => serverChannels,
      accept: accept,
    }
  },
}
