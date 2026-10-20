/**
 * ADM BWF Parser — ITU-R BS.2076 Audio Definition Model parser for BWF/WAV files
 *
 * Parses RIFF/RF64 WAV containers to extract:
 *   - PCM audio data (16-bit, 24-bit, 32-bit float) deinterleaved per channel
 *   - ADM metadata from the axml chunk (programmes, beds, objects with position timelines)
 *
 * Open standard — no proprietary codecs or licences required.
 *
 * @module adm-bwf-parser
 */

// ─── Speaker label map: ADM common definition labels → short labels ──────────
const SPEAKER_LABEL_MAP = {
  'RC_L': 'L', 'RC_R': 'R', 'RC_C': 'C', 'RC_LFE': 'LFE',
  'RC_Ls': 'Ls', 'RC_Rs': 'Rs', 'RC_Lrs': 'Lrs', 'RC_Rrs': 'Rrs',
  'RC_Lss': 'Lss', 'RC_Rss': 'Rss',
  'RC_Lw': 'Lw', 'RC_Rw': 'Rw',
  'RC_LFE2': 'LFE2',
  // Height / top layer
  'RC_Ltf': 'Ltf', 'RC_Rtf': 'Rtf', 'RC_Ltb': 'Ltb', 'RC_Rtb': 'Rtb',
  'RC_Ltm': 'Ltm', 'RC_Rtm': 'Rtm', 'RC_Ts': 'Ts',
  // Alternative naming conventions. ITU-R BS.2051's 7.1 (0+7+0) puts its
  // side pair at M±090 and its rear pair at M±135.
  'M+030': 'L', 'M-030': 'R', 'M+000': 'C', 'LFE1': 'LFE',
  'M+110': 'Ls', 'M-110': 'Rs', 'M+090': 'Lss', 'M-090': 'Rss', 'M+135': 'Lrs', 'M-135': 'Rrs',
  'U+030': 'Ltf', 'U-030': 'Rtf', 'U+110': 'Ltr', 'U-110': 'Rtr',
  'U+045': 'Ltf', 'U-045': 'Rtf', 'U+135': 'Ltb', 'U-135': 'Rtb',
  'T+000': 'Ts',
};

// ─── RIFF chunk walker ──────────────────────────────────────────────────────

/**
 * Walk RIFF/RF64 container and return a map of chunk offsets + sizes.
 * @param {ArrayBuffer} buffer — raw file bytes
 * @returns {{ chunks: Map<string, {offset: number, size: number}[]>, isRF64: boolean }}
 */
function walkChunks(buffer, allowPartial = false) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 12) throw new TypeError("Expected a complete RIFF/RF64 header");
  const view = new DataView(buffer);
  const fourCC = readFourCC(view, 0);
  const isRF64 = fourCC === 'RF64';

  if (fourCC !== 'RIFF' && fourCC !== 'RF64') {
    throw new Error(`Not a RIFF/RF64 file (got "${fourCC}")`);
  }

  const waveCC = readFourCC(view, 8);
  if (waveCC !== 'WAVE') {
    throw new Error(`Not a WAVE file (got "${waveCC}")`);
  }

  // For RF64, the RIFF size field is 0xFFFFFFFF; actual sizes are in ds64 chunk
  let ds64DataSize = null;
  let ds64RiffSize = null;

  const chunks = new Map();
  let pos = 12; // past RIFF/RF64 header + "WAVE"

  while (pos + 8 <= buffer.byteLength) {
    const chunkId = readFourCC(view, pos);
    let chunkSize = view.getUint32(pos + 4, true);
    const dataOffset = pos + 8;

    if (dataOffset + chunkSize > buffer.byteLength && !(isRF64 && chunkId === 'data' && chunkSize === 0xffffffff)) {
      if (!allowPartial) throw new Error('Truncated WAV chunk');
      if (chunkId !== 'data' && chunkId !== 'axml') break;
    }
    // For RF64 ds64 chunk — read 64-bit sizes
    if (isRF64 && chunkId === 'ds64') {
      if (chunkSize < 28 || dataOffset + 28 > buffer.byteLength) throw new Error('Invalid ds64 chunk');
      ds64RiffSize = view.getBigUint64(dataOffset, true);
      ds64DataSize = view.getBigUint64(dataOffset + 8, true);
    }

    // Override data chunk size from ds64 if RF64
    if (isRF64 && chunkId === 'data' && ds64DataSize !== null) {
      if (ds64DataSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('RF64 size exceeds safe integer range');
      chunkSize = Number(ds64DataSize);
    }

    if (!allowPartial && dataOffset + chunkSize > buffer.byteLength) throw new Error('Truncated WAV chunk');
    if (!chunks.has(chunkId)) chunks.set(chunkId, []);
    chunks.get(chunkId).push({ offset: dataOffset, size: chunkSize });

    // Advance: chunk header (8) + data (padded to even)
    pos = dataOffset + chunkSize + (chunkSize % 2);

    // Even a zero-length chunk advances by its eight-byte header.
  }

  return { chunks, isRF64 };
}

