'use strict'

/**
 * @external IPFS
 * @see https://github.com/ipfs/js-ipfs
 * @see https://github.com/ipfs/go-ipfs
 */

/**
 * @external OrbitDB
 * @see https://github.com/orbitdb/orbit-db
 */

/**
 * @external ipfs-log
 * @see https://github.com/orbitdb/ipfs-log
 */

/**
 * @external powergate-client
 * @see https://github.com/textileio/js-powergate-client
 */

/**
 * @typedef databases { Object }
 * @property jobs { Object }
 */

/**
 * @typedef JobStatus { Object }
 * @property id { String }
 * @property dbAddress { string }
 */

const OrbitDB = require('orbit-db')
const { createPow } = require('@textile/powergate-client')
const IpfsClient = require('ipfs-http-client')
const {
  generateIPFSOptions,
  waitForBalance
} = require('./utils')
const Log = require('ipfs-log')

class PowergateIO {
  /**
   * This constructor should not be called directly. Instead use
   * [<code>async PowergateIO.create()</code>]{@link PowergateIO.create}
   *
   * @constructor
   */
  constructor (databases, orbitdb, pow, addr) {
    /** @member { databases } */
    this.databases = databases

    /** @member { OrbitDB } */
    this._orbitdb = orbitdb

    /** @member { powergate-client } */
    this._pow = pow

    /**
     * FIL wallet info on the Powergate node
     * @member { Object }
     */
    this.wallet = {}
    waitForBalance(pow.ffs, addr, 0).then((info) => {
      this.wallet = info
    })

    /**
     * An array of intervalIDs that watch jobs
     * @member { intervalID[] }
     */
    this._jobWatchers = []
  }

  /**
   * The IPFS node associated with the Powergate. This is also the IPFS
   * node that the internal OrbitDB instance utilizes.
   *
   * @getter
   */
  get ipfs () {
    return this._orbitdb._ipfs
  }

  /**
   * Factory method to create a {@link PowergateIO} instance.
   *
   * This does quite a bit of work, creating:
   *
   * <ul>
   *   <li>a js-powergate-client instance</li>
   *   <li>a Filecoin file system (FFS)</li>
   *   <li>an IpfsClient</li>
   *   <li>an OrbitDB instance</li>
   *   <li>a jobs database</li>
   *   <li>a FIL wallet address</li>
   * </ul>
   *
   * @param host { String } The full HREF of the Powergate gRPC API endpoint.
   * @returns Promise{@link PowergateIO}
   */
  static async create (host = 'http://0.0.0.0:6002') {
    const pow = createPow({ host })
    const ffs = await pow.ffs.create()
    pow.setToken(ffs.token)

    const ipfsOptions = generateIPFSOptions(host, ffs.token)
    const ipfs = new IpfsClient(ipfsOptions)
    const orbitdb = await OrbitDB.createInstance(ipfs)

    const jobsDb = await orbitdb.docs('jobs', { indexBy: 'id' })

    // Create default address
    const { addr } = await pow.ffs.newAddr('_default')

    return new PowergateIO({ jobs: jobsDb }, orbitdb, pow, addr)
  }

  /**
   * Utility function to return the status of a job by querying the jobs OrbitDB database
   *
   * @param jobId { String } ID of the Powergate job in UUID format
   * @returns { JobStatus[] }
   */
  async getJobStatus (jobId) {
    await this.databases.jobs.load()
    return this.databases.jobs.get(jobId)
  }

  /**
   * Retrieves all stores snapshots based on the database address, either from hot or cold
   * storage, whichever is available.
   *
   * @param dbAddress { String } Should be in the format <code>"/orbitdb/dpuXXX/db-name"</code> i.e. <code>db.address.toString()</code>
   * @returns Promise{ Snapshot[] }
   */
  async retrieveSnapshot (dbAddress) {
    await this.databases.jobs.load()
    const jobs = await this.databases.jobs.query(d => d.dbAddress === dbAddress)

    const snapshots = await Promise.all(jobs.map(async (job) => {
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

  /**
   * A shim function to get the <em>current</em> status of a job, as opposed to
   * watching it. Will be removed once the powergate-client is updated to support
   * this functionality
   *
   * @param jobId { String }
   * @returns Promise{JobStatus}
   */
  snapshotJob (jobId) {
    return new Promise((resolve, reject) => {
      try {
        const cancel = this._pow.ffs.watchJobs(async (job) => {
          resolve(job)
          cancel()
        }, jobId)
      } catch (e) {
        reject(e)
      }
    })
  }

  /**
   * Replicates a database to the Powergate instance, stores the snapshot, then drops the db
   *
   * returns Promise{JobStatus}
   */
  async storeSnapshot (dbAddress) {
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
            const jobStatus = await this.snapshotJob(jobId)
            jobStatus.dbAddress = dbAddress
            await this.databases.jobs.put(jobStatus)

            this.watchJob(jobId)

            await db.drop()
            resolve(jobStatus)
          }
        })
      })
    })
  }

  /**
   * Creates an interval to periodically check a job status and then updates the jobs database.
   * Then, adds the interval {@link PowergateIO#_jobWatchers}
   *
   * @returns null
   */
  watchJob (jobId) {
    const checkAndUpdate = async () => {
      try {
        const currentStatus = await this.getJobStatus(jobId)
        const newStatus = await this.snapshotJob(jobId)
        if (currentStatus[0].status !== newStatus.status) {
          newStatus.dbAddress = currentStatus[0].dbAddress
          await this.databases.jobs.put(newStatus)
        }
      } catch (e) {
        console.error(e)
      }
    }

    checkAndUpdate()
    const watch = setInterval(checkAndUpdate, 1000)
    this._jobWatchers.push(watch)
  }

  /**
   * Cleanly stops the node by disconnecting OrbitDB and clearing all intervals
   * from this._jobWatchers.
   *
   * @returns null
   */
  async stop () {
    for (const watcher of this._jobWatchers) {
      clearInterval(watcher)
    }

    await this._orbitdb.disconnect()
  }
}

module.exports = PowergateIO
