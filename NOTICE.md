# Notices

NaviStation5 source is distributed under GPL-3.0-or-later; see LICENSE.

Native credential and SDK attribute conventions derive from John Törnblom's
ps5-payload-sdk (GPL-3.0-or-later), as noted in the corresponding source files.
The SDK is an external build dependency and is not vendored in this repository.
Hermes, esbuild and Babel are external build dependencies with their own licenses.

Firmware profiles describe interoperability checks and observed interfaces. They
do not include complete Sony system modules, extracted application bytecode,
firmware dumps or decompiled application implementations. Native compatibility
guards contain short machine-code fingerprints from the supported firmware;
these are identification data, not code licensed by this project.
The inspection JSON describes NaviStation5's own compiled bootstrap stub.

PlayStation and PS5 are trademarks of Sony Interactive Entertainment. Navidrome
is a separate project. No endorsement or affiliation is implied.

Screenshots in `docs/images` illustrate NaviStation5 on a console. Album artwork,
game imagery and the surrounding system UI retain their respective owners’
rights and are not covered by the source code’s GPL license.
