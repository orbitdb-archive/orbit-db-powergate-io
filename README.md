# PowergateIO (orbit-db-powergate-io)

> A bridge between [OrbitDB](https://github.com/orbitdb/orbit-db) and [Powergate](https://docs.textile.io/powergate/), which is itself a bridge between [Filecoin](https://filecoin.io) and [IPFS](https://ipfs.io/).

## Install

`npm install orbit-db-powergate-io`

### From Source

```bash
$ git clone https://github.com/orbitdb/orbit-db-powergate-io
$ cd orbit-db-powergate-io
$ npm install
```

## Usage

PowergateIO is designed to work with only one configuration option: the gRPC
endpoint of the Powergate node you want to connect to. Everything else should be handled
"under the hood" for you. See below.

### Initial Setup

```JavaScript
const PowergateIO = require('orbit-db-powergate-io')

const host = 'http://0.0.0.0:6002' // This is the default value
PowergateIO.create(host)
  .then((powergateio) => {
    console.log(powergateio.wallet) // Will be {} until funded
  })
```

### Backing up an OrbitDB Snapshot

PowergateIO is meant to be used from one IPFS node to another, and to replicate
OrbitDB databases between them. So, let's assume that we have an IPFS node and
OrbitDB running locally, and we're going to interact with a _remote_ Powergate
instance.

```JavaScript
const IPFS = require('ipfs')
const OrbitDB = require('orbit-db')
const PowergateIO = require('orbit-db-powergate-io')

;(async () => {
  const ipfs = await IPFS.create()
  const orbitdb = await OrbitDB.createInstance(ipfs)
  powergateio = await PowergateIO.create('https://my.hosted.powergate.node')

  const addresses = (await powergateio.ipfs.id()).addresses
  await ipfs.swarm.connect(addresses[0].toString())

  const db = await orbitdb.eventlog('powergate-test')
  for (let i = 0; i < 10; i++) {
    await db.add(`entry${i}`)
  }

  jobStatus = await powergateio.storeSnapshot(db.address.toString())
  console.log(jobStatus)

  // Wait until wallet is funded
  // Can take up to 2 minute on testnet
  console.log(powergateio.wallet)

  await powergateio.stop()
  await orbitdb.disconnect()
  await ipfs.stop()
})()
```

### Retrieving an OrbitDB Snapshot

Once you've stored a snapshot and have made note of the DB address returned,
you can use that db address to retrieve the snapshot!

```JavaScript
const IPFS = require('ipfs')
const OrbitDB = require('orbit-db')
const PowergateIO = require('orbit-db-powergate-io')

;(async () => {
  const ipfs = await IPFS.create()
  const orbitdb = await OrbitDB.createInstance(ipfs)
  const powergateio = await PowergateIO.create('https://my.hosted.powergate.node')

  const addresses = (await powergateio.ipfs.id()).addresses
  await ipfs.swarm.connect(addresses[0].toString())

  const dbAddr = '/orbitdb/zdpuAxkdoDum8Nk2VCxKkHZk8TzqAYPm86mVgoy7wagu2UcZB/powergate-test'
  const db2 = await orbitdb.open(dbAddr, { create: true })
  const snapshot = await powergateio.retrieveSnapshot(dbAddr)

  await db2._oplog.join(snapshots[0].log)
  await db2._updateIndex()
})()
```

For more information, see the [API docs](https://orbitdb.github.io/orbit-db-powergate-io/PowergateIO.html).

## Contributing

Issues and pull requests accepted. Please note that several issues have "[Help Wanted]"
and "[Good First Issue]" tags!

[Good First Issue]: (https://github.com/orbitdb/orbit-db-powergate-io/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
[Help Wanted]: (https://github.com/orbitdb/orbit-db-powergate-io/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22)

### Developing Locally

It's highly recommended to install both Docker and Docker compose. From there, `make` is your
best friends. It gives you the following commands:

- `make up` - Spins up all the necessary docker images for local development
- `make lint` - Lints your JS code vi standard.js
- `make docs` - Compiles the README and JS docstrings into the docs/ folder
- `make down` - Spins down all the docker images
- `make clean` - Removes ephemeral files and folders like node_modules and package-lock.json
- `make test` - Does a whole bunch of the above, in order. *use it!*
- `make rebuild` - runs `make clean` and `make deps` to give you a clean slate.

## License

MIT © OrbitDB Community
