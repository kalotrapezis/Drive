'use strict'
/**
 * Directions on the computer (Drive-Android Plan.md § Maps): the phone's own routing graph, Files/Maps/greece-gh
 * (GraphHopper 10.2, made here by tools/maps-greece.sh), answered by GraphHopper's server on this computer. It needs what
 * made the graph: Java 17 or newer and graphhopper-web-10.2.jar (tools/maps-greece.sh keeps it in ~/Tetra-maps/bin).
 *
 * The graph folder is synced, so the server never writes there: it reads it memory-mapped and read-only through a folder of
 * links in the app's own data (GraphHopper's lock file lands there, never on the phone).
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawn, spawnSync } = require('node:child_process')
const { t } = require('./i18n')

const JAR = 'graphhopper-web-10.2.jar'
/** The graph's profiles exactly as made (tools/maps-graph.yml): GraphHopper refuses a graph whose profiles differ. */
const PROFILES = `  profiles:
    - name: car
      turn_costs:
        vehicle_types: [motorcar, motor_vehicle]
      custom_model_files: [car.json]
    - name: foot
      custom_model_files: [foot.json]
    - name: bike
      custom_model_files: [bike.json]
    - name: wheelchair
      custom_model:
        priority:
          - { if: "!foot_access || hike_rating >= 1", multiply_by: "0" }
          - { if: "road_class == STEPS", multiply_by: "0" }
          - { if: "mtb_rating > 1", multiply_by: "0" }
          - { else: "", multiply_by: "foot_priority" }
        speed:
          - { if: "true", limit_to: "foot_average_speed" }
          - { if: "true", limit_to: "4" }
  profiles_ch:
    - profile: car
    - profile: foot
    - profile: bike
    - profile: wheelchair
  profiles_lm: []
  graph.encoded_values: car_access, car_average_speed, foot_access, hike_rating, mtb_rating, foot_priority, foot_average_speed, bike_priority, bike_access, roundabout, bike_average_speed, road_class, road_environment, max_speed
  import.osm.ignored_highways: ""
  routing.snap_preventions_default: tunnel, bridge, ferry
`
/**
 * Main roads (the user, 24 Oct: "it always chooses the shorter path … even if that means a road that falls off a cliff"):
 * car.json without its pull towards the shorter way, a smaller road counting slower — MapsRouting.mainPriority on the
 * phone. Asked without the graph's shortcuts, which are made for car.json.
 */
const MAIN_ROADS = {
  distance_influence: 0,
  priority: [
    { if: 'road_class == MOTORWAY || road_class == TRUNK || road_class == PRIMARY || road_class == SECONDARY', multiply_by: '1' },
    { else_if: 'road_class == TERTIARY', multiply_by: '0.8' },
    { else_if: 'road_class == RESIDENTIAL || road_class == LIVING_STREET', multiply_by: '0.6' },
    { else_if: 'road_class == UNCLASSIFIED', multiply_by: '0.4' },
    { else_if: 'road_class == TRACK', multiply_by: '0.1' },
    { else: '', multiply_by: '0.3' },
  ],
}

/** The phone's car times are GraphHopper's × 1.2 (Plan.md § Maps: Άγιος Λουκάς → Χαλκίδα 30 min). */
const CAR_TIME = 1.2

/** Where the map builder keeps its tools (mapbuild.js; tools/maps-greece.sh uses the same bin). */
const BIN = path.join(os.homedir(), 'Tetra-maps', 'bin')

