// The AppImage's build: package.json's, with the map builder's Java and Python inside (scripts/bundle-tools.sh makes
// bundled/); the .deb has none of it, apt brings them (build.deb.depends).
const base = require('./package.json').build
module.exports = { ...base, extraResources: [...(base.extraResources ?? []), { from: 'bundled', to: 'bundled' }] }
