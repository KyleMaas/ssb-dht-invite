# ssb-dht-invite

_A scuttlebot plugin that shares connection invites via a Distributed Hash Table_. Like the standard `invite` plugin, but over a DHT.

```
npm install --save ssb-dht-invite @staltz/sbot-gossip multiserver-dht
```

Notice above that you should install these 3 dependencies:

- `ssb-dht-invite` (this plugin)
- `@staltz/sbot-gossip` (a fork of the Scuttlebot gossip plugin)
- `multiserver-dht` (required for this plugin to work)

## Usage

Replace the canonical gossip plugin, and `use` the multiserver DHT transport **before** calling `use` with `ssb-dht-invite`.

```diff
+var DHT = require('multiserver-dht')

+function dhtTransport(sbot) {
+  sbot.multiserver.transport({
+    name: 'dht',
+    create: dhtConfig => {
+      return DHT({
+        keys: sbot.dhtInvite.channels(),
+        port: dhtConfig.port,
+      })
+    },
+  })
+}

 const createSbot = require('scuttlebot/index')
   .use(require('scuttlebot/plugins/plugins'))
   .use(require('scuttlebot/plugins/master'))
-  .use(require('scuttlebot/plugins/gossip'))
+  .use(require('@staltz/sbot-gossip'))
   .use(require('scuttlebot/plugins/replicate'))
   .use(require('ssb-friends'))
   .use(require('ssb-blobs'))
   .use(require('ssb-private'))
   .use(require('ssb-about'))
   .use(require('ssb-contacts'))
   .use(require('ssb-query'))
+  .use(require('ssb-dht-invite')) // this one must come before dhtTransport
+  .use(dhtTransport)
   .use(require('scuttlebot/plugins/invite'))
   .use(require('scuttlebot/plugins/block'))
   .use(require('scuttlebot/plugins/local'))
```

**Important:** also setup the DHT transport in your ssb-config object:

```diff
 ...
 "connections": {
   "incoming": {
     "net": [{ "scope": "private, "transform": "shs", "port": 8008 }]
+    "dht": [{ "scope": "public", "transform": "shs", "port": 8423 }]
   },
   "outgoing": {
     "net": [{ "transform": "shs" }]
+    "dht": [{ "transform": "shs" }]
   }
 },
 ...
```

## Plugin API

### `start()` (async)

The start() API provides an explicit initialization procedure so that apps can decide what is the best time to initialize non-essential resources and plugins such as this one.

You must call this before using DHT invites in any way.

### `create()` (async)

Creates a new invite code and notifies the multiserver DHT transport to host a peer on the DHT addressed with this invite. One invite can only be use **once** with another friend.

Returns the invite code (as a callback) to the caller of this function.

An invite code looks like `dht:<seed>:<invite-creator-id>`

### `accept(code)` (async)

Pass an invite code to this API and wait for your sbot to connect with the remote friend.

### `hostingInvites()` (source)

Pull stream that delivers arrays of `[seed, feedOrUnclaimed]` DHT peers that are being hosted for remote friends.

Primarily purpose of this is for the frontend to know what's going on with the invite hosting.

### `claimingInvites()` (source)

Pull stream that delivers arrays of invite codes (strings) that are being claimed and still pending to be accepted by the invitation creator.

## (Internal API)

### `use({seed, feed})` (async)

*Used internally by this plugin to exchange the invite code over RPC*. Don't bother about this.

This API is called remotely by a trusted-or-untrusted peer who wants to "claim" an invite and make us follow them. The remote peer claims the invite by passing it ("seed") alongside the remote peer's id ("feed").

### `channels()` (source)

*Used internally by this plugin, represents all DHT channels where the local sbot will create servers*. Don't bother about this.
