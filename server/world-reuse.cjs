"use strict";

const {PART_SIZE, HEADER_SIZE, MAX_WORLD_SIZE} = require("./world-part.cjs");

const signature = Buffer.from("MWENGIE\0", "ascii");
const maxRanges = 8192;
const maxOps = 4096;
const recipeHeader = 24;
const literalSource = 0xffffffff;

function worldBuffer(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 24 || bytes.byteLength > MAX_WORLD_SIZE) return null;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return buffer.subarray(0, 8).equals(signature) ? buffer : null;
}

// Both documents have already passed the world codec. Walk their original wire
// bytes to retain the precise encodings and ordering used in the revision hash.
function eachRecord(buffer, version, visit) {
  const count = buffer.readUInt32LE(12);
  const fixed = version === 2 ? 126 : 118;
  if (count > 65536 || count * (fixed + 1) > buffer.length - 24) return false;
  let offset = 24;
  for (let i = 0; i < count; ++i) {
    if (offset + 18 > buffer.length) return false;
    const nameBytes = buffer[offset + 17];
    const length = fixed + nameBytes;
    if (!nameBytes || nameBytes > 95 || offset + length > buffer.length) return false;
    if (!visit(buffer.readBigUInt64LE(offset), offset, length)) return false;
    offset += length;
  }
  return offset === buffer.length;
}

function indexReuseRanges(originalBytes, starterBytes) {
  const full = worldBuffer(originalBytes), starter = worldBuffer(starterBytes);
  if (!full || !starter) return null;
  const version = full.readUInt32LE(8);
  if ((version !== 1 && version !== 2) || starter.readUInt32LE(8) !== version) return null;
  const byId = new Map();
  if (!eachRecord(starter, version, (id, start) => {
    if (byId.has(id)) return false;
    byId.set(id, start);
    return true;
  })) return null;

  const runs = [];
  const complete = eachRecord(full, version, (id, start, length) => {
    const source = byId.get(id);
    if (source === undefined || full[start + 17] !== starter[source + 17] ||
        full.compare(starter, source, source + length, start, start + length) !== 0) return true;
    const last = runs.length - 3;
    if (last >= 0 && runs[last] + runs[last + 2] === start && runs[last + 1] + runs[last + 2] === source) {
      runs[last + 2] += length;
    } else {
      if (runs.length === maxRanges * 3) return false;
      runs.push(start, source, length);
    }
    return true;
  });
  return complete && runs.length ? Uint32Array.from(runs) : null;
}

// The index belongs to the immutable pair of documents in the entry cache.
// Every operation appends to the output page in order. A literal's wire bytes
// start immediately after its descriptor, even when a COPY follows it.
function reusePage(full, ranges, offset) {
  if (!(full instanceof Uint8Array) || full.byteLength < 24 || full.byteLength > MAX_WORLD_SIZE ||
      !(ranges instanceof Uint32Array) || !ranges.length || ranges.length > 3 * maxRanges || ranges.length % 3 ||
      !Number.isSafeInteger(offset) || offset < 0 || offset >= full.byteLength || offset % PART_SIZE) return null;
  const end = Math.min(full.byteLength, offset + PART_SIZE);
  let low = 0, high = ranges.length / 3;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle * 3] + ranges[middle * 3 + 2] <= offset) low = middle + 1;
    else high = middle;
  }
  const ops = [];
  let cursor = offset, literalBytes = 0;
  for (let i = low * 3; i < ranges.length && ranges[i] < end; i += 3) {
    const start = Math.max(offset, ranges[i]);
    const stop = Math.min(end, ranges[i] + ranges[i + 2]);
    const source = ranges[i + 1] + (start - ranges[i]);
    if (start < cursor || start >= stop || ranges[i] + ranges[i + 2] > full.byteLength ||
        source + (stop - start) > MAX_WORLD_SIZE) return null;
    if (start > cursor) {
      ops.push(literalSource, start - cursor);
      literalBytes += start - cursor;
    }
    ops.push(source, stop - start);
    if (ops.length > 2 * maxOps) return null;
    cursor = stop;
  }
  if (!ops.length) return null;
  if (cursor < end) {
    ops.push(literalSource, end - cursor);
    literalBytes += end - cursor;
  }
  const logical = end - offset;
  const opCount = ops.length / 2;
  const wireBytes = recipeHeader + 8 * opCount + literalBytes;
  if (opCount > maxOps || wireBytes > HEADER_SIZE + logical - 32) return null;

  const frame = Buffer.allocUnsafe(wireBytes);
  frame.write("MWR1", 0, 4, "ascii");
  frame.writeUInt32LE(full.byteLength, 4);
  frame.writeUInt32LE(offset, 8);
  frame.writeUInt32LE(logical, 12);
  frame.writeUInt32LE(opCount, 16);
  frame.writeUInt32LE(literalBytes, 20);
  let write = recipeHeader, read = offset;
  for (let i = 0; i < ops.length; i += 2) {
    const source = ops[i], length = ops[i + 1];
    frame.writeUInt32LE(source, write);
    frame.writeUInt32LE(length, write + 4);
    write += 8;
    if (source === literalSource) {
      frame.set(full.subarray(read, read + length), write);
      write += length;
    }
    read += length;
  }
  return frame;
}

module.exports = {indexReuseRanges, reusePage};