function readFourCC(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

// ─── Format chunk parsing ───────────────────────────────────────────────────

/**
 * Parse the fmt chunk.
 * @param {DataView} view
 * @param {number} offset — start of fmt chunk data
 * @param {number} [size] — fmt chunk data size; WAVE_FORMAT_EXTENSIBLE needs 24+ bytes for its mask
 * @returns {{ audioFormat: number, channelCount: number, sampleRate: number, bitsPerSample: number, blockAlign: number, channelMask: number }}
 */
function parseFmtChunk(view, offset, size = 16) {
  if (size < 16 || offset + size > view.byteLength) throw new Error('Invalid fmt chunk');
  let audioFormat = view.getUint16(offset, true);  // 1=PCM, 3=IEEE float, 0xFFFE=extensible
  const extensible = audioFormat === 0xfffe;
  if (extensible) {
    if (size < 40 || view.getUint16(offset + 16, true) < 22) throw new Error('Invalid extensible fmt chunk');
    const tail = [0,0,0,0,16,0,128,0,0,170,0,56,155,113];
    if (tail.some((v,i) => view.getUint8(offset+26+i) !== v)) throw new Error('Unsupported WAV subtype');
    audioFormat = view.getUint16(offset + 24, true);
  }
  return {
    audioFormat,
    channelCount: view.getUint16(offset + 2, true),
    sampleRate: view.getUint32(offset + 4, true),
    byteRate: view.getUint32(offset + 8, true),
    blockAlign: view.getUint16(offset + 12, true),
    bitsPerSample: view.getUint16(offset + 14, true),
    // The extensible speaker mask names each channel's position; 0 when absent.
    channelMask: extensible && size >= 24 && offset + 24 <= view.byteLength
      ? view.getUint32(offset + 20, true)
      : 0,
  };
}

// ─── PCM extraction ─────────────────────────────────────────────────────────

/**
 * Deinterleave PCM data into per-channel Float32Arrays.
 * Supports 16-bit PCM, 24-bit PCM, 32-bit float, and WAVE_FORMAT_EXTENSIBLE.
 *
 * @param {ArrayBuffer} buffer — full file buffer
 * @param {{ offset: number, size: number }} dataChunk
 * @param {{ audioFormat: number, channelCount: number, sampleRate: number, bitsPerSample: number }} fmt
 * @returns {Float32Array[]} — one Float32Array per channel
 */
function extractPCM(buffer, dataChunk, fmt) {
  const view = new DataView(buffer);
  const { channelCount, bitsPerSample, audioFormat } = fmt;
  const bytesPerSample = bitsPerSample / 8;
  if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > 64 || !Number.isInteger(fmt.sampleRate) || fmt.sampleRate <= 0 || !([16,24,32].includes(bitsPerSample) && audioFormat === 1 || bitsPerSample === 32 && audioFormat === 3)) throw new Error('Unsupported PCM format');
  if (fmt.blockAlign !== channelCount * bytesPerSample || dataChunk.size % fmt.blockAlign !== 0 || dataChunk.offset + dataChunk.size > buffer.byteLength) throw new Error('Invalid PCM extent');
  const frameCount = Math.floor(dataChunk.size / (channelCount * bytesPerSample));

  // Allocate output arrays
  const channels = [];
  for (let ch = 0; ch < channelCount; ch++) {
    channels.push(new Float32Array(frameCount));
  }

  const isFloat = audioFormat === 3;
  let pos = dataChunk.offset;

  for (let i = 0; i < frameCount; i++) {
    for (let ch = 0; ch < channelCount; ch++) {
      let sample;

      if (isFloat && bitsPerSample === 32) {
        // 32-bit IEEE float — direct read
        sample = view.getFloat32(pos, true);
      } else if (bitsPerSample === 24) {
        // 24-bit signed integer — 3-byte little-endian, sign-extend, normalise
        const b0 = view.getUint8(pos);
        const b1 = view.getUint8(pos + 1);
        const b2 = view.getUint8(pos + 2);
        let intSample = b0 | (b1 << 8) | (b2 << 16);
        if (intSample & 0x800000) intSample |= ~0xFFFFFF; // sign extend
        sample = intSample / 0x800000;
      } else if (bitsPerSample === 16) {
        // 16-bit signed integer
        sample = view.getInt16(pos, true) / 0x8000;
      } else if (bitsPerSample === 32 && !isFloat) {
        // 32-bit signed integer (rare but possible)
        sample = view.getInt32(pos, true) / 0x80000000;
      } else {
        sample = 0;
      }

      channels[ch][i] = sample;
      pos += bytesPerSample;
    }
  }

  return channels;
}

