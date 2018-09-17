# ssb-dht-invite

_A scuttlebot plugin that shares connection invites via a Distributed Hash Table_. Like the standard `invite` plugin, but over a DHT.

```
npm install --save ssb-dht-invite
```

## Usage

As client:

```diff
 const createSbot = require('scuttlebot/index')
   .use(require('scuttlebot/plugins/plugins'))
   .use(require('scuttlebot/plugins/master'))
   .use(require('scuttlebot/plugins/gossip'))
   .use(require('scuttlebot/plugins/replicate'))
   .use(require('ssb-friends'))
   .use(require('ssb-blobs'))
   .use(require('ssb-private'))
   .use(require('ssb-about'))
   .use(require('ssb-contacts'))
   .use(require('ssb-query'))
+  .use(require('ssb-dht-invite'))
   .use(require('scuttlebot/plugins/invite'))
   .use(require('scuttlebot/plugins/block'))
   .use(require('scuttlebot/plugins/local'))
```

## Plugin API

### `start()` (async)

You must call this before using DHT invites in any way.

### `create()` (async)

Creates and returns a new invite code that can be used **once** with another friend.

### `accept(code)` (async)

Pass an invite code to this API and wait for your sbot to connect with the remote friend.

### `pendingInvites()` (source)

Pull stream that delivers arrays of invite codes (strings) that are still pending to be accepted by the invitation creator.

## (Internal API)

### `use({seed, feed})` (async)

*Used internally by this plugin to exchange the invite code over RPC*. Don't bother about this.

### `channels()` (source)

*Used internally by this plugin, represents all DHT channels where the local sbot will create servers*. Don't bother about this.
