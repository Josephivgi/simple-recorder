"use strict";

// Rewrites a fragmented MP4 (what Chromium's MediaRecorder writes: one moov
// with no samples, then moof + mdat pairs) into a normal MP4: one moov at the
// front with full sample tables, then one mdat. No re-encode: the sample
// bytes are copied as they are, streamed from disk, so a long take never sits
// in memory. Upload sites (X among them) refuse or choke on fragmented files,
// and players seek in a normal one at once.
//
// Video timing is snapped to the frame grid when `fps` is given:
// MediaRecorder stamps each frame with its arrival time, so a 30 fps take
// comes out with 29 to 40 ms frames. Each frame moves to the nearest free slot
// on the 1/fps grid (never more than a slot from where it was), so the file
// has one steady frame rate. A frame the encoder dropped leaves the previous
// picture on screen for two slots, as it did before.
//
// remuxFaststart(src, dest, opts) writes dest and returns a summary. It
// throws on anything it does not understand, and the caller keeps the
// original file then. It never touches src.


const fsp = require("fs/promises");

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "mvex", "edts", "dinf"]);

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const { bytesRead } = await fh.read(buf, off, len - off, pos + off);
    if (!bytesRead) throw new Error("mp4: short read at " + (pos + off));
    off += bytesRead;
  }
  return buf;
}

// Top-level boxes, headers only.
async function topLevelBoxes(fh, fileSize) {
  const boxes = [];
  let pos = 0;
  while (pos + 8 <= fileSize) {
    const head = await readAt(fh, pos, Math.min(16, fileSize - pos));
    let size = head.readUInt32BE(0);
    const type = head.toString("latin1", 4, 8);
    let header = 8;
    if (size === 1) {
      if (head.length < 16) throw new Error("mp4: truncated large box");
      size = Number(head.readBigUInt64BE(8));
      header = 16;
    } else if (size === 0) {
      size = fileSize - pos;
    }
    if (size < header) throw new Error("mp4: bad box size for " + type);
    // A take cut off mid-box (a crash) keeps the boxes before it.
    if (pos + size > fileSize) {
      boxes.push({ type, start: pos, header, size: fileSize - pos, truncated: true });
      break;
    }
    boxes.push({ type, start: pos, header, size });
    pos += size;
  }
  return boxes;
}

// A parsed box: containers keep children, everything else keeps its payload.
function parseBoxes(buf, start, end) {
  const out = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) throw new Error("mp4: bad child box " + type);
    const node = { type };
    if (CONTAINERS.has(type)) node.children = parseBoxes(buf, pos + header, pos + size);
    else node.data = buf.subarray(pos + header, pos + size);
    out.push(node);
    pos += size;
  }
  return out;
}

function boxBuf(type, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}

function serialize(node) {
  if (node.children) return boxBuf(node.type, node.children.map(serialize));
  return boxBuf(node.type, node.data);
}

function child(node, type) {
  return (node.children || []).find((c) => c.type === type) || null;
}

function fullBox(version, flags, body) {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0);
  return Buffer.concat([vf, body]);
}

function u32(values) {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => buf.writeUInt32BE(v >>> 0, i * 4));
  return buf;
}

function i32(values) {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => buf.writeInt32BE(v | 0, i * 4));
  return buf;
}

// mvhd / tkhd / mdhd: read the timescale and overwrite the duration in
// place (version 0 is 32-bit, version 1 is 64-bit).
function headerFields(type, data) {
  const v = data[0];
  if (type === "mvhd" || type === "mdhd") {
    return v === 1 ? { timescaleAt: 20, durationAt: 24, wide: true } : { timescaleAt: 12, durationAt: 16, wide: false };
  }
  if (type === "tkhd") {
    return v === 1 ? { trackIdAt: 20, durationAt: 28, wide: true } : { trackIdAt: 12, durationAt: 20, wide: false };
  }
  throw new Error("mp4: no header layout for " + type);
}

function setDuration(node, duration) {
  const f = headerFields(node.type, node.data);
  const data = Buffer.from(node.data);
  if (f.wide) data.writeBigUInt64BE(BigInt(Math.max(0, Math.round(duration))), f.durationAt);
  else data.writeUInt32BE(Math.min(0xffffffff, Math.max(0, Math.round(duration))), f.durationAt);
  node.data = data;
}