// ─── ADM XML parser ─────────────────────────────────────────────────────────

/**
 * Parse the ADM axml chunk into a structured document.
 *
 * @param {ArrayBuffer} buffer — full file buffer
 * @param {{ offset: number, size: number }} axmlChunk
 * @returns {object|null} — parsed ADM structure or null if empty/invalid
 */
function parseADMXml(buffer, axmlChunk, chnaTrackIndexByUid = new Map(), Parser = globalThis.DOMParser) {
  const decoder = new TextDecoder('utf-8');
  const bytes = new Uint8Array(buffer, axmlChunk.offset, axmlChunk.size);

  // Trim null bytes from end (common in BWF axml chunks)
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  const xmlString = decoder.decode(bytes.subarray(0, end));

  if (!xmlString.trim()) return null;

  if (typeof Parser !== "function") throw new Error("ADM XML requires a DOMParser with querySelector support; pass { DOMParser } in options.");
  const parser = new Parser();
  const doc = parser.parseFromString(xmlString, 'application/xml');

  // Check for parse errors
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    console.warn('ADM XML parse error:', parseError.textContent);
    return null;
  }

  // ── Extract elements (namespace-aware: try with and without namespace) ──
  const root = doc.documentElement;
  const ns = root.namespaceURI || '';

  function query(parent, localName) {
    // Try namespace query first, then fallback to non-namespace
    let results = parent.getElementsByTagNameNS(ns, localName);
    if (results.length === 0) {
      results = parent.getElementsByTagName(localName);
    }
    return Array.from(results);
  }

  function attr(el, name) {
    return el?.getAttribute(name) || '';
  }

  // ── audioProgramme ──
  const programmeEls = query(root, 'audioProgramme');
  const programme = programmeEls.length > 0 ? {
    id: attr(programmeEls[0], 'audioProgrammeID'),
    name: attr(programmeEls[0], 'audioProgrammeName'),
    contentRefs: query(programmeEls[0], 'audioContentIDRef').map(el => el.textContent.trim()),
  } : { id: '', name: 'Unknown Programme', contentRefs: [] };

  // ── audioContent ──
  const contentMap = new Map();
  for (const el of query(root, 'audioContent')) {
    contentMap.set(attr(el, 'audioContentID'), {
      id: attr(el, 'audioContentID'),
      name: attr(el, 'audioContentName'),
      objectRefs: query(el, 'audioObjectIDRef').map(e => e.textContent.trim()),
    });
  }

  // ── audioObject ──
  const objectMap = new Map();
  for (const el of query(root, 'audioObject')) {
    const startStr = attr(el, 'start');
    const durationStr = attr(el, 'duration');
    objectMap.set(attr(el, 'audioObjectID'), {
      id: attr(el, 'audioObjectID'),
      name: attr(el, 'audioObjectName'),
      start: parseADMTime(startStr),
      duration: parseADMTime(durationStr),
      packFormatRefs: query(el, 'audioPackFormatIDRef').map(e => e.textContent.trim()),
      trackUIDRefs: query(el, 'audioTrackUIDRef').map(e => e.textContent.trim()),
    });
  }

  // ── audioPackFormat ──
  const packMap = new Map();
  for (const el of query(root, 'audioPackFormat')) {
    const typeLabel = attr(el, 'typeLabel') || attr(el, 'typeDefinition');
    packMap.set(attr(el, 'audioPackFormatID'), {
      id: attr(el, 'audioPackFormatID'),
      type: resolveTypeDefinition(typeLabel),
      channelFormatRefs: query(el, 'audioChannelFormatIDRef').map(e => e.textContent.trim()),
    });
  }

  // ── audioChannelFormat (contains audioBlockFormat with positions) ──
  const channelFormatMap = new Map();
  for (const el of query(root, 'audioChannelFormat')) {
    const typeLabel = attr(el, 'typeLabel') || attr(el, 'typeDefinition');
    const blocks = [];

    for (const blockEl of query(el, 'audioBlockFormat')) {
      const block = parseBlockFormat(blockEl, ns);
      blocks.push(block);
    }

    // Sort blocks by rtime for correct playback ordering
    blocks.sort((a, b) => a.rtime - b.rtime);

    channelFormatMap.set(attr(el, 'audioChannelFormatID'), {
      id: attr(el, 'audioChannelFormatID'),
      name: attr(el, 'audioChannelFormatName') || '',
      type: resolveTypeDefinition(typeLabel),
      blocks,
    });
  }

  // ── audioTrackUID → maps track to audioChannelFormat ──
  const trackUIDMap = new Map();
  for (const el of query(root, 'audioTrackUID')) {
    const uid = attr(el, 'UID');
    const channelFormatRef = query(el, 'audioChannelFormatIDRef')[0]?.textContent?.trim() || '';
    const trackFormatRef = query(el, 'audioTrackFormatIDRef')[0]?.textContent?.trim() || '';
    const packFormatRef = query(el, 'audioPackFormatIDRef')[0]?.textContent?.trim() || '';

    const pcmChannel = chnaTrackIndexByUid.get(normalizeAdmId(uid)) ?? parseTrackUIDIndex(uid);

    trackUIDMap.set(uid, {
      uid,
      pcmChannel,
      channelFormatRef,
      trackFormatRef,
      packFormatRef,
    });
  }

  // ── Build beds and objects ──
  const beds = [];
  const objects = [];

  for (const obj of objectMap.values()) {
    // Resolve pack format to determine type (DirectSpeakers vs Objects)
    let type = 'Objects';
    const packIds = obj.packFormatRefs;

    for (const packId of packIds) {
      const pack = packMap.get(packId);
      if (pack) {
        type = pack.type;
        break;
      }
    }

    // For each trackUID ref, resolve the channel format
    for (const trackUIDRef of obj.trackUIDRefs) {
      const trackUID = trackUIDMap.get(trackUIDRef);
      if (!trackUID) continue;

      const channelFormat = channelFormatMap.get(trackUID.channelFormatRef);

      if (type === 'DirectSpeakers') {
        // Bed channel — extract speaker label from blocks
        let speakerLabel = '';
        if (channelFormat && channelFormat.blocks.length > 0) {
          speakerLabel = channelFormat.blocks[0].speakerLabel || '';
        }
        // Also try from channel format name
        if (!speakerLabel && channelFormat) {
          speakerLabel = channelFormat.name;
        }

        const shortLabel = SPEAKER_LABEL_MAP[speakerLabel] || speakerLabel || `Ch${trackUID.pcmChannel}`;

        beds.push({
          label: shortLabel,
          speakerLabel,
          pcmChannel: trackUID.pcmChannel,
          objectName: obj.name,
        });
      } else {
        // Spatial object
        objects.push({
          id: obj.id,
          name: obj.name,
          pcmChannel: trackUID.pcmChannel,
          start: obj.start,
          duration: obj.duration,
          blocks: channelFormat ? channelFormat.blocks : [],
        });
      }
    }
  }

  sortBedsByChannelOrder(beds);

  return {
    programme: { name: programme.name, duration: null },
    beds,
    objects,
  };
}

