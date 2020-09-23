const assert = require('assert')
const PowergateIO = require('../src')
const OrbitDB = require('orbit-db')
const { JobStatus } = require('@textile/grpc-powergate-client/dist/ffs/rpc/rpc_pb')
const rm = require('rimraf')
const { filterPublicMultiaddr } = require('../src/utils')
const {
  config,
  startIpfs,
  stopIpfs,
  testAPIs
} = require('orbit-db-test-utils')

const POWERGATE_HREF = process.env.POWERGATE_HREF || 'http://0.0.0.0:6002'
const IS_REMOTE = (POWERGATE_HREF !== 'http://0.0.0.0:6002')
const IS_LOCAL = !IS_REMOTE

// testAPIs here means both go-ipfs and js-ipfs, so we run the tests
// once for each implementation of IPFS to ensure it works with both
Object.keys(testAPIs).forEach(API => {
  describe(`PowergateIO - default options (${API})`, function () {
    let ipfsd, orbitdb, powergateio

    const timeout = IS_REMOTE ? 120000 : 10000
    this.timeout(timeout)

    before(async () => {
      // Delete the orbitdb folder for each test run
      rm('./orbitdb', () => {})

      // Create a local ipfs node, as well as a local OrbitDB instance
      ipfsd = await startIpfs(API, config.daemon1)
      orbitdb = await OrbitDB.createInstance(ipfsd.api)

      // Create our PowergateIO object now, which contains all
      // of the abstractions from powergate.spec.js, and more
      powergateio = await PowergateIO.create(POWERGATE_HREF)
    })

    // Clean up everything. It can take a second, but the
    // tests will eventually exit.
    after(async () => {
      await orbitdb.disconnect()
      await powergateio.stop()
      await stopIpfs(ipfsd)
    })

    it('backgrounds wallet creation and reports as pending immediately', () => {
      // At first the wallet will be empty while waiting for funding.
      assert.deepStrictEqual(powergateio.wallet, {})
    })

    it('eventually returns wallet info', (done) => {
      // Check the wallet every second to see when it gets funded, and
      // assert the default values when it does.
      const walletInterval = setInterval(() => {
        if (JSON.stringify(powergateio.wallet) !== '{}') {
          assert.strictEqual(powergateio.wallet.addr.name, '_default')
          assert.strictEqual(powergateio.wallet.addr.type, 'bls')
          clearInterval(walletInterval)
          done()
        }
      }, 1000)
    })

    it('successfully connects with the Powergate peer', async () => {
      // Get the list of advertised multiaddrs from the Powergate IPFS node
      let addresses = (await powergateio.ipfs.id()).addresses

      // We have to do some finagling to ensure that we dial the correct address
      // If it's a remote node, we want a public IP address. Opposite if not.
      if (IS_REMOTE) {
        addresses = filterPublicMultiaddr(addresses)
      } else {
        addresses = addresses
          .filter(a => a.toString().indexOf('127.0.0.1') !== -1)
          .filter(a => a.toString().indexOf('quic') === -1)
      }

      // Connect to the Powergate IPFS node
      await ipfsd.api.swarm.connect(addresses[addresses.length - 1])
      const peers = await powergateio.ipfs.swarm.peers()
      const peerId = (await ipfsd.api.id()).id
      assert(peers.filter(p => p.peer === peerId).length > 0)
    })

    // On creation, PowergateIO will create an internal jobs database
    // to keep track of snapshot cids and job statuses
    it('creates a jobs db', async () => {
      assert.strictEqual(powergateio.databases.jobs.dbname, 'jobs')
      assert.strictEqual(powergateio.databases.jobs.type, 'docstore')
    })

    describe('stores and retrieves a db snapshot - permissionless', function () {
      let db, db2, snapshots
      const logLength = 10
      let jobStatus

      // Create a local OrbitDB database. Eventlog is the simplest type
      before(async () => {
        db = await orbitdb.eventlog('powergate-test')
      })

      it(`makes a local eventlog with ${logLength} items`, async () => {
        // Simple loop to add items to the database. Experiment with logLength
        for (let i = 0; i < logLength; i++) {
          await db.add(`entry${i}`)
        }

        // Loading here to make sure there aren't extra entries
        await db.load()

        assert.strictEqual(db.index.values.length, logLength)
      })

      it('stores a snapshot and creates an entry in the jobs db', async () => {
        // Submit a db address, get back a receipt for a storge job. The
        // job status will be executing. This won't complete until the db has replicated
        // See: https://github.com/textileio/powergate/blob/master/ffs/rpc/rpc.proto#L103
        jobStatus = await powergateio.storeSnapshot(db.address.toString())

        assert.strictEqual(jobStatus.dbAddress, db.address.toString())
        // See: https://github.com/textileio/powergate/blob/master/ffs/rpc/rpc.proto#L103
        assert.strictEqual(jobStatus.status, JobStatus.JOB_STATUS_EXECUTING)
        assert.strictEqual(jobStatus.errCause, '')
        assert.strictEqual(jobStatus.dealErrorsList.length, 0)

        // Drop db after snapshotting it
        await db.drop()
      })

      it('reports the job status immediately', async () => {
        // Queries the internal database by job ID
        const reportedStatus = await powergateio.getJobStatus(jobStatus.id)

        assert.strictEqual(jobStatus.cid, reportedStatus[0].cid)
        // See: https://github.com/textileio/powergate/blob/master/ffs/rpc/rpc.proto#L103
        assert.strictEqual(reportedStatus[0].status, JobStatus.JOB_STATUS_EXECUTING)
      })

      it('retrieves a remote database snapshot from "hot" storage by CID', async () => {
        // Open a brand new empty database (original db is dropped above)
        db2 = await orbitdb.open(db.address.toString(), { create: true })

        assert.strictEqual(db.address.toString(), db2.address.toString())

        // DB should be empty after load
        await db2.load()
        assert.strictEqual(db2._oplog.values.length, 0)

        // Retrieve an array of snapshots from powergateio
        // Right now we're only testing one, TODO test for multiple
        snapshots = await powergateio.retrieveSnapshot(db2.address.toString())

        assert.strictEqual(snapshots.length, 1)
        assert.strictEqual(snapshots[0].job.dbAddress, db.address.toString())
        // See: https://github.com/textileio/powergate/blob/master/ffs/rpc/rpc.proto#L103
        assert.strictEqual(snapshots[0].job.status, JobStatus.JOB_STATUS_EXECUTING)
        assert.strictEqual(snapshots[0].job.errCause, '')
        assert.strictEqual(snapshots[0].job.dealErrorsList.length, 0)

        assert.strictEqual(snapshots[0].log.length, logLength)
        assert.strictEqual(snapshots[0].log.id, db.address.toString())
      })

      it('loads the snapshot into a fully-functioning OrbitDB database', async () => {
        // FIXME: These steps are necessary but should be abstracted into a
        // public UI somehow, or hidden.
        await db2._oplog.join(snapshots[0].log)
        await db2._updateIndex()

        for (const i in db2.index.values) {
          assert.strictEqual(db2.index.values[i].payload.value, `entry${i}`)
        }
      })

      // The tests continue for local-only tests, since these could take
      // up to 20 hours on testnet. So we skip them there for now.
      if (IS_LOCAL) {
        this.timeout(240000)

        it('eventually reports the job as completed', (done) => {
          // Ping getJobStatus every 2 seconds until status reports success
          const interval = setInterval(async () => {
            const status = await powergateio.getJobStatus(jobStatus.id)
            // See: https://github.com/textileio/powergate/blob/master/ffs/rpc/rpc.proto#L103
            if (status[0].status === JobStatus.JOB_STATUS_SUCCESS) {
              assert(true)
              clearInterval(interval)
              done()
            }
          }, 2000)
        })

        it('does not pollute the db via watchJobs', async () => {
          // Here, we're testing that the instantaneous status reported
          // from PowergateIO after the job completes matches the original
          // JobStatus we got back on job creation
          const status = await powergateio.getJobStatus(jobStatus.id)

          assert.strictEqual(status[0].id, jobStatus.id)
          assert.strictEqual(status[0].apiId, jobStatus.apiId)
          assert.strictEqual(status[0].cid, jobStatus.cid)
          // See: https://github.com/textileio/powergate/blob/master/ffs/rpc/rpc.proto#L103
          assert.strictEqual(status[0].status, JobStatus.JOB_STATUS_SUCCESS)
          assert.strictEqual(status[0].dbAddress, jobStatus.dbAddress)
        })
      }

      after(async () => {
        await db.close()
        await db2.close()
      })
    })
  })
})