// One fragment's track run: the sample fields present per trun flags.
function readTraf(traf, moofStart, trex) {
  const tfhdBox = child(traf, "tfhd");
  if (!tfhdBox) throw new Error("mp4: traf without tfhd");
  const t = tfhdBox.data;
  const tfFlags = t.readUInt32BE(0) & 0xffffff;
  const trackId = t.readUInt32BE(4);
  let p = 8;
  let baseOffset = moofStart;
  if (tfFlags & 0x1) {
    baseOffset = Number(t.readBigUInt64BE(p));
    p += 8;
  }
  if (tfFlags & 0x2) p += 4; // sample description index
  const defaults = trex[trackId] || { duration: 0, size: 0, flags: 0 };
  let defDuration = defaults.duration;
  let defSize = defaults.size;
  let defFlags = defaults.flags;
  if (tfFlags & 0x8) {
    defDuration = t.readUInt32BE(p);
    p += 4;
  }
  if (tfFlags & 0x10) {
    defSize = t.readUInt32BE(p);
    p += 4;
  }
  if (tfFlags & 0x20) {
    defFlags = t.readUInt32BE(p);
    p += 4;
  }
  let decodeTime = null;
  const tfdtBox = child(traf, "tfdt");
  if (tfdtBox) {
    const d = tfdtBox.data;
    decodeTime = d[0] === 1 ? Number(d.readBigUInt64BE(4)) : d.readUInt32BE(4);
  }
  const runs = [];
  let nextOffset = baseOffset;
  for (const box of traf.children || []) {
    if (box.type !== "trun") continue;
    const r = box.data;
    const version = r[0];
    const flags = r.readUInt32BE(0) & 0xffffff;
    const count = r.readUInt32BE(4);
    let q = 8;
    let offset = nextOffset;
    if (flags & 0x1) {
      offset = baseOffset + r.readInt32BE(q);
      q += 4;
    }
    let firstFlags = null;
    if (flags & 0x4) {
      firstFlags = r.readUInt32BE(q);
      q += 4;
    }
    const samples = [];
    let pos = offset;
    for (let i = 0; i < count; i += 1) {
      let duration = defDuration;
      let size = defSize;
      let sflags = i === 0 && firstFlags !== null ? firstFlags : defFlags;
      let cts = 0;
      if (flags & 0x100) {
        duration = r.readUInt32BE(q);
        q += 4;
      }
      if (flags & 0x200) {
        size = r.readUInt32BE(q);
        q += 4;
      }
      if (flags & 0x400) {
        sflags = r.readUInt32BE(q);
        q += 4;
      }
      if (flags & 0x800) {
        cts = version === 0 ? r.readUInt32BE(q) : r.readInt32BE(q);
        q += 4;
      }
      // sample_is_non_sync_sample is bit 16 of the sample flags.
      samples.push({ pos, size, duration, sync: (sflags & 0x10000) === 0, cts });
      pos += size;
    }
    nextOffset = pos;
    runs.push(samples);
  }
  return { trackId, decodeTime, runs };
}

function runLength(values) {
  const out = [];
  for (const v of values) {
    const last = out[out.length - 1];
    if (last && last[1] === v) last[0] += 1;
    else out.push([1, v]);
  }
  return out;
}

// Snap video sample times onto the 1/fps grid. Each frame keeps its order
// and lands on its nearest slot. When several frames want the same slot it
// is a burst: the encoder stalled (it does when it starts) and then let out
// frames that were captured during the stall, all stamped on arrival. Those
// frames really belong before their stamps, so the pass runs from the end
// and moves crowded frames earlier, into the stall, never later. The
// picture can only get closer to when it was really captured, so it never
// drifts behind the sound. Returns how many frames were placed.
function snapToGrid(samples, timescale, fps) {
  const step = timescale / fps;
  if (!Number.isInteger(step) || step <= 0 || samples.length < 2) return 0;
  const n = samples.length;
  const slots = new Array(n);
  let next = Infinity;
  for (let i = n - 1; i >= 0; i -= 1) {
    const k = Math.min(Math.round(samples[i].time / step), next - 1);
    slots[i] = k;
    next = k;
  }
  // A burst at the very start can push below zero; walk forward from there.
  let prev = -1;
  for (let i = 0; i < n; i += 1) {
    if (slots[i] <= prev) slots[i] = prev + 1;
    prev = slots[i];
  }
  for (let i = 0; i < n; i += 1) {
    const last = i + 1 === n;
    const lastSlots = Math.max(1, Math.round(samples[i].duration / step));
    samples[i].duration = (last ? lastSlots : slots[i + 1] - slots[i]) * step;
    samples[i].time = slots[i] * step;
  }
  return n;
}