// ─── ADM helper functions ───────────────────────────────────────────────────

// Beds are listed in the cinema order: 7.1's side pair before its rear pair
// (L R C LFE Lss Rss Lrs Rrs), as every 7.1 in FilmProcessor is laid out.
// Unknown labels go last.
const BED_CHANNEL_ORDER = ['L', 'R', 'C', 'LFE', 'Ls', 'Rs', 'Lss', 'Rss', 'Lrs', 'Rrs', 'Lw', 'Rw', 'Ltf', 'Rtf', 'Ltb', 'Rtb', 'Ltm', 'Rtm', 'Ts'];

function sortBedsByChannelOrder(beds) {
  const rank = (label) => {
    const index = BED_CHANNEL_ORDER.indexOf(label);
    return index === -1 ? BED_CHANNEL_ORDER.length : index;
  };
  return beds.sort((a, b) => rank(a.label) - rank(b.label));
}

/**
 * Parse an audioBlockFormat element.
 */
function parseBlockFormat(blockEl, ns) {
  const rtime = parseADMTime(blockEl.getAttribute('rtime') || '');
  const duration = parseADMTime(blockEl.getAttribute('duration') || '');

  // Position elements
  let azimuth = 0, elevation = 0, distance = 1;
  let speakerLabel = '';

  // Try <position> elements
  const posEls = blockEl.getElementsByTagNameNS(ns, 'position');
  const posFallback = posEls.length === 0 ? blockEl.getElementsByTagName('position') : posEls;

  for (const posEl of posFallback) {
    const coord = posEl.getAttribute('coordinate') || '';
    const value = parseFloat(posEl.textContent);
    if (coord === 'azimuth') azimuth = value;
    else if (coord === 'elevation') elevation = value;
    else if (coord === 'distance') distance = value;
  }

  // Speaker label for DirectSpeakers type
  const labelEls = blockEl.getElementsByTagNameNS(ns, 'speakerLabel');
  const labelFallback = labelEls.length === 0 ? blockEl.getElementsByTagName('speakerLabel') : labelEls;
  if (labelFallback.length > 0) {
    speakerLabel = labelFallback[0].textContent.trim();
  }

  // Gain attribute
  const gainEl = blockEl.getElementsByTagNameNS(ns, 'gain');
  const gainFallback = gainEl.length === 0 ? blockEl.getElementsByTagName('gain') : gainEl;
  let gain = 1.0;
  if (gainFallback.length > 0) {
    gain = parseFloat(gainFallback[0].textContent) || 1.0;
  }

  return { rtime, duration, azimuth, elevation, distance, gain, speakerLabel };
}

