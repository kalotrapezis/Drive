'use strict'
/**
 * Drives that are plugged in (SYNC_PLAN.md D5).
 *
 * A drive is the cheapest second copy there is, and it is a different kind of peer from a phone: no
 * certificate, no token, no beacon, no other end to agree with — a path, and whether it is there right now.
 * What does carry over unchanged is everything above the wire: nothing is overwritten, every byte is checked
 * before it counts, and nothing is ever deleted on either side.
 *
 * A drive is known by its **filesystem UUID**, never by where it is mounted: /mnt/T7 today is /media/teo/T7
 * tomorrow, and the same disk must still be the same disk.
 */
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const run = promisify(execFile)

/** Mount points that belong to the system rather than to anyone's data. */
const SYSTEM = [/^\/$/, /^\/boot/, /^\/snap/, /^\/var\/snap/, /^\/proc/, /^\/sys/, /^\/run(\/|$)/]

const isSystem = mount => !mount || SYSTEM.some(re => re.test(mount))

/**
 * Every mounted filesystem that could hold a backup: something plugged in, or something mounted outside the
 * system's own tree. Returns [] rather than throwing on a machine where `lsblk` is not the way to ask.
 */
async function list() {
  const out = await run('lsblk', ['--json', '-b', '-o', 'PATH,UUID,LABEL,FSTYPE,SIZE,FSAVAIL,MOUNTPOINT,HOTPLUG,TYPE'])
    .then(r => r.stdout).catch(() => null)
  if (!out) return []
  const tree = JSON.parse(out).blockdevices ?? []
  const found = []
  const walk = node => {
    const fs = node.fstype
    if (fs && fs !== 'swap' && node.uuid && !isSystem(node.mountpoint)) {
      found.push({
        uuid: node.uuid,
        label: node.label || node.path.split('/').pop(),
        fstype: fs,
        mount: node.mountpoint,
        sizeBytes: Number(node.size) || 0,
        freeBytes: Number(node.fsavail) || 0,
        hotplug: !!node.hotplug,
      })
    }
    for (const child of node.children ?? []) walk(child)
  }
  for (const node of tree) walk(node)
  return found
}

/** Where a known drive is mounted right now, or null when it is not plugged in. */
async function mountOf(uuid) {
  return (await list()).find(d => d.uuid === uuid)?.mount ?? null
}

module.exports = { list, mountOf }
