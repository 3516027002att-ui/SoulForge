# Supplemental dependency notices

The Windows and Linux packaging profiles copy this directory unchanged. The
product remains Apache-2.0; a dependency's license text does not relicense the
first-party source.

`sharp-libvips-1.2.4-NOTICES.txt` preserves the official pinned upstream table
for the installed `@img/sharp-libvips` 1.2.4 platform binaries. Their component
versions are retained in each package's `versions.json`. The corresponding
libvips 8.17.3 LGPL text and the GNU LGPLv3/GPLv3 texts are included here, because
the upstream table selects LGPLv3 under the any-later-version clause.

The notice and license bodies are copied without changes from:

- https://github.com/lovell/sharp-libvips/blob/20b5e899954907a3039d6e3d4c200aaa0ec52c4c/THIRD-PARTY-NOTICES.md
  (Git blob `7b794812a9a32a2f4b7c1535c9b89a90b613dd7f`)
- https://github.com/libvips/libvips/blob/0c9151a4f416d2f8ae20a755db218f6637050eec/LICENSE
  (Git blob `4362b49151d7b34ef83b3067a8f9c9f877d72a0e`)
- https://github.com/gcc-mirror/gcc/blob/releases/gcc-15.2.0/COPYING3.LIB
  (Git blob `fc8a5de7edf437cdc98a216370faf7c757279bcb`)
- https://github.com/gcc-mirror/gcc/blob/releases/gcc-15.2.0/COPYING3
  (Git blob `94a9ed024d3859793618152ea559a168bbcbb5e2`)

These files do not attest all component-specific notices, matching source,
relinking/replacement support or distribution compliance. The existing release
inventory remains partial and keeps these packages marked metadata-only until
that broader evidence is complete. The Apache license for the sharp-libvips
build scripts does not replace the licenses of the bundled native libraries.

`lazy-val` 1.0.5 declares MIT and author Vladimir Krivosheev in its installed
package metadata. Its package and upstream tree provide no separate license or
copyright notice. No copyright year or substitute attribution is invented here;
this remains a notice gap in the inventory.

The self-contained Bridge's actual runtime license and notices are selected at
publish time and copied separately under `bridge/runtime-notices`. If a separate
Doctor or Launcher is distributed, its runtime notices need their own matching
artifact check. The desktop profiles currently ship neither executable.