/**
 * Parse ADM timecode string to seconds.
 * Formats: "HH:MM:SS.SSSSS" or "HH:MM:SS.SSSSSSnnn" (with nanoseconds)
 */
function parseADMTime(str) {
  if (!str || str === '') return 0;

  // Handle fractional seconds format: HH:MM:SS.SSSSS or SS.SSSSS
  const match = str.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (match) {
    const hours = parseInt(match[1] || '0', 10);
    const minutes = parseInt(match[2], 10);
    const seconds = parseFloat(match[3]);
    return hours * 3600 + minutes * 60 + seconds;
  }

  // Handle simple fractional seconds: "1.5" or "0.04"
  const simple = parseFloat(str);
  if (!isNaN(simple)) return simple;

  return 0;
}

/**
 * Derive PCM channel index from audioTrackUID value.
 * ATU_00000001 → 0, ATU_00000002 → 1, etc.
 */
function parseTrackUIDIndex(uid) {
  const match = uid.match(/ATU_(\d+)/);
  if (match) return parseInt(match[1], 10) - 1; // 1-based → 0-based
  return 0;
}

function normalizeAdmId(id) {
  return String(id || '').trim().toUpperCase();
}

function readNullTerminatedAscii(bytes, offset, length) {
  let end = offset;
  const limit = Math.min(bytes.length, offset + length);
  while (end < limit && bytes[end] !== 0) end++;
  return String.fromCharCode(...bytes.subarray(offset, end)).trim();
}

function parseChnaChunk(buffer, chnaChunk) {
  if (!chnaChunk || chnaChunk.size < 4) return new Map();

  const view = new DataView(buffer, chnaChunk.offset, chnaChunk.size);
  const bytes = new Uint8Array(buffer, chnaChunk.offset, chnaChunk.size);
  const uidCount = view.getUint16(2, true);
  const trackIndexByUid = new Map();
  const entrySize = 40;
  let offset = 4;

  for (let index = 0; index < uidCount && offset + entrySize <= bytes.length; index += 1) {
    const trackIndex = view.getUint16(offset, true);
    const uid = readNullTerminatedAscii(bytes, offset + 2, 12);
    if (trackIndex > 0 && uid) {
      trackIndexByUid.set(normalizeAdmId(uid), trackIndex - 1);
    }
    offset += entrySize;
  }

  return trackIndexByUid;
}

