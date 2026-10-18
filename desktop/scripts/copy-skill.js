// The tetra-calendar skill's one source is Drive-Android's skills/tetra-calendar; this copies it here before a build
// (npm start / dist), so Calendar › Share with Claude hands over the skill matching the app. No source found: the copy
// already committed in desktop/skills stays.
const fs = require('node:fs')
const path = require('node:path')
const to = path.join(__dirname, '..', 'skills', 'tetra-calendar')
const coding = path.resolve(__dirname, '..', '..', '..') // …/Coding (the Drive repo or a worktree of it sits here)
const from = [process.env.TETRA_SKILL_SRC, path.join(coding, 'Drive-Android', 'skills', 'tetra-calendar'),
  path.join(coding, '..', 'Drive-Android', 'skills', 'tetra-calendar'), path.join(coding, '..', 'Drive-Android-worktrees', 'calendar', 'skills', 'tetra-calendar')]
  .filter(Boolean).find(d => fs.existsSync(path.join(d, 'SKILL.md')))
if (!from) { console.warn('[copy-skill] Drive-Android/skills/tetra-calendar not found; keeping desktop/skills/tetra-calendar'); process.exit(0) }
fs.mkdirSync(to, { recursive: true })
for (const f of ['SKILL.md', 'tetra_calendar.py']) fs.copyFileSync(path.join(from, f), path.join(to, f))
console.log(`[copy-skill] ${from} → ${to}`)