function buildStbl(stsdNode, track, chunkOffsets, wideOffsets) {
  const s = track.samples;
  const stts = runLength(s.map((x) => x.duration));
  const boxes = [stsdNode];
  boxes.push({ type: "stts", data: fullBox(0, 0, Buffer.concat([u32([stts.length]), u32(stts.flat())])) });
  if (s.some((x) => x.cts !== 0)) {
    const negative = s.some((x) => x.cts < 0);
    const ctts = runLength(s.map((x) => x.cts));
    const body = [u32([ctts.length])];
    ctts.forEach(([n, v]) => body.push(u32([n]), negative ? i32([v]) : u32([v])));
    boxes.push({ type: "ctts", data: fullBox(negative ? 1 : 0, 0, Buffer.concat(body)) });
  }
  if (!s.every((x) => x.sync)) {
    const sync = [];
    s.forEach((x, i) => {
      if (x.sync) sync.push(i + 1);
    });
    boxes.push({ type: "stss", data: fullBox(0, 0, Buffer.concat([u32([sync.length]), u32(sync)])) });
  }
  const stsc = [];
  track.chunks.forEach((c, i) => {
    const last = stsc[stsc.length - 1];
    if (!last || last[1] !== c.count) stsc.push([i + 1, c.count, 1]);
  });
  boxes.push({ type: "stsc", data: fullBox(0, 0, Buffer.concat([u32([stsc.length]), u32(stsc.flat())])) });
  boxes.push({ type: "stsz", data: fullBox(0, 0, Buffer.concat([u32([0, s.length]), u32(s.map((x) => x.size))])) });
  if (wideOffsets) {
    const body = Buffer.alloc(4 + chunkOffsets.length * 8);
    body.writeUInt32BE(chunkOffsets.length, 0);
    chunkOffsets.forEach((o, i) => body.writeBigUInt64BE(BigInt(o), 4 + i * 8));
    boxes.push({ type: "co64", data: fullBox(0, 0, body) });
  } else {
    boxes.push({ type: "stco", data: fullBox(0, 0, Buffer.concat([u32([chunkOffsets.length]), u32(chunkOffsets)])) });
  }
  return { type: "stbl", children: boxes };
}

function ftypBox() {
  return boxBuf("ftyp", Buffer.concat([Buffer.from("isom", "latin1"), u32([512]), Buffer.from("isomiso2avc1mp41", "latin1")]));
}

