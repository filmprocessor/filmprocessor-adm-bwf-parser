import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const ADM_BWF_SOURCE = readFileSync(
  new URL("../src/index.js", import.meta.url),
  "utf8",
);

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} was not found`);

  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `${name} body was not found`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }

  throw new Error(`${name} body was not closed`);
}

function writeAscii(bytes, offset, length, value) {
  const text = value.padEnd(length, "\0").slice(0, length);
  for (let index = 0; index < length; index += 1) {
    bytes[offset + index] = text.charCodeAt(index);
  }
}

function createChnaBuffer(entries) {
  const entrySize = 40;
  const buffer = new ArrayBuffer(4 + entries.length * entrySize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setUint16(0, entries.length, true);
  view.setUint16(2, entries.length, true);

  entries.forEach((entry, index) => {
    const offset = 4 + index * entrySize;
    view.setUint16(offset, entry.trackIndex, true);
    writeAscii(bytes, offset + 2, 12, entry.uid);
    writeAscii(bytes, offset + 14, 14, entry.trackFormatId || "AT_00010001");
    writeAscii(bytes, offset + 28, 11, entry.packFormatId || "AP_00010001");
  });

  return buffer;
}

function createSandbox() {
  const sandbox = {
    DataView,
    Map,
    String,
    Uint8Array,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `
      ${extractFunction(ADM_BWF_SOURCE, "normalizeAdmId")}
      ${extractFunction(ADM_BWF_SOURCE, "readNullTerminatedAscii")}
      ${extractFunction(ADM_BWF_SOURCE, "parseChnaChunk")}
      globalThis.normalizeAdmId = normalizeAdmId;
      globalThis.parseChnaChunk = parseChnaChunk;
    `,
    sandbox,
  );
  return sandbox;
}

test("ADM BWF parser reads authoritative PCM channel indexes from chna", () => {
  const sandbox = createSandbox();
  const buffer = createChnaBuffer([
    { trackIndex: 4, uid: "ATU_00000002" },
    { trackIndex: 1, uid: "ATU_00000001" },
  ]);

  const map = sandbox.parseChnaChunk(buffer, { offset: 0, size: buffer.byteLength });

  assert.equal(map.get(sandbox.normalizeAdmId("atu_00000002")), 3);
  assert.equal(map.get(sandbox.normalizeAdmId("ATU_00000001")), 0);
});

function extractConst(source, name) {
  const start = source.indexOf(`const ${name} = `);
  assert.notEqual(start, -1, `${name} was not found`);
  const open = source.indexOf(source[source.indexOf("=", start) + 2], start);
  const close = source[open] === "{" ? "}" : "]";
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === source[open]) depth += 1;
    if (source[index] === close) depth -= 1;
    if (depth === 0) return source.slice(start, source.indexOf(";", index) + 1);
  }
  throw new Error(`${name} was not closed`);
}

// ITU-R BS.2051's 7.1 (0+7+0) names its side pair M±090 and its rear pair
// M±135; every 7.1 in FilmProcessor lists the side pair first.
test("an ADM 7.1 bed's side pair is the side pair, listed before the rear pair", () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    `
      ${extractConst(ADM_BWF_SOURCE, "SPEAKER_LABEL_MAP")}
      ${extractConst(ADM_BWF_SOURCE, "BED_CHANNEL_ORDER")}
      ${extractFunction(ADM_BWF_SOURCE, "sortBedsByChannelOrder")}
      globalThis.SPEAKER_LABEL_MAP = SPEAKER_LABEL_MAP;
      globalThis.sortBedsByChannelOrder = sortBedsByChannelOrder;
    `,
    sandbox,
  );
  const itu71 = ["M+030", "M-030", "M+000", "LFE1", "M+090", "M-090", "M+135", "M-135"];
  assert.deepEqual(itu71.map((label) => sandbox.SPEAKER_LABEL_MAP[label]), ["L", "R", "C", "LFE", "Lss", "Rss", "Lrs", "Rrs"]);
  assert.equal(sandbox.SPEAKER_LABEL_MAP["M+110"], "Ls", "5.1's surround pair keeps its own name");

  const beds = ["Rrs", "Lrs", "LFE", "Rss", "Lss", "C", "R", "L", "Mystery"].map((label, pcmChannel) => ({ label, pcmChannel }));
  assert.deepEqual(
    Array.from(sandbox.sortBedsByChannelOrder(beds), (bed) => bed.label),
    ["L", "R", "C", "LFE", "Lss", "Rss", "Lrs", "Rrs", "Mystery"],
  );
});
