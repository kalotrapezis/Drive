// The AppImage's build: package.json's, with the map builder's Java and Python inside (scripts/bundle-tools.sh makes
// bundled/); the .deb has none of it, apt brings them (build.deb.depends). The static AppImage runtime (toolset 1.0.3)
// needs no libfuse2, which Ubuntu 24.04 and Fedora no longer install.
const base = require('./package.json').build
module.exports = { ...base, toolsets: { appimage: '1.0.3' }, extraResources: [...(base.extraResources ?? []), { from: 'bundled', to: 'bundled' }] }
