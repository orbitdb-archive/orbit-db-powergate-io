const assert = require('assert')
const fs = require('fs')
const { createPow } = require('@textile/powergate-client')
const { JobStatus } = require ('@textile/grpc-powergate-client/dist/ffs/rpc/rpc_pb')

const { waitForBalance } = require('./utils')
const IpfsClient = require('ipfs-http-client')


describe('Powergate setup', function () {
  let id, token, logsCancel, jobsCancel

  this.timeout(240000)

  const host = "http://0.0.0.0:6002"
  const pow = createPow({ host })
  const ipfs = new IpfsClient()
  const buffer = fs.readFileSync(`./package.json`)

  after(async () => {
    // await jobsCancel()
    // await logsCancel()
  })

  it('creates an FFS and assigns a token', async () => {
    const ffs = await pow.ffs.create()
    pow.setToken(ffs.token)
  })

  it('assigns a wallet address', async () => {
    const name = 'powergate.test.js'
    const { addr } = await pow.ffs.newAddr(name)
    await waitForBalance(pow.ffs, addr, 0)

    const { addrsList } = await pow.ffs.addrs()
    const result = addrsList.filter(a => a.addr === addr)[0]

    assert.strictEqual(result.addr, addr)
    assert.strictEqual(result.name, name)
    assert.strictEqual(result.type, 'bls')
  })

  it('has the correct configuration', async () => {
    const { info } = await pow.ffs.info()
    const config = info.defaultStorageConfig

    assert.strictEqual(config.hot.enabled, true)
    assert.strictEqual(config.hot.allowUnfreeze, false)
    assert.strictEqual(config.cold.enabled, true)
    assert.strictEqual(config.repairable, false)
  })

  it('creates a healthy powergate', async () => {
    const { status, messagesList } = await pow.health.check()

    // TODO: Replace with named enum variant
    assert.strictEqual(status, 1)
    assert.deepStrictEqual(messagesList, [])
  })

  it('properly stores hot data in IPFS', async () => {
    const { cid } = await pow.ffs.stage(buffer)

    const result = await ipfs.get(cid)

    // TODO: Better syntax for these?
    for await (let data of result) {
      assert.strictEqual(data.path, cid)
      for await (let content of data.content) {
        assert.deepStrictEqual(content._bufs[0], buffer)
      }
    }
  })

  it('creates storage deal and then retrieves data', (done) => {
    (async () => {
      const { cid } = await pow.ffs.stage(buffer)
      const { jobId } = await pow.ffs.pushStorageConfig(cid)

      console.log("\twaiting for job to complete... probably about 2 mins")
      jobsCancel = pow.ffs.watchJobs(async (job) => {
        if (job.status === JobStatus.JOB_STATUS_CANCELED) {
          assert(false, 'job canceled')
          done()
        } else if (job.status === JobStatus.JOB_STATUS_FAILED) {
          assert(false, 'job failed')
          done()
        } else if (job.status === JobStatus.JOB_STATUS_SUCCESS) {
          const { config } = await pow.ffs.getStorageConfig(cid)
          const { cidInfo } = await pow.ffs.show(cid)
          const bytes = await pow.ffs.get(cid)
          assert.deepStrictEqual(buffer, Buffer.from(bytes))
          jobsCancel()
          done()
        }
      }, jobId)

      // TODO: Something here
      // logsCancel = pow.ffs.watchLogs((logEvent) => {
        // console.log(logEvent)
        // console.log(`\treceived event for cid ${logEvent.cid}`)
      // }, cid)
    })()
  })
})

