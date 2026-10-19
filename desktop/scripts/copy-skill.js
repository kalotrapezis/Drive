// The tetra-calendar and tetra-timer skills' one source is Drive-Android's skills/; this copies them here before a build
// (npm start / dist), so Share with Claude hands over the skills matching the app. No source found: the copy already
// committed in desktop/skills stays.
const fs = require('node:fs')
const path = require('node:path')
const coding = path.resolve(__dirname, '..', '..', '..') // …/Coding (the Drive repo or a worktree of it sits here)
for (const name of ['tetra-calendar', 'tetra-timer']) {
  const to = path.join(__dirname, '..', 'skills', name)
  const from = [process.env.TETRA_SKILL_SRC && path.join(process.env.TETRA_SKILL_SRC, '..', name), path.join(coding, 'Drive-Android', 'skills', name),
    path.join(coding, '..', 'Drive-Android', 'skills', name)]
    .filter(Boolean).find(d => fs.existsSync(path.join(d, 'SKILL.md')))
  if (!from) { console.warn(`[copy-skill] Drive-Android/skills/${name} not found; keeping desktop/skills/${name}`); continue }
  fs.mkdirSync(to, { recursive: true })
  for (const f of fs.readdirSync(from).filter(n => !n.startsWith('.') && fs.statSync(path.join(from, n)).isFile())) fs.copyFileSync(path.join(from, f), path.join(to, f))
  console.log(`[copy-skill] ${from} → ${to}`)
}
