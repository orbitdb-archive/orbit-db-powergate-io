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

// Testing that everything is configured properly
// before testing the actual functionality
describe('Powergate setup', function () {
  let powIpfs, token

  // Things take much longer if not on localnet
  const timeout = IS_REMOTE ? 120000 : 10000
  this.timeout(timeout)

  // Create a "pow" client instance
  const pow = createPow({ host: POWERGATE_HREF })
  // Reading in package.json file as an example
  const buffer = fs.readFileSync('./package.json')

  // Creates a Filecoin File System (FFS)
  it('creates an FFS and assigns a token', async () => {
    const ffs = await pow.ffs.create()
    // Setting the client token
    // Not to be confused with a cryptocurrency token
    pow.setToken(ffs.token)
    token = ffs.token
  })

  it('can access the underlying IPFS HTTP API', async () => {
    // Parse the URL into something the IpfsClient understands
    const ipfsOptions = generateIPFSOptions(POWERGATE_HREF, token)

    // Create an IpfsClient from the Powergate embedded IPFS node
    powIpfs = new IpfsClient(ipfsOptions)

    // Let's check the call to id() to make sure it's working properly
    const id = await powIpfs.id()
    assert(id.addresses.length > 0)
    assert.strictEqual(id.protocolVersion, 'ipfs/0.1.0')
  })

  // it.skip this test if you're developing locally against a remote
  // powergate node and want to move faster. Don't forget to unskip ;)
  it('assigns a wallet address', async () => {
    const name = 'powergate.test.js'

    // Create a new wallet address and wait for it to
    // be funded. This can take up to 2 minutes on testnet
    const { addr } = await pow.ffs.newAddr(name)
    await waitForBalance(pow.ffs, addr, 0)

    // Confirm that the wallet address exists
    const { addrsList } = await pow.ffs.addrs()
    const result = addrsList.filter(a => a.addr === addr)[0]

    assert.strictEqual(result.addr, addr)
    assert.strictEqual(result.name, name)
    assert.strictEqual(result.type, 'bls')
  })

  it('has the correct configuration', async () => {
    // The info object contains our defaultStorgeConfig
    // which we want to make sure is configured according
    // to the asserts below
    const { info } = await pow.ffs.info()
    const config = info.defaultStorageConfig

    assert.strictEqual(config.hot.enabled, true)
    assert.strictEqual(config.hot.allowUnfreeze, false)
    assert.strictEqual(config.cold.enabled, true)
    assert.strictEqual(config.repairable, false)
  })

  it('creates a healthy powergate', async () => {
    // Health check call should return status = 1, with
    // an empty message list
    const { status, messagesList } = await pow.health.check()

    // TODO: Replace with named enum variant
    assert.strictEqual(status, 1)
    assert.deepStrictEqual(messagesList, [])
  })

  // "Hot" storage in this context means IPFS, as opposed to Filecoin
  it('properly stores hot data in IPFS', async () => {
    // Staging the cid gets it ready by putting the data in IPFS
    const { cid } = await pow.ffs.stage(buffer)

    // Calling the "get" API from IPFS to retrieve and check the cid's data
    const result = await powIpfs.get(cid)

    // Check the data from the result returned from IPFS#get
    // TODO: Better syntax for these? They're async iterators
    // so it can get a little goofy
    for await (const data of result) {
      assert.strictEqual(data.path, cid)
      for await (const content of data.content) {
        assert.deepStrictEqual(content, buffer)
      }
    }
  })

  // testAPIs here means both go-ipfs and js-ipfs, so we run the tests
  // once for each implementation of IPFS to ensure it works with both
  Object.keys(testAPIs).forEach(API => {
    describe(`pubsub tests (${API})`, function () {
      let ipfsd, localIpfs
      const msg = 'xxxyyy'

      // For tests tests we create a localIpfs object to simulate
      // a remote connection to the Powergate embedded IPFS node
      before(async () => {
        // config.daemon1 comes from https://github.com/orbitdb/orbit-db-test-utils
        ipfsd = await startIpfs(API, config.daemon1)
        localIpfs = ipfsd.api
      })

      after(async () => {
        await stopIpfs(ipfsd)
      })

      it('can dial the Powergate IPFS node', async () => {
        // Get the list of advertised multiaddrs from the Powergate IPFS node
        let addresses = (await powIpfs.id()).addresses

        // We have to do some finagling to ensure that we dial the correct address
        // If it's a remote node, we want a public IP address. Opposite if not.
        if (IS_REMOTE) {
          addresses = filterPublicMultiaddr(addresses)
        } else {
          addresses = addresses
            .filter(a => a.toString().indexOf('127.0.0.1') !== -1)
            .filter(a => a.toString().indexOf('quic') === -1)
        }

        // Can we then successfully connect to the Powergate IPFS node?
        await localIpfs.swarm.connect(addresses[addresses.length - 1])
      })

      // The final two tests are inverses of each other. Basically can one
      // IPFS node subscribe to, and receive pubsub messages from the other.
      // Once it's confirmed that they can, unsubscribe and complete the test
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
