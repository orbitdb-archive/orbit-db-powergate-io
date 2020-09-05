const assert = require('assert')
const IpfsClient = require('ipfs-http-client')
const OrbitDB = require('orbit-db')
const rm = require('rimraf')
const { createPow } = require('@textile/powergate-client')
const { JobStatus } = require ('@textile/grpc-powergate-client/dist/ffs/rpc/rpc_pb')

const { waitForBalance } = require('./utils')

describe("OrbitDB tests", function () {
  let db, orbitdb, logsCancel, jobsCancel

  this.timeout(320000)

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

    await jobsCancel()
    await logsCancel()
  })

  it('makes an eventlog with 100 items', async () => {
    for(let i = 0; i < 100; i++) {
      await db.add(`entry${i}`)
    }

    // Loading here to make sure there aren't extra entries
    await db.load()

    assert.strictEqual(db.index.values.length, 100)
  })

  it('sends the CID to powergate', (done) => {
    (async () => {
      const snapshot = await db.saveSnapshot()
      const cid = snapshot[0].hash
      const { jobId } = await pow.ffs.pushStorageConfig(cid)

      console.log("\twaiting for job to complete... probably about 2 mins")
      jobsCancel = pow.ffs.watchJobs(async (job) => {
        if (job.status === JobStatus.JOB_STATUS_CANCELED) {
          console.error("job canceled")
        } else if (job.status === JobStatus.JOB_STATUS_FAILED) {
          console.error(job)
          assert(false)
          done()
        } else if (job.status === JobStatus.JOB_STATUS_SUCCESS) {
          const { config } = await pow.ffs.getStorageConfig(cid)

          const { cidInfo } = await pow.ffs.show(cid)

          const bytes = await pow.ffs.get(cid)
          // assert.deepStrictEqual(buffer, Buffer.from(bytes))

          done()
        }
      }, jobId)

      logsCancel = pow.ffs.watchLogs((logEvent) => {
        console.log(`\treceived event for cid ${logEvent.cid}`)
      }, cid)
    })()
  })
})
