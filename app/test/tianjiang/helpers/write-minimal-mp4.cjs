const fs = require("node:fs");
const path = require("node:path");

function box(type, ...parts) {
  const payload = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 4, "ascii");
  return Buffer.concat([header, payload]);
}
function fullBox(type, version, flags, ...parts) {
  const vf = Buffer.alloc(4);
  vf[0] = version;
  vf.writeUIntBE(flags, 1, 3);
  return box(type, vf, ...parts);
}
function fourcc(value) { return Buffer.from(value, "ascii"); }
function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value >>> 0, 0);
  return buf;
}
const mvhdPayload = Buffer.alloc(100);
mvhdPayload.writeUInt32BE(1000, 8);
mvhdPayload.writeUInt32BE(1000, 12);
mvhdPayload.writeUInt32BE(0x00010000, 16);
mvhdPayload.writeUInt16BE(0x0100, 20);
const matrix = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
let offset = 36;
for (const item of matrix) { mvhdPayload.writeUInt32BE(item, offset); offset += 4; }
mvhdPayload.writeUInt32BE(2, 96);
const tkhdPayload = Buffer.alloc(84);
tkhdPayload.writeUInt32BE(1, 8);
tkhdPayload.writeUInt32BE(1000, 16);
offset = 40;
for (const item of matrix) { tkhdPayload.writeUInt32BE(item, offset); offset += 4; }
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
const bytes = Buffer.concat([
  box("ftyp", fourcc("isom"), u32(0), fourcc("isom"), fourcc("mp41")),
  moov,
  box("mdat", Buffer.alloc(8)),
]);
const dest = path.resolve(__dirname, "../fixtures/minimal-adoptable.mp4");
fs.writeFileSync(dest, bytes);
console.log(dest, bytes.length);
