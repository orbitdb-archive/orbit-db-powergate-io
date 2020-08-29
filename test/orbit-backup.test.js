const assert = require('assert')
const IpfsClient = require('ipfs-http-client')
const OrbitDB = require('orbit-db')
const rm = require('rimraf')
const { createPow } = require('@textile/powergate-client')
const { JobStatus } = require ('@textile/grpc-powergate-client/dist/ffs/rpc/rpc_pb')
const Log = require('ipfs-log')
const toStream = require('it-to-stream')

const { waitForBalance } = require('./utils')

describe("OrbitDB tests", function () {
  let cid, db, orbitdb, logsCancel, jobsCancel

  const logLength = 100

  this.timeout(120000)

  const host = "http://0.0.0.0:6002"
  const pow = createPow({ host })

  before(async () => {
    rm('./orbitdb', () => {})
    const ipfs = new IpfsClient()
    orbitdb = await OrbitDB.createInstance(ipfs)
    db = await orbitdb.eventlog('powergate-test')

    const ffs = await pow.ffs.create()
    pow.setToken(ffs.token)
    const { addr } = await pow.ffs.newAddr("my new addr")
    await waitForBalance(pow.ffs, addr, 0)
  })

  after(async () => {
    await orbitdb.disconnect()
  })

  it(`makes an eventlog with ${logLength} items`, async () => {
    for(let i = 0; i < logLength; i++) {
      await db.add(`entry${i}`)
    }

    // Loading here to make sure there aren't extra entries
    await db.load()

    assert.strictEqual(db.index.values.length, logLength)
  })

  it('sends the CID to powergate', (done) => {
    (async () => {
      const snapshot = await db.saveSnapshot()
      cid = snapshot[0].hash
      const { jobId } = await pow.ffs.pushStorageConfig(cid)

      await db.close()

      console.log("\twaiting for job to complete... probably about 2 mins")
      jobsCancel = pow.ffs.watchJobs(async (job) => {
        if (job.status === JobStatus.JOB_STATUS_CANCELED) {
          console.error("job canceled")
        } else if (job.status === JobStatus.JOB_STATUS_FAILED) {
          console.error(job)
          done()
          return Promise.reject(assert(false))
        } else if (job.status === JobStatus.JOB_STATUS_SUCCESS) {
          jobsCancel()
          done()
        }
      }, jobId)

      // logsCancel = pow.ffs.watchLogs((logEvent) => {
      //   // console.log(`\treceived event for cid ${logEvent.cid}`)
      // }, cid)
    })()
  })

  it('retrieves the snapshot from powergate and loads it into an OrbitDB database', async () => {
    const db2 = await orbitdb.open(db.address.toString(), { create: true })
    // const { config } = await pow.ffs.getStorageConfig(cid)
    const { cidInfo } = await pow.ffs.show(cid)

    const onProgress = (hash, entry, count, total) => {
      db2._recalculateReplicationStatus(count, entry.clock.time)
      db2._onLoadProgress(hash, entry)
    }

    const bytes = await pow.ffs.get(cid)

    const snapshotData = JSON.parse((Buffer.from(bytes).toString()))

    const log = await Log.fromJSON(db2._ipfs, db2.identity, snapshotData, {
      access: db2.access,
      sortFn: db2.options.sortFn,
      length: -1,
      timeout: 1000,
      onProgressCallback: onProgress
    })

    await db2._oplog.join(log)
    await db2._updateIndex()

    for(let i in db2.index.values) {
      assert.strictEqual(db2.index.values[i].payload.value, `entry${i}`)
    }

    await db2.close()
  })
})
