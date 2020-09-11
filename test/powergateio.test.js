const assert = require('assert')
const PowergateIO = require('../src')
const OrbitDB = require('orbit-db')
const { createPow } = require('@textile/powergate-client')
const { JobStatus } = require ('@textile/grpc-powergate-client/dist/ffs/rpc/rpc_pb')
const { waitForBalance } = require('./utils')
const IpfsClient = require('ipfs-http-client')
const rm = require('rimraf')

const {
  config,
  connectPeers,
  startIpfs,
  stopIpfs,
  testAPIs,
  waitForPeers
} = require('orbit-db-test-utils')

const POWERGATE_HOSTNAME = process.env.POWERGATE_HOSTNAME || '0.0.0.0'
const POWERGATE_URL = `http://${POWERGATE_HOSTNAME}:6002`
const IPFS_HTTP_URL = process.env.IPFS_HTTP_URL || 'http://localhost:5001'

Object.keys(testAPIs).forEach(API => {
  describe("PowergateIO - default options", function () {
    let ipfsd, orbitdb, powergateio

    this.timeout(120000)

    before(async () => {
      rm('./orbitdb', () => {})

      ipfsd = await startIpfs('js-ipfs', config.daemon1)
      orbitdb = await OrbitDB.createInstance(ipfsd.api)
      powergateio = await PowergateIO.create()

      // const { info } = await pow.ffs.info()
      // const { status, messagesList } = await pow.health.check()
    })

    after(async () => {
      await orbitdb.disconnect()
      await powergateio.stop()
      await ipfsd.stop()
    })

    it('successfully connects with the Powergate peer', async () => {
      await connectPeers(ipfsd.api, powergateio._orbitdb._ipfs, {
        // Remove any 'quic' addresses from the available options
        filter: (addr) => addr.protos().filter(p => p.name === 'quic').length === 0
      })
    })

    it("creates a jobs db", async () => {
      assert.strictEqual(powergateio.databases.jobs.dbname, 'jobs')
      assert.strictEqual(powergateio.databases.jobs.type, 'docstore')
    })

    describe("stores and retrieves a db snapshot - permissionless", function () {
      let db, db2, snapshots
      const logLength = 100
      let jobStatus

      before(async () => {
        db = await orbitdb.eventlog('powergate-test')
      })

      it(`makes a local eventlog with ${logLength} items`, async () => {
        for(let i = 0; i < logLength; i++) {
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

        for(let i in db2.index.values) {
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
