# LibreDWG command-line converter

This directory distributes the independent, unmodified GNU LibreDWG 0.14
`dwg2dxf.exe` utility and its `libredwg-0.dll` runtime. The application invokes
the executable through command-line file input/output. No proprietary CAD
runtime is required. LibreDWG is GPL-3.0-or-later; see COPYING.txt.

Complete corresponding source and build instructions are included in
`libredwg-0.14.tar.xz` (README, INSTALL, configure and build scripts).
The original upstream Windows distribution is available at:
https://github.com/LibreDWG/libredwg/releases/tag/0.14

Verified upstream SHA256:

- libredwg-0.14-win64.zip: 1ad7e15344d20b3426c3435b078d82fb84b35062815946b2cca9c5fc9810fea8
- libredwg-0.14.tar.xz: 62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275

To replace the converter, replace the executable and matching runtime in this
directory; the application uses `dwg2dxf.exe -o output.dxf input.dwg`.
The bundled source archive also contains the circle DWG regression fixtures
used in tests/fixtures/dwg, under test/test-data/{2000,2007,2010,2018}/circle.dwg.