/** A Java of 17 or newer, as GraphHopper 10.2 needs (the map builder asks the system for one when there is none). */
function findJava() {
  const major = java => { try { const r = spawnSync(java, ['-version'], { timeout: 5000, encoding: 'utf8' }); return r.status === 0 ? +(/version "(\d+)/.exec(r.stderr)?.[1] ?? 0) : 0 } catch { return 0 } }
  return [process.env.JAVA, '/usr/lib/jvm/java-17-openjdk-amd64/bin/java', 'java'].find(j => j && major(j) >= 17) ?? null
}

class Router {
  constructor(graphDir, workDir) { this.graphDir = graphDir; this.workDir = workDir; this.proc = null; this.port = 0; this.starting = null }

  /** Java and the jar, or why not. */
  tools() {
    const jar = [process.env.TETRA_GRAPHHOPPER_JAR, path.join(BIN, JAR)].find(f => f && fs.existsSync(f))
    const java = findJava()
    if (!fs.existsSync(path.join(this.graphDir, 'properties'))) return { why: t('maps.noGraph') }
    if (!java) return { why: t('maps.needJava') }
    if (!jar) return { why: t('maps.needJar', { jar: JAR }) }
    return { java, jar }
  }

  stamp() { try { return fs.statSync(path.join(this.graphDir, 'properties')).mtimeMs } catch { return 0 } }

  async start() {
    const tools = this.tools()
    if (tools.why) throw new Error(tools.why)
    const links = path.join(this.workDir, 'graph')
    fs.rmSync(this.workDir, { recursive: true, force: true })
    fs.mkdirSync(links, { recursive: true })
    for (const f of fs.readdirSync(this.graphDir)) if (f !== 'gh.lock') fs.symlinkSync(path.join(this.graphDir, f), path.join(links, f))
    this.port = await freePort()
    const admin = await freePort()
    fs.writeFileSync(path.join(this.workDir, 'config.yml'), `graphhopper:\n  graph.location: ${JSON.stringify(links)}\n  graph.dataaccess.default_type: MMAP_RO\n${PROFILES}` +
      `server:\n  application_connectors:\n    - type: http\n      port: ${this.port}\n      bind_host: localhost\n  admin_connectors:\n    - type: http\n      port: ${admin}\n      bind_host: localhost\n`)
    const log = fs.openSync(path.join(this.workDir, 'graphhopper.log'), 'w')
    this.proc = spawn(tools.java, ['-Xmx1g', '-jar', tools.jar, 'server', 'config.yml'], { cwd: this.workDir, stdio: ['ignore', log, log] })
    this.graphStamp = this.stamp()
    const proc = this.proc
    proc.on('exit', () => { if (this.proc === proc) this.proc = null })
    for (let i = 0; i < 120; i++) {
      if (!this.proc) throw new Error(t('maps.routerStopped'))
      if (await fetch(`http://localhost:${this.port}/health`).then(r => r.ok, () => false)) return
      await new Promise(r => setTimeout(r, 500))
    }
    this.stop()
    throw new Error(t('maps.routerSlow'))
  }

  async ready() {
    if (this.proc && this.graphStamp !== this.stamp()) this.stop() // sync brought a new graph
    if (!this.proc) { this.starting ??= this.start().finally(() => { this.starting = null }); await this.starting }
  }

  /** From the first point through each next one: its line, metres, minutes and turns (Greek, as the phone says them). */
  async route(points, mode = 'car', main = false) {
    const profile = ['car', 'foot', 'bike', 'wheelchair'].includes(mode) ? mode : 'car'
    if (!Array.isArray(points) || points.length < 2 || !points.every(p => Number.isFinite(p?.lat) && Number.isFinite(p?.lng))) throw new Error(t('maps.needTwoPlaces'))
    await this.ready()
    let body
    if (main && profile === 'car') {
      const res = await fetch(`http://localhost:${this.port}/route`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: points.map(p => [p.lng, p.lat]), profile, locale: 'el', instructions: true, points_encoded: false, 'ch.disable': true, custom_model: MAIN_ROADS }) })
      body = await res.json()
      if (!res.ok || !body.paths?.length) body = null // too far to search without the shortcuts: the shortest way, as the phone
    }
    if (!body) {
      const q = points.map(p => `point=${p.lat},${p.lng}`).join('&')
      const res = await fetch(`http://localhost:${this.port}/route?${q}&profile=${profile}&locale=el&instructions=true&points_encoded=false`)
      body = await res.json()
      if (!res.ok || !body.paths?.length) throw new Error(plain(body.message))
    }
    const p = body.paths[0], k = profile === 'car' ? CAR_TIME : 1
    return { metres: p.distance, seconds: p.time / 1000 * k, line: p.points.coordinates,
      steps: p.instructions.map(i => ({ text: i.text, metres: i.distance, seconds: i.time / 1000 * k, sign: i.sign })) }
  }

  stop() { const p = this.proc; this.proc = null; p?.kill() }
}

/** GraphHopper's errors in plain words (the phone: "routing errors in plain words"). */
function plain(message = '') {
  if (/Cannot find point|PointNotFound/i.test(message)) return t('maps.noRoadNear')
  if (/Connection between locations not found|ConnectionNotFound/i.test(message)) return t('maps.noWay')
  if (/out of bounds/i.test(message)) return t('maps.outsideMap')
  return message || t('maps.noRoute')
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.listen(0, 'localhost', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  s.on('error', reject)
})

module.exports = { Router, plain, MAIN_ROADS, PROFILES, JAR, BIN, findJava }
