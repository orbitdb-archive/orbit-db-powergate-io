const assert = require('assert')
const PowergateIO = require('../src')
const OrbitDB = require('orbit-db')
const { JobStatus } = require('@textile/grpc-powergate-client/dist/ffs/rpc/rpc_pb')
const rm = require('rimraf')

const {
  config,
  startIpfs,
  stopIpfs,
  testAPIs
} = require('orbit-db-test-utils')

const POWERGATE_HREF = process.env.POWERGATE_HREF || 'http://0.0.0.0:6002'
const IS_REMOTE = (POWERGATE_HREF !== 'http://0.0.0.0:6002')

Object.keys(testAPIs).forEach(API => {
  describe(`PowergateIO - default options (${API})`, function () {
    let ipfsd, orbitdb, powergateio

    const timeout = IS_REMOTE ? 120000 : 10000
    this.timeout(timeout)

    before(async () => {
      rm('./orbitdb', () => {})

      // TODO: Whittle away at these and figure out what's what
      config.daemon1.config.Addresses.Swarm = [
        '/ip4/0.0.0.0/tcp/0'
        // "/ip6/::/tcp/0",
        // "/ip4/0.0.0.0/udp/0/quic",
        // "/ip6/::/udp/0/quic"
      ]
      config.daemon1.config.Addresses.Announce = []
      config.daemon1.config.Addresses.NoAnnounce = []
      config.daemon1.config.Discovery.MDNS.Interval = 10
      config.daemon1.config.AutoNAT = {}
      config.daemon1.config.Routing = { type: 'dht' }
      config.daemon1.config.Swarm = {}
      config.daemon1.config.Swarm.DisableNatPortMap = false

      ipfsd = await startIpfs(API, config.daemon1)
      // await ipfsd.api.bootstrap.add({ default: true })
      orbitdb = await OrbitDB.createInstance(ipfsd.api)
      powergateio = await PowergateIO.create(POWERGATE_HREF)

      // const { info } = await pow.ffs.info()
      // const { status, messagesList } = await pow.health.check()
    })

    after(async () => {
      await orbitdb.disconnect()
      await powergateio.stop()
      await stopIpfs(ipfsd)
    })

    it('successfully connects with the Powergate peer', async () => {
      const peerId = (await ipfsd.api.id()).id
      const addresses = (await ipfsd.api.id()).addresses
      await powergateio.ipfs.swarm.connect(addresses[addresses.length - 1])
      const peers = await powergateio.ipfs.swarm.peers()
      assert(peers.filter(p => p.peer === peerId).length > 0)
    })

    it('creates a jobs db', async () => {
      assert.strictEqual(powergateio.databases.jobs.dbname, 'jobs')
      assert.strictEqual(powergateio.databases.jobs.type, 'docstore')
    })

    describe('stores and retrieves a db snapshot - permissionless', function () {
      let db, db2, snapshots
      const logLength = 10
      let jobStatus

      before(async () => {
        db = await orbitdb.eventlog('powergate-test')
      })

      it(`makes a local eventlog with ${logLength} items`, async () => {
        for (let i = 0; i < logLength; i++) {
          await db.add(`entry${i}`)
        }

        // Loading here to make sure there aren't extra entries
        await db.load()

        assert.strictEqual(db.index.values.length, logLength)
      })

      it('stores a snapshot and creates an entry in the jobs db', async () => {
        jobStatus = await powergateio.storeSnapshot(db.address.toString())

        assert.strictEqual(jobStatus.dbAddress, db.address.toString())
        assert.strictEqual(jobStatus.status, JobStatus.JOB_STATUS_EXECUTING)
        assert.strictEqual(jobStatus.errCause, '')
        assert.strictEqual(jobStatus.dealErrorsList.length, 0)

        await db.drop()
      })

      it('retrieves a remote database snapshot from "hot" storage by CID', async () => {
        db2 = await orbitdb.open(db.address.toString(), { create: true })

        assert.strictEqual(db.address.toString(), db2.address.toString())

        // DB should be empty after load
        await db2.load()
        assert.strictEqual(db2._oplog.values.length, 0)

        snapshots = await powergateio.retrieveSnapshot(db2.address.toString())

        assert.strictEqual(snapshots.length, 1)
        assert.strictEqual(snapshots[0].job.dbAddress, db.address.toString())
        assert.strictEqual(snapshots[0].job.status, JobStatus.JOB_STATUS_EXECUTING)
        assert.strictEqual(snapshots[0].job.errCause, '')
        assert.strictEqual(snapshots[0].job.dealErrorsList.length, 0)

        assert.strictEqual(snapshots[0].log.length, logLength)
        assert.strictEqual(snapshots[0].log.id, db.address.toString())
      })

      it('loads the snapshot into a fully-functioning OrbitDB database', async () => {
        await db2._oplog.join(snapshots[0].log)
        await db2._updateIndex()

        for (const i in db2.index.values) {
          assert.strictEqual(db2.index.values[i].payload.value, `entry${i}`)
        }
      })

      after(async () => {
        await db.close()
        await db2.close()
      })
    })
  })
})
