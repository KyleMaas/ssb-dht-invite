var crypto = require('crypto')
var Pushable = require('pull-pushable')
var explain = require('explain-error')
var MultiServer = require('multiserver')
var makeDHTTransport = require('multiserver-dht')
var makeNoauthTransform = require('multiserver/plugins/noauth')
var muxrpc = require('muxrpc')
var pull = require('pull-stream')

function toSodiumKeys(keys) {
  if (!keys || !keys.public) return null
  return {
    publicKey: new Buffer(keys.public.replace('.ed25519', ''), 'base64'),
    secretKey: new Buffer(keys.private.replace('.ed25519', ''), 'base64'),
  }
}

function dhtClient(opts, cb) {
  var dht = makeDHTTransport({})
  var noauth = makeNoauthTransform({
    keys: {
      publicKey: Buffer.from(opts.keys.public, 'base64'),
    },
  })
  var ms = MultiServer([[dht, noauth]])

  ms.client(opts.addr, function(err, stream) {
    if (err) return cb(explain(err, 'could not connect to sbot over DHT'))
    var sbot = muxrpc(opts.manifest, false)()
    sbot.id = '@' + stream.remote.toString('base64') + '.ed25519'
    // // fix blobs.add. (see ./blobs.js)
    // if (sbot.blobs && sbot.blobs.add)
    //   sbot.blobs.add = fixBlobsAdd(sbot.blobs.add)
    pull(stream, sbot.createStream(), stream)
    cb(null, sbot)
  })
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
    master: {allow: ['create']},
  },
  init: function(sbot, config) {
    var channelsSource = Pushable()
    var codesDB = null
    return {
      start: function() {
        if (codesDB) return
        console.error('dhtinvite.start')
        codesDB = sbot.sublevel('dhtcodes')
        codesDB
          .createReadStream({keys: true, values: false})
          .on('data', function(seed) {
            var channel = seed + ':' + sbot.id
            console.error('dhtinvite.channels emit ' + channel)
            channelsSource.push(channel)
          })
      },

      create: function(cb) {
        //#region preconditions
        if (!codesDB) {
          return cb(
            new Error('Cannot call dhtInvite.create() before dhtInvite.start()')
          )
        }
        //#endregion
        var seed = crypto.randomBytes(32).toString('base64')
        var info = 'unclaimed'
        codesDB.put(seed, info, function(err) {
          //#region preconditions
          if (err) return cb(err)
          //#endregion
          var channel = seed + ':' + sbot.id
          cb(null, 'dht:' + channel)
          channelsSource.push(channel)
        })
      },

      use: function(req, cb) {
        //#region preconditions
        if (!codesDB) {
          return cb(
            new Error('Cannot call dhtInvite.use() before dhtInvite.start()')
          )
        }
        //#endregion
        var seed1 = req.seed
        var friendId = req.feed
        console.error('dhtinvite.use called with arg ' + JSON.stringify(req))
        codesDB.get(seed1, function(err, info) {
          //#region preconditions
          if (err) {
            return cb(
              explain(err, 'Cannot `use` an invite that does not exist')
            )
          }
          if (info !== 'unclaimed') {
            return cb(new Error('Cannot `use` an already claimed invite'))
          }
          //#endregion
          console.error('dhtinvite.use invite state is ' + info)
          console.error(
            'dhtinvite.use will delete claimed invite and create full friendship invite'
          )
          var seed2 = crypto.randomBytes(32).toString('base64')
          var operations = [
            {type: 'del', key: seed1},
            {type: 'put', key: seed2, value: friendId},
          ]
          codesDB.batch(operations, function(err) {
            //#region preconditions
            if (err) return cb(err)
            //#endregion
            var channel = seed2 + ':' + sbot.id
            channelsSource.push(channel)
            console.error(
              'dhtinvite.use claimed invite and will follow remote friend'
            )
            var res = {seed: seed2, feed: sbot.id}
            console.error('dhtinvite.use will return ' + JSON.stringify(res))
            sbot.publish(
              {type: 'contact', contact: friendId, following: true},
              err => cb(err, res)
            )
          })
        })
      },

      channels: function() {
        return channelsSource
      },

      accept: function(invite, cb) {
        var seed1, remoteId
        //#region parse the invite
        if (typeof invite !== 'string' || invite.length === 0) {
          return cb(new Error('Cannot `accept` the DHT invite, it is missing'))
        }
        var parts = invite.split(':')
        if (parts.length !== 3) {
          return cb(
            new Error(
              'Cannot `accept` the DHT invite, it is missing some parts'
            )
          )
        }
        if (parts[0] !== 'dht') {
          return cb(
            new Error(
              'Cannot `accept` the DHT invite, it should start with "dht"'
            )
          )
        }
        seed1 = parts[1]
        if (seed1.length === 0) {
          return cb(
            new Error(
              'Cannot `accept` the DHT invite, the seed part is missing'
            )
          )
        }
        remoteId = parts[2]
        if (remoteId.length === 0) {
          return cb(
            new Error(
              'Cannot `accept` the DHT invite, the feed id part is missing'
            )
          )
        }
        //#endregion
        var transform = 'noauth'
        var addr1 = invite + '~' + transform
        console.error('dhtinvite.accept calculated remote addr: ' + addr1)
        console.error('  will get RPC connection')
        dhtClient(
          {
            keys: sbot.keys,
            caps: config.caps,
            addr: addr1,
            manifest: {dhtInvite: {use: 'async'}, getAddress: 'async'},
          },
          function(err, rpc) {
            //#region preconditions
            if (err) return cb(explain(err, 'Could not connect to DHT server'))
            //#endregion
            console.log('  got RPC connection')
            var req = {seed: seed1, feed: sbot.id}
            console.error(
              'dhtinvite.accept will call remote dhtinvite.use: ' +
                JSON.stringify(req)
            )
            rpc.dhtInvite.use(req, function(err2, res) {
              //#region preconditions
              if (err2) {
                return cb(
                  explain(err2, 'Could not tell friend to use DHT invite')
                )
              }
              //#endregion
              rpc.close()
              var seed2 = res.seed
              var friendId = res.feed
              var addr2 = 'dht:' + seed2 + ':' + friendId + '~' + transform
              console.error('dhtinvite.accept will follow friend ' + friendId)
              sbot.publish(
                {
                  type: 'contact',
                  contact: friendId,
                  following: true,
                },
                () => {
                  console.error('dhtinvite.accept will add to gossip: ' + addr2)
                  sbot.gossip.add(addr2, 'dht')
                  cb(null, true)
                }
              )
            })
          }
        )
      },
    }
  },
}
