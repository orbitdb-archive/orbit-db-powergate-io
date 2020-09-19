const OrbitDB = require('orbit-db')
const { createPow } = require('@textile/powergate-client')
const IpfsClient = require('ipfs-http-client')
const {
  filterPublicMultiaddr,
  generateIPFSOptions,
  waitForBalance,
} = require('./utils')
const Log = require('ipfs-log')

// Workaround wrapper function
// To be removed once Powergate supports it officially
const snapshotJob = async (pow, jobId) => {
  return new Promise((resolve, reject) => {
    try {
      const cancel = pow.ffs.watchJobs(async (job) => {
        resolve(job)
        cancel()
      }, jobId)
    } catch (e) {
      reject(e)
    }
  })
}

class PowergateIO {
  constructor(databases, orbitdb, pow) {
    this.databases = databases
    this._orbitdb = orbitdb
    this._pow = pow
  }

  get ipfs() {
    return this._orbitdb._ipfs
  }

  // TODO: Config
  // TODO: Call this createDefault?
  static async create(host="http://0.0.0.0:6002") {
    const pow = createPow({ host })
    const ffs = await pow.ffs.create()
    pow.setToken(ffs.token)

    const ipfsOptions = generateIPFSOptions(host, ffs.token)
    const ipfs = new IpfsClient(ipfsOptions)
    const orbitdb = await OrbitDB.createInstance(ipfs)

    const addresses = (await ipfs.id()).addresses

    const jobsDb = await orbitdb.docs('jobs', { indexBy: 'id' })

    // Create default address
    // TODO: Background this...
    const { addr } = await pow.ffs.newAddr("_default")
    await waitForBalance(pow.ffs, addr, 0)

    return new PowergateIO({ jobs: jobsDb }, orbitdb, pow)
  }

  async retrieveSnapshot(dbAddress) {
    await this.databases.jobs.load()
    const jobs = await this.databases.jobs.query(d => d.dbAddress === dbAddress)

    const snapshots = await Promise.all(jobs.map(async (job) => {
      // For now lets's just the the first aka 'latest"
      const bytes = await this._pow.ffs.get(job.cid)
      const snapshotData = JSON.parse((Buffer.from(bytes).toString()))

      const log = await Log.fromJSON(this._orbitdb._ipfs, this._orbitdb.identity, snapshotData, {
        length: -1,
        timeout: 1000
      })

      const snapshot = { job, log }

      return snapshot
    }))

    return snapshots
  }


  async storeSnapshot(dbAddress) {
    return new Promise((resolve, reject) => {
      this._orbitdb.open(dbAddress).then(async (db) => {
        let replicationComplete = false

        db.events.on('replicate.progress', (dbAddress, hash, entry) => {
          if (entry.next.length === 0) {
            replicationComplete = true
          }
        })

        db.events.on('replicated', async () => {
          if (replicationComplete) {
            await db.load()

            const snapshot = await db.saveSnapshot()
            const cid = snapshot[0].hash
            const { jobId } = await this._pow.ffs.pushStorageConfig(cid)
            const jobStatus = await snapshotJob(this._pow, jobId)

            // Sanitizing for OrbitDB docstore
            jobStatus.dbAddress = dbAddress
            await this.databases.jobs.put(jobStatus)

            await db.drop()
            resolve(jobStatus)
          }
        })
      })
    })
  }

  async stop() {
    await this._orbitdb.disconnect()
  }
}

module.exports = PowergateIO
