const assert = require('assert')
const fs = require('fs')
const { createPow } = require('@textile/powergate-client')
const { JobStatus } = require ('@textile/grpc-powergate-client/dist/ffs/rpc/rpc_pb')

const { waitForBalance } = require('./utils')
const IpfsClient = require('ipfs-http-client')

const POWERGATE_HOST = process.env.POWERGATE_DOMAIN || '0.0.0.0'
const POWERGATE_URL = `http://${POWERGATE_HOST}:6002`

describe('Powergate setup', function () {
  let id, token, logsCancel, jobsCancel

  this.timeout(100000)

  const pow = createPow({ POWERGATE_URL })
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
        assert.deepStrictEqual(content, buffer)
      }
    }
  })
})