/**
 * Resolve ADM type definition to a standard string.
 */
function resolveTypeDefinition(typeStr) {
  if (!typeStr) return 'Objects';
  const lower = typeStr.toLowerCase();
  if (lower.includes('directspeaker') || lower === '0001') return 'DirectSpeakers';
  if (lower.includes('object') || lower === '0002') return 'Objects';
  if (lower.includes('hoa') || lower === '0003') return 'HOA';
  if (lower.includes('matrix') || lower === '0004') return 'Matrix';
  if (lower.includes('binaural') || lower === '0005') return 'Binaural';
  return 'Objects';
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Parse an ADM BWF or standard WAV file.
 *
 * @param {ArrayBuffer} arrayBuffer — raw file bytes
 * @returns {{
 *   format: { sampleRate: number, bitDepth: number, channelCount: number, audioFormat: number, channelMask: number },
 *   channelData: Float32Array[],
 *   duration: number,
 *   adm: {
 *     programme: { name: string, duration: number|null },
 *     beds: Array<{ label: string, speakerLabel: string, pcmChannel: number, objectName: string }>,
 *     objects: Array<{ id: string, name: string, pcmChannel: number, start: number, duration: number,
 *       blocks: Array<{ rtime: number, duration: number, azimuth: number, elevation: number, distance: number, gain: number }>
 *     }>
 *   } | null
 * }}
 */
export function parseADMBWF(arrayBuffer, { DOMParser = globalThis.DOMParser } = {}) {
  const { chunks } = walkChunks(arrayBuffer);

  // ── fmt chunk (required) ──
  const fmtEntries = chunks.get('fmt ');
  if (!fmtEntries || fmtEntries.length === 0) {
    throw new Error('Missing fmt chunk in WAV file');
  }
  const fmt = parseFmtChunk(new DataView(arrayBuffer), fmtEntries[0].offset, fmtEntries[0].size);

  // ── data chunk (required) ──
  const dataEntries = chunks.get('data');
  if (!dataEntries || dataEntries.length === 0) {
    throw new Error('Missing data chunk in WAV file');
  }
  const dataChunk = dataEntries[0];

  // ── Extract PCM ──
  const channelData = extractPCM(arrayBuffer, dataChunk, fmt);
  const duration = channelData[0].length / fmt.sampleRate;

  // ── ADM metadata (optional) ──
  let adm = null;
  const axmlEntries = chunks.get('axml');
  if (axmlEntries && axmlEntries.length > 0) {
    const chnaTrackIndexByUid = parseChnaChunk(arrayBuffer, chunks.get('chna')?.[0]);
    adm = parseADMXml(arrayBuffer, axmlEntries[0], chnaTrackIndexByUid, DOMParser);
    if (adm && adm.programme) {
      adm.programme.duration = duration;
    }
  }

  return {
    format: {
      sampleRate: fmt.sampleRate,
      bitDepth: fmt.bitsPerSample,
      channelCount: fmt.channelCount,
      audioFormat: fmt.audioFormat,
      channelMask: fmt.channelMask,
    },
    channelData,
    duration,
    adm,
  };
}

/**
 * Quick check if a file is a WAV/BWF with ADM metadata,
 * without fully parsing the PCM data.
 *
 * @param {ArrayBuffer} arrayBuffer — raw file bytes (only first few KB needed)
 * @returns {{ hasADM: boolean, channelCount: number, sampleRate: number, bitDepth: number }}
 */
export function probeADMBWF(arrayBuffer) {
  try {
    const { chunks } = walkChunks(arrayBuffer, true);

    const fmtEntries = chunks.get('fmt ');
    if (!fmtEntries) return { hasADM: false, channelCount: 0, sampleRate: 0, bitDepth: 0 };

    const fmt = parseFmtChunk(new DataView(arrayBuffer), fmtEntries[0].offset, fmtEntries[0].size);
    const hasADM = chunks.has('axml');

    return {
      hasADM,
      channelCount: fmt.channelCount,
      sampleRate: fmt.sampleRate,
      bitDepth: fmt.bitsPerSample,
    };
  } catch {
    return { hasADM: false, channelCount: 0, sampleRate: 0, bitDepth: 0 };
  }
}
