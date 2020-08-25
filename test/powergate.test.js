const assert = require('assert')
const fs = require('fs')
const { createPow } = require('@textile/powergate-client')
const { JobStatus } = require ('@textile/grpc-powergate-client/dist/ffs/rpc/rpc_pb')


describe('Powergate setup', () => {
  let id, token

  const host = "http://0.0.0.0:6002"
  const pow = createPow({ host })

  before(async () => {
    const ffs = await pow.ffs.create()
    pow.setToken(ffs.token)
  })

  it('does something', async () => {
    const { status, messagesList } = await pow.health.check()
    const { peersList } = await pow.net.peers()

    console.log(status, messagesList, peersList)
  })

  it('does something else', async () => {
    const { addrsList } = await pow.ffs.addrs()
    const { addr } = await pow.ffs.newAddr("my new addr")
    const { info } = await pow.ffs.info()

    // TODO: Replace this with OrbitDB stuff....
    // maybe log snapshot to CID?
    const buffer = fs.readFileSync(`./.gitignore`)
    const { cid } = await pow.ffs.stage(buffer)
    const { jobId } = await pow.ffs.pushStorageConfig(cid)

    const jobsCancel = pow.ffs.watchJobs((job) => {
      console.log(job)
      if (job.status === JobStatus.JOB_STATUS_CANCELED) {
          console.log("job canceled")
        } else if (job.status === JobStatus.JOB_STATUS_FAILED) {
          console.log("job failed")
        } else if (job.status === JobStatus.JOB_STATUS_SUCCESS) {
          console.log("job success!")
      }
    }, jobId)

    const logsCancel = pow.ffs.watchLogs((logEvent) => {
      console.log(`received event for cid ${logEvent.cid}`)
    }, cid)

    // const { config } = await pow.ffs.getStorageConfig(cid)

    // const { cidInfo } = await pow.ffs.show(cid)

    // const bytes = await pow.ffs.get(cid)

    // await pow.ffs.sendFil(addrsList[0].addr, "<some other address>", 1000)
  })
})

