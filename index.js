var crypto = require('crypto')
var Pushable = require('pull-pushable')
var explain = require('explain-error')

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
        var seed = req.seed
        var friendId = req.feed
        console.error('dhtinvite.use called with arg ' + JSON.stringify(req))
        codesDB.get(seed, function(err, info) {
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
          console.error('dhtinvite.use will claim invite')
          codesDB.put(seed, friendId, function(err) {
            //#region preconditions
            if (err) return cb(err)
            //#endregion
            console.error(
              'dhtinvite.use claimed invite and will follow remote friend'
            )
            var res = {seed: seed, feed: sbot.id}
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
        var seed, remoteId
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
        seed = parts[1]
        if (seed.length === 0) {
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
        var transform = 'shs:' + remoteId
        var addr = invite + '~' + transform
        console.error('dhtinvite.accept calculated remote addr: ' + addr)
        console.error('  will get RPC connection')
        var beenHere = false
        sbot.connect(
          addr,
          function(err, rpc) {
            //#region preconditions
            if (beenHere) return
            else beenHere = true
            if (err) return cb(explain(err, 'Could not connect to DHT server'))
            //#endregion
            console.error('  got RPC connection')
            var req = {seed: seed, feed: sbot.id}
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
              // rpc.close() // instead of closing, will recycle the connection
              var friendId = res.feed
              console.error('dhtinvite.accept will follow friend ' + friendId)
              setTimeout(() => {
                sbot.publish(
                  {
                    type: 'contact',
                    contact: friendId,
                    following: true,
                  },
                  () => {
                    console.error(
                      'dhtinvite.accept will add to gossip: ' + addr
                    )
                    sbot.gossip.add(addr, 'dht')
                    cb(null, true)
                  }
                )
              }, 100)
            })
          }
        )
      },
    }
  },
}
