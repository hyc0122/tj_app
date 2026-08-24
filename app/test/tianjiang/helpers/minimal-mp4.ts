/**
 * R23-fix：构造可通过有界 ISO-BMFF 校验的最小 MP4，以及只含 ftyp 的伪造件。
 */
export function box(type: string, ...parts: Buffer[]): Buffer {
  const payload = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 4, "ascii");
  return Buffer.concat([header, payload]);
}

export function fullBox(type: string, version: number, flags: number, ...parts: Buffer[]): Buffer {
  const vf = Buffer.alloc(4);
  vf[0] = version;
  vf.writeUIntBE(flags, 1, 3);
  return box(type, vf, ...parts);
}

export function fourcc(value: string): Buffer {
  return Buffer.from(value, "ascii");
}

export function u32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value >>> 0, 0);
  return buf;
}

export function fakeFtypOnly(): Buffer {
  return Buffer.from([0x00, 0x00, 0x00, 0x08, 0x66, 0x74, 0x79, 0x70]);
}

export function ftypPlusMdatOnly(): Buffer {
  return Buffer.concat([
    box("ftyp", fourcc("isom"), u32(0), fourcc("isom"), fourcc("mp41")),
    box("mdat", Buffer.alloc(8)),
  ]);
}

export function buildMinimalAdoptableMp4(mdatPayload: Buffer = Buffer.alloc(8)): Buffer {
  const mvhdPayload = Buffer.alloc(100);
  mvhdPayload.writeUInt32BE(1000, 8);
  mvhdPayload.writeUInt32BE(1000, 12);
  mvhdPayload.writeUInt32BE(0x00010000, 16);
  mvhdPayload.writeUInt16BE(0x0100, 20);
  const matrix = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  let offset = 36;
  for (const item of matrix) {
    mvhdPayload.writeUInt32BE(item, offset);
    offset += 4;
  }
  mvhdPayload.writeUInt32BE(2, 96);
  const tkhdPayload = Buffer.alloc(84);
  tkhdPayload.writeUInt32BE(1, 8);
  tkhdPayload.writeUInt32BE(1000, 16);
  offset = 40;
  for (const item of matrix) {
    tkhdPayload.writeUInt32BE(item, offset);
    offset += 4;
  }
  tkhdPayload.writeUInt32BE(0x00100000, 76);
  tkhdPayload.writeUInt32BE(0x00100000, 80);
  const mdhdPayload = Buffer.alloc(24);
  mdhdPayload.writeUInt32BE(1000, 8);
  mdhdPayload.writeUInt32BE(1000, 12);
  const hdlrPayload = Buffer.alloc(21);
  hdlrPayload.write("vide", 4);
  hdlrPayload.write("VideoHandler", 20);
  const url = fullBox("url ", 0, 1);
  const dref = fullBox("dref", 0, 0, u32(1), url);
  const stsd = fullBox("stsd", 0, 0, u32(0));
  const stts = fullBox("stts", 0, 0, u32(0));
  const stsc = fullBox("stsc", 0, 0, u32(0));
  const stsz = fullBox("stsz", 0, 0, u32(0), u32(0));
  const stco = fullBox("stco", 0, 0, u32(0));
  const minf = box("minf", fullBox("vmhd", 0, 1, Buffer.alloc(8)), box("dinf", dref), box("stbl", stsd, stts, stsc, stsz, stco));
  const mdia = box("mdia", fullBox("mdhd", 0, 0, mdhdPayload), fullBox("hdlr", 0, 0, hdlrPayload), minf);
  const trak = box("trak", fullBox("tkhd", 0, 3, tkhdPayload), mdia);
  const moov = box("moov", fullBox("mvhd", 0, 0, mvhdPayload), trak);
  return Buffer.concat([
    box("ftyp", fourcc("isom"), u32(0), fourcc("isom"), fourcc("mp41")),
    moov,
    box("mdat", mdatPayload),
  ]);
}

export function buildNonFastStartAdoptableMp4(mdatBytes = 512 * 1024 + 64): Buffer {
  const head = buildMinimalAdoptableMp4();
  const ftyp = head.subarray(0, 24);
  const rest = head.subarray(24);
  return Buffer.concat([ftyp, box("mdat", Buffer.alloc(mdatBytes)), rest]);
}

export function build64BitBoxAdoptableMp4(): Buffer {
  const payload = Buffer.concat([fourcc("isom"), u32(0), fourcc("isom"), fourcc("mp41")]);
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write("ftyp", 4, 4, "ascii");
  header.writeUInt32BE(0, 8);
  header.writeUInt32BE(16 + payload.length, 12);
  const body = buildMinimalAdoptableMp4().subarray(24);
  return Buffer.concat([header, payload, body]);
}

export function truncated64BitBox(): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt32BE(1, 0);
  header.write("mdat", 4, 4, "ascii");
  header.writeUInt32BE(0, 8);
  return header;
}