async function remuxFaststart(src, dest, opts) {
  const options = opts || {};
  const fh = await fsp.open(src, "r");
  try {
    const { size: fileSize } = await fh.stat();
    const top = await topLevelBoxes(fh, fileSize);
    const moovBox = top.find((b) => b.type === "moov" && !b.truncated);
    if (!moovBox) throw new Error("mp4: no moov");
    const moofs = top.filter((b) => b.type === "moof" && !b.truncated);
    if (!moofs.length) return { ok: false, reason: "not fragmented" };
    const moovBuf = await readAt(fh, moovBox.start, moovBox.size);
    const moov = { type: "moov", children: parseBoxes(moovBuf, moovBox.header, moovBox.size) };
    if (!moov.children.length) throw new Error("mp4: empty moov");
    const mvhd = child(moov, "mvhd");
    if (!mvhd) throw new Error("mp4: no mvhd");
    const movieTimescale = mvhd.data.readUInt32BE(headerFields("mvhd", mvhd.data).timescaleAt);

    const trex = {};
    const mvex = child(moov, "mvex");
    for (const box of (mvex && mvex.children) || []) {
      if (box.type !== "trex") continue;
      const d = box.data;
      trex[d.readUInt32BE(4)] = { duration: d.readUInt32BE(12), size: d.readUInt32BE(16), flags: d.readUInt32BE(20) };
    }

    const tracks = new Map();
    for (const trak of moov.children.filter((c) => c.type === "trak")) {
      const tkhd = child(trak, "tkhd");
      const mdia = child(trak, "mdia");
      const mdhd = mdia && child(mdia, "mdhd");
      const hdlr = mdia && child(mdia, "hdlr");
      const minf = mdia && child(mdia, "minf");
      const stbl = minf && child(minf, "stbl");
      const stsd = stbl && child(stbl, "stsd");
      if (!tkhd || !mdhd || !stbl || !stsd) throw new Error("mp4: incomplete trak");
      const trackId = tkhd.data.readUInt32BE(headerFields("tkhd", tkhd.data).trackIdAt);
      tracks.set(trackId, {
        trak,
        tkhd,
        mdhd,
        minf,
        stsd,
        handler: hdlr ? hdlr.data.toString("latin1", 8, 12) : "",
        timescale: mdhd.data.readUInt32BE(headerFields("mdhd", mdhd.data).timescaleAt),
        samples: [],
        chunks: [],
        time: 0,
        firstTime: null,
      });
    }

    // Every sample, in file order per track, with its decode time.
    const allChunks = [];
    for (const moofBox of moofs) {
      const moofBuf = await readAt(fh, moofBox.start, moofBox.size);
      const moofKids = parseBoxes(moofBuf, moofBox.header, moofBox.size);
      // traf is not in CONTAINERS, so its payload is parsed here.
      for (const trafLeaf of moofKids.filter((b) => b.type === "traf")) {
        const traf = { type: "traf", children: parseBoxes(trafLeaf.data, 0, trafLeaf.data.length) };
        const info = readTraf(traf, moofBox.start, trex);
        const track = tracks.get(info.trackId);
        if (!track) continue;
        if (info.decodeTime !== null) {
          if (track.firstTime === null) {
            track.firstTime = info.decodeTime;
            track.time = info.decodeTime;
          } else if (info.decodeTime > track.time && track.samples.length) {
            // A hole between fragments: the last picture or sound holds.
            track.samples[track.samples.length - 1].duration += info.decodeTime - track.time;
            track.time = info.decodeTime;
          }
        }
        if (track.firstTime === null) track.firstTime = 0;
        for (const run of info.runs) {
          // Keep only samples whose bytes are really in the file.
          const kept = run.filter((s) => s.size > 0 && s.pos + s.size <= fileSize);
          if (!kept.length) continue;
          let chunk = null;
          for (const s of kept) {
            s.time = track.time;
            track.time += s.duration;
            if (!chunk || chunk.end !== s.pos) {
              chunk = { track, first: track.samples.length, count: 0, pos: s.pos, end: s.pos, newOffset: 0 };
              track.chunks.push(chunk);
              allChunks.push(chunk);
            }
            chunk.count += 1;
            chunk.end = s.pos + s.size;
            track.samples.push(s);
          }
        }
      }
    }

    const live = [...tracks.values()].filter((t) => t.samples.length);
    if (!live.length) throw new Error("mp4: no samples");
    const fps = Number(options.fps) || 0;
    let snapped = false;
    for (const track of live) {
      if (track.handler === "vide" && fps > 0) snapped = snapToGrid(track.samples, track.timescale, fps) || snapped;
    }

    // Layout: ftyp, moov, mdat. Chunks keep their file order so sound and
    // picture stay interleaved.
    allChunks.sort((a, b) => a.pos - b.pos);
    const usedChunks = allChunks.filter((c) => live.includes(c.track));
    const dataBytes = usedChunks.reduce((n, c) => n + (c.end - c.pos), 0);
    const wide = dataBytes + 64 * 1024 * 1024 > 0xffffffff;
    const mdatHeader = dataBytes + 8 > 0xffffffff ? 16 : 8;

    const buildMoov = (offsetFor) => {
      const kids = [];
      let movieDuration = 0;
      for (const node of moov.children) {
        if (node.type === "mvex") continue;
        if (node.type !== "trak") {
          kids.push(node);
          continue;
        }
        const track = [...tracks.values()].find((t) => t.trak === node);
        if (!track || !track.samples.length) continue;
        const mediaDuration = track.samples.reduce((n, s) => n + s.duration, 0);
        const lead = Math.max(0, (track.samples[0].time || 0));
        const leadMovie = Math.round((lead / track.timescale) * movieTimescale);
        const trackMovie = Math.round((mediaDuration / track.timescale) * movieTimescale) + leadMovie;
        movieDuration = Math.max(movieDuration, trackMovie);
        setDuration(track.tkhd, trackMovie);
        setDuration(track.mdhd, mediaDuration);
        const stbl = buildStbl(track.stsd, track, track.chunks.map(offsetFor), wide);
        const minf = { type: "minf", children: track.minf.children.map((c) => (c.type === "stbl" ? stbl : c)) };
        const mdia = child(node, "mdia");
        const newMdia = { type: "mdia", children: mdia.children.map((c) => (c.type === "minf" ? minf : c)) };
        const trakKids = node.children.filter((c) => c.type !== "edts").map((c) => (c.type === "mdia" ? newMdia : c));
        // A track that starts after zero (sound that began a little late)
        // keeps its place with an empty edit before it; with composition
        // offsets the edit also starts the picture at its first frame.
        const firstCts = track.samples[0].cts || 0;
        if (leadMovie > 0 || firstCts) {
          const entries = [];
          if (leadMovie > 0) entries.push([leadMovie, -1]);
          entries.push([trackMovie - leadMovie, firstCts]);
          // elst v0 entry: segment duration, media time (-1 = empty), rate 1.0.
          const elst = Buffer.concat([u32([entries.length]), ...entries.map(([d, m]) => Buffer.concat([u32([d]), i32([m]), u32([0x00010000])]))]);
          trakKids.splice(1, 0, { type: "edts", children: [{ type: "elst", data: fullBox(0, 0, elst) }] });
        }
        kids.push({ type: "trak", children: trakKids });
      }
      setDuration(mvhd, movieDuration);
      return { box: serialize({ type: "moov", children: kids }), movieDuration };
    };

    const ftyp = ftypBox();
    // Offsets do not change the moov size, so measure it once with zeros.
    const sizing = buildMoov(() => 0).box.length;
    const dataStart = ftyp.length + sizing + mdatHeader;
    let cursor = dataStart;
    for (const c of usedChunks) {
      c.newOffset = cursor;
      cursor += c.end - c.pos;
    }
    const { box: moovOut, movieDuration } = buildMoov((c) => c.newOffset);
    if (moovOut.length !== sizing) throw new Error("mp4: moov size changed");

    const mdatHead = Buffer.alloc(mdatHeader);
    if (mdatHeader === 16) {
      mdatHead.writeUInt32BE(1, 0);
      mdatHead.write("mdat", 4, "latin1");
      mdatHead.writeBigUInt64BE(BigInt(dataBytes + 16), 8);
    } else {
      mdatHead.writeUInt32BE(dataBytes + 8, 0);
      mdatHead.write("mdat", 4, "latin1");
    }

    const out = await fsp.open(dest, "w");
    try {
      let wpos = 0;
      for (const part of [ftyp, moovOut, mdatHead]) {
        await out.write(part, 0, part.length, wpos);
        wpos += part.length;
      }
      const CHUNK = 4 * 1024 * 1024;
      const buf = Buffer.alloc(CHUNK);
      for (const c of usedChunks) {
        let p = c.pos;
        while (p < c.end) {
          const n = Math.min(CHUNK, c.end - p);
          const { bytesRead } = await fh.read(buf, 0, n, p);
          if (bytesRead !== n) throw new Error("mp4: short read copying samples");
          await out.write(buf, 0, n, wpos);
          wpos += n;
          p += n;
        }
      }
      if (wpos !== dataStart + dataBytes) throw new Error("mp4: wrote " + wpos + " bytes, expected " + (dataStart + dataBytes));
      await out.sync();
    } finally {
      await out.close();
    }
    return {
      ok: true,
      fragments: moofs.length,
      tracks: live.map((t) => ({ handler: t.handler, samples: t.samples.length })),
      durationMs: Math.round((movieDuration / movieTimescale) * 1000),
      snapped,
      bytes: dataStart + dataBytes,
    };
  } finally {
    await fh.close();
  }
}

// True when the file at p is a fragmented MP4 (has a moof at the top level).
async function isFragmentedMp4(p) {
  let fh;
  try {
    fh = await fsp.open(p, "r");
    const { size } = await fh.stat();
    const top = await topLevelBoxes(fh, size);
    return top.some((b) => b.type === "moof");
  } catch {
    return false;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

module.exports = { remuxFaststart, isFragmentedMp4, _test: { snapToGrid, runLength } };

