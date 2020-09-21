const assert = require('assert')
const fs = require('fs')
const { createPow } = require('@textile/powergate-client')

const {
  startIpfs,
  config,
  stopIpfs,
  testAPIs
} = require('orbit-db-test-utils')

const {
  filterPublicMultiaddr,
  generateIPFSOptions,
  waitForBalance
} = require('../src/utils')
const IpfsClient = require('ipfs-http-client')

const POWERGATE_HREF = process.env.POWERGATE_HREF || 'http://0.0.0.0:6002'
const IS_REMOTE = (POWERGATE_HREF !== 'http://0.0.0.0:6002')

describe('Powergate setup', function () {
  let powIpfs, token

  const timeout = IS_REMOTE ? 120000 : 10000
  this.timeout(timeout)

  const pow = createPow({ host: POWERGATE_HREF })
  const buffer = fs.readFileSync('./package.json')

  it('creates an FFS and assigns a token', async () => {
    const ffs = await pow.ffs.create()
    pow.setToken(ffs.token)
    token = ffs.token
  })

  it('can access the underlying IPFS HTTP API', async () => {
    const ipfsOptions = generateIPFSOptions(POWERGATE_HREF, token)
    powIpfs = new IpfsClient(ipfsOptions)
    const id = await powIpfs.id()

    assert(id.addresses.length > 0)
    assert.strictEqual(id.protocolVersion, 'ipfs/0.1.0')
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

    const result = await powIpfs.get(cid)

    // TODO: Better syntax for these?
    for await (const data of result) {
      assert.strictEqual(data.path, cid)
      for await (const content of data.content) {
        assert.deepStrictEqual(content, buffer)
      }
    }
  })

  Object.keys(testAPIs).forEach(API => {
    describe(`pubsub tests (${API})`, function () {
      let ipfsd, localIpfs
      const msg = 'xxxyyy'

      before(async () => {
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
        localIpfs = ipfsd.api

        // await powergateio.ipfs.swarm.connect(addresses[addresses.length - 1])
      })

      after(async () => {
        await stopIpfs(ipfsd)
      })

      if (IS_REMOTE) {
        it('finds its way through the local NAT', (done) => {
          const interval = setInterval(async () => {
            const addresses = (await localIpfs.id()).addresses
            console.log(filterPublicMultiaddr(addresses))
            if (filterPublicMultiaddr(addresses).length > 0) {
              clearInterval(interval)
              done()
            }
          }, 2000)
        })
      }

      it('can ask the powergate IPFS to connect to us', async () => {
        let addresses = (await localIpfs.id()).addresses
        if (IS_REMOTE) {
          addresses = filterPublicMultiaddr(addresses)
        }
        await powIpfs.swarm.connect(addresses[addresses.length - 1])
      })

      it('can pubsub publish to the powergate IPFS', (done) => {
        powIpfs.pubsub.subscribe('powergate-test', async (message) => {
          assert.strictEqual(Buffer.from(message.data).toString(), msg)
          done()
          await powIpfs.pubsub.unsubscribe('powergate-test')
        }).then(() => {
          setTimeout(() => {
            localIpfs.pubsub.publish('powergate-test', Buffer.from(msg))
          }, 1000)
        })
      })

      it('can pubsub subscribe to the powergate IPFS', (done) => {
        localIpfs.pubsub.subscribe('powergate-test', async (message) => {
          assert.strictEqual(Buffer.from(message.data).toString(), msg)
          done()
        })

        setTimeout(() => {
          powIpfs.pubsub.publish('powergate-test', Buffer.from('xxxyyy'))
        }, 1000)
      })
    })
  })
})
