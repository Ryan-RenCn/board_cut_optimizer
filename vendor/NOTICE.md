# Bundled geometry libraries

These are local, offline browser-compatible copies. No CDN is used at runtime.

| Module | Upstream package | License |
| --- | --- | --- |
| `clipper.mjs` | `clipper-lib@6.4.2` (internal version 6.4.2.2), https://github.com/junmer/clipper-lib | Boost Software License 1.0; bundled JSBN retains its Tom Wu license |
| `earcut.mjs` | `earcut@3.0.2`, https://github.com/mapbox/earcut | ISC |
| `dxf-parser.mjs` | `dxf-parser@1.1.2`, https://github.com/gdsestimating/dxf-parser | MIT (bundle retains its dependencies' notices) |

Clipper's original source and notices are retained. The only wrapper change is a local CommonJS export object plus an ES module default export, so the same file loads in Node and the browser without globals.

Earcut source is copied from the package's `src/earcut.js` without algorithm changes. Full licenses are included beside these files.

Package SHA-1 identities recorded by npm:

- clipper-lib 6.4.2: `f2444d87913aaea8312f9e26421b0843f4149e87`
- earcut 3.0.2: `d478a29aaf99acf418151493048aa197d0512248`
- dxf-parser 1.1.2: `0b3ba561cd84b5945bee17403e235599bee8c50b`

These libraries are independent of Solid Edge. No Siemens/Solid Edge binary or license component is distributed with this application.

The dxf-parser bundle includes loglevel 1.7.1 (MIT); its license is preserved in dxf-parser-loglevel-LICENSE.txt.
