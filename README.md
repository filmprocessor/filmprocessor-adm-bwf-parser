# FilmProcessor ADM/BWF Parser

Parse RIFF/RF64 PCM audio and selected Audio Definition Model metadata.

Browser-first ES module with no runtime dependencies. Plain PCM parsing also
works in Node.js 20+. ADM XML requires a browser-compatible DOMParser.

## Use

Clone this repository and import `src/index.js`. This package is not published to
npm yet.

```js
import { parseADMBWF, probeADMBWF } from './src/index.js';

const bytes = await file.arrayBuffer();
console.log(probeADMBWF(bytes));
const { format, channelData, duration, adm } = parseADMBWF(bytes);
// channelData is an array of normalized, deinterleaved Float32Arrays.
```

`parseADMBWF(arrayBuffer, { DOMParser } = {})` uses `globalThis.DOMParser` by
default. In Node, inject a compatible implementation with `querySelector`,
`getElementsByTagName`, `getElementsByTagNameNS` and browser XML error behavior.
No DOM implementation is bundled. PCM files without `axml` need no DOM.

`probeADMBWF(arrayBuffer)` checks for the `axml` chunk without decoding PCM.
It can inspect a partial buffer, but `hasADM: false` from a prefix cannot prove
that a later chunk is absent. Invalid input returns an empty probe result.

## Scope

- RIFF and RF64 (`ds64` data size) containers.
- Signed 16/24/32-bit PCM and 32-bit IEEE float, including their standard
  WAVE_FORMAT_EXTENSIBLE subtypes and speaker masks.
- ADM programme, bed and object metadata, positions and timing blocks.
- `chna` track UID mappings take precedence over inferred channel positions.

This is a selected ADM reader, not a full ADM validator or renderer. It does not
write BWF, decode compressed WAV codecs or implement every RF64 size-table case.
The parser reads the entire file and allocates PCM arrays: applications should
set file-size limits before calling it. Integer PCM maps the negative full-scale
sample to -1; positive full scale is just below +1. Float PCM is preserved.
Truncated chunks and unsupported PCM formats are rejected. Malformed XML yields
`adm: null` through a browser DOMParser; missing DOM support throws explicitly.

## Examples and tests

Run `npm test`. Tests generate PCM/RF64 fixtures and verify channel separation,
integer/float subtypes, normalization, malformed chunks and `chna` mapping.
Serve the repository with `python3 -m http.server 8080` and open
`examples/inspect.html` to inspect a local file without uploading it or playing
sound. The demo limits inputs to 64 MiB; it is not a feature-length file viewer.

## Browser regression

Run `npm ci`, `npx playwright install chromium`, then `npm run test:browser`.
The Chromium harness is headless and muted. It serves only an explicit list of
example files on loopback and uploads no media.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.

## Licence history

Version 0.2.0 adopts Apache License 2.0 for this project. Earlier published
versions through 0.1.0 retain their MIT licence. Third-party dependencies
retain their own licences. See `LICENSE` and `NOTICE`.
