const assert = require('assert')
const fs = require('fs')
const { createPow } = require('@textile/powergate-client')
const { JobStatus } = require ('@textile/grpc-powergate-client/dist/ffs/rpc/rpc_pb')


describe('Powergate setup', function () {
  let id, token, logsCancel, jobsCancel

  this.timeout(240000)

  const host = "http://0.0.0.0:6002"
  const pow = createPow({ host })

  before(async () => {
    const ffs = await pow.ffs.create()
    pow.setToken(ffs.token)
  })

  after(async () => {
    await jobsCancel()
    await logsCancel()
  })

  it('Setting up a FFS instance and address', async () => {
    // const { status, messagesList } = await pow.health.check()
    // const { peersList } = await pow.net.peers()
    // const { addrsList } = await pow.ffs.addrs()
    const { addr } = await pow.ffs.newAddr("my new addr")
    await waitForBalance(pow.ffs, addr, 0)
  })

  it('Successfully creates storage deal', (done) => {
    (async () => {
      const { info } = await pow.ffs.info()

      // maybe log snapshot to CID?
      const buffer = fs.readFileSync(`./package.json`)
      const { cid } = await pow.ffs.stage(buffer)
      const { jobId } = await pow.ffs.pushStorageConfig(cid)

      console.log("\twaiting for job to complete... probably about 2 mins")
      jobsCancel = pow.ffs.watchJobs(async (job) => {
        if (job.status === JobStatus.JOB_STATUS_CANCELED) {
          console.log("job canceled")
        } else if (job.status === JobStatus.JOB_STATUS_FAILED) {
          assert(false)
          done()
          console.log("job failed")
        } else if (job.status === JobStatus.JOB_STATUS_SUCCESS) {
          const { config } = await pow.ffs.getStorageConfig(cid)

          const { cidInfo } = await pow.ffs.show(cid)

          const bytes = await pow.ffs.get(cid)
          assert.deepStrictEqual(buffer, Buffer.from(bytes))

          done()
        }
      }, jobId)

      logsCancel = pow.ffs.watchLogs((logEvent) => {
        console.log(`\treceived event for cid ${logEvent.cid}`)
      }, cid)
    })()
  })
})

function waitForBalance(ffs, address, greaterThan) {
  return new Promise(async (resolve, reject) => {
    while (true) {
      try {
        const res = await ffs.info()
        if (!res.info) {
          reject("no balance info returned")
          return
        }
        const info = res.info.balancesList.find((info) => info.addr && info.addr.addr === address)
        if (!info) {
          reject("address not in balances list")
          return
        }
        if (info.balance > greaterThan) {
          resolve(info.balance)
          return
        }
      } catch (e) {
        reject(e)
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
  })
}

