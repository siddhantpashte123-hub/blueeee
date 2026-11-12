'use strict';
/**
 * Chhota ISO9660 + Joliet writer.
 *
 * Kyun? Cloud-init ko boot ke waqt "seed" chahiye jisme user-data/meta-data ho.
 * Har jagah genisoimage/xorriso installed nahi hota, isliye hum khud ISO banate hain.
 * Label "cidata" hona zaroori hai — cloud-init NoCloud isi label se seed pehchanta hai.
 *
 * Joliet isliye use karte hain taaki file names chhote (lowercase) dikhein:
 *   user-data, meta-data  (ISO9660 default uppercase hota hai)
 */

const SECTOR = 2048;

// ---------- low level helpers ----------
function u16le(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}
function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}
function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}
function both16(n) {
  return Buffer.concat([u16le(n), Buffer.from([(n >> 8) & 0xff, n & 0xff])]);
}
function both32(n) {
  return Buffer.concat([u32le(n), u32be(n)]);
}
function padEnd(buf, len, fill = 0x20) {
  const out = Buffer.alloc(len, fill);
  buf.copy(out, 0, 0, Math.min(buf.length, len));
  return out;
}
function ucs2be(str) {
  const le = Buffer.from(str, 'ucs2');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return be;
}
function dirDate(d = new Date()) {
  const b = Buffer.alloc(7);
  b[0] = (d.getUTCFullYear() - 1900) & 0xff;
  b[1] = d.getUTCMonth() + 1;
  b[2] = d.getUTCDate();
  b[3] = d.getUTCHours();
  b[4] = d.getUTCMinutes();
  b[5] = d.getUTCSeconds();
  b[6] = 0; // UTC
  return b;
}

/**
 * Ek directory record banata hai.
 * id: Buffer (raw identifier bytes)
 */
function dirRecord({ id, extent, size, isDir, date }) {
  const nameLen = id.length;
  const total = 33 + nameLen + (nameLen % 2 === 0 ? 1 : 0);
  const b = Buffer.alloc(total);
  b[0] = total;
  b[1] = 0;
  both32(extent).copy(b, 2);
  both32(size).copy(b, 10);
  date.copy(b, 18);
  b[25] = isDir ? 0x02 : 0x00;
  b[26] = 0;
  b[27] = 0;
  both16(1).copy(b, 28);
  b[32] = nameLen;
  id.copy(b, 33);
  return b;
}

/** ISO9660 file identifier: uppercase, ';1' suffix */
function isoId(name) {
  const base = String(name).toUpperCase().replace(/[^A-Z0-9_.-]/g, '_');
  const dot = base.lastIndexOf('.');
  let nm = base;
  let ext = '';
  if (dot > 0) {
    nm = base.slice(0, dot);
    ext = base.slice(dot + 1);
  }
  nm = nm.slice(0, 8);
  ext = ext.slice(0, 3);
  return ext ? `${nm}.${ext};1` : `${nm};1`;
}

function pathTableRecord(nameBuf, extent, parent, bigEndian) {
  const len = nameBuf.length;
  const rec = Buffer.alloc(8 + len + (len % 2));
  rec[0] = len;
  rec[1] = 0;
  if (bigEndian) u32be(extent).copy(rec, 2);
  else u32le(extent).copy(rec, 2);
  const pe = Buffer.alloc(2);
  // L table: sab little-endian, M table: sab big-endian
  if (bigEndian) pe.writeUInt16BE(parent, 0);
  else pe.writeUInt16LE(parent, 0);
  pe.copy(rec, 6);
  nameBuf.copy(rec, 8);
  return rec;
}

function buildDir(entries, dirExtent, parentExtent, dirSize, joliet, date) {
  const parts = [];
  // "." — apne aap
  parts.push(
    dirRecord({
      id: Buffer.from([0x00]),
      extent: dirExtent,
      size: dirSize,
      isDir: true,
      date
    })
  );
  // ".." — parent (root ka parent khud root hota hai)
  parts.push(
    dirRecord({
      id: Buffer.from([0x01]),
      extent: parentExtent,
      size: dirSize,
      isDir: true,
      date
    })
  );
  for (const e of entries) {
    const id = joliet ? ucs2be(e.name) : Buffer.from(isoId(e.name), 'ascii');
    parts.push(
      dirRecord({
        id,
        extent: e.extent,
        size: e.size,
        isDir: false,
        date
      })
    );
  }
  let buf = Buffer.concat(parts);
  // directory data length sector-aligned
  const padded = Buffer.alloc(Math.ceil(buf.length / SECTOR) * SECTOR);
  buf.copy(padded);
  return padded;
}

/**
 * ISO banata hai.
 * @param {object} opts
 * @param {string} opts.label  volume id (cloud-init ke liye 'cidata')
 * @param {Array<{name:string,data:Buffer}>} opts.files
 * @returns {Buffer}
 */
function buildIso({ label = 'cidata', files = [] }) {
  if (!files.length) throw new Error('ISO ke liye kam se kam ek file chahiye');
  const date = dirDate();
  const volId = String(label).slice(0, 32);

  // --- file layout ---
  let cursor = 23; // 16 PVD, 17 SVD, 18 terminator, 19-22 path tables
  const place = (sectors) => {
    const at = cursor;
    cursor += sectors;
    return at;
  };

  const fileEntries = files.map((f) => {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const sectors = Math.max(1, Math.ceil(data.length / SECTOR));
    const extent = place(sectors);
    return { name: f.name, data, size: data.length, sectors, extent };
  });

  // --- root directories (size pehle chahiye) ---
  const rootEntriesIso = fileEntries.map((f) => ({ name: f.name, extent: f.extent, size: f.size }));
  const rootEntriesJol = rootEntriesIso;

  // root ka size nikalne ke liye ek dummy build (extent 0)
  const sizeOfRoot = (joliet) => {
    const entries = joliet ? rootEntriesJol : rootEntriesIso;
    let n = 0;
    // "." + ".."
    const recSize = (nameLen) => 33 + nameLen + (nameLen % 2 === 0 ? 1 : 0);
    n += recSize(1) + recSize(1);
    for (const e of entries) {
      const nameLen = joliet ? e.name.length * 2 : isoId(e.name).length;
      n += recSize(nameLen);
    }
    return Math.ceil(n / SECTOR) * SECTOR;
  };

  const rootSize = sizeOfRoot(false);
  const rootJolSize = sizeOfRoot(true);

  const rootExtent = place(Math.ceil(rootSize / SECTOR));
  const rootJolExtent = place(Math.ceil(rootJolSize / SECTOR));
  const totalSectors = cursor;

  const out = Buffer.alloc(totalSectors * SECTOR);

  // --- root dirs ---
  buildDir(rootEntriesIso, rootExtent, rootExtent, rootSize, false, date).copy(out, rootExtent * SECTOR);
  buildDir(rootEntriesJol, rootJolExtent, rootJolExtent, rootJolSize, true, date).copy(out, rootJolExtent * SECTOR);

  // --- path tables (root only) ---
  const ptIso = pathTableRecord(Buffer.from([0x00]), rootExtent, 1, false);
  const ptIsoM = pathTableRecord(Buffer.from([0x00]), rootExtent, 1, true);
  const ptJol = pathTableRecord(Buffer.from([0x00]), rootJolExtent, 1, false);
  const ptJolM = pathTableRecord(Buffer.from([0x00]), rootJolExtent, 1, true);
  ptIso.copy(out, 19 * SECTOR);
  ptIsoM.copy(out, 20 * SECTOR);
  ptJol.copy(out, 21 * SECTOR);
  ptJolM.copy(out, 22 * SECTOR);

  // --- files ---
  for (const f of fileEntries) f.data.copy(out, f.extent * SECTOR);

  // --- volume descriptors ---
  const makeVD = (type, joliet) => {
    const vd = Buffer.alloc(SECTOR);
    vd[0] = type;
    vd.write('CD001', 1, 'ascii');
    vd[6] = 1;
    // system identifier: 32 spaces
    vd.fill(0x20, 8, 40);
    if (joliet) {
      // Joliet volume id: 16 UCS-2 chars, space padded (0x00 0x20 pairs)
      ucs2be(volId.padEnd(16, ' ').slice(0, 16)).copy(vd, 40);
      // escape sequences
      vd.fill(0x00, 88, 120);
      vd[88] = 0x25; // %
      vd[89] = 0x2f; // /
      vd[90] = 0x45; // E
    } else {
      padEnd(Buffer.from(volId, 'ascii'), 32).copy(vd, 40);
    }
    vd.fill(0x00, 72, 80);
    both32(totalSectors).copy(vd, 80);
    both16(1).copy(vd, 120); // volume set size
    both16(1).copy(vd, 124); // sequence number
    both16(SECTOR).copy(vd, 128); // logical block size
    both32(10).copy(vd, 132); // path table size (root record = 10 bytes)
    u32le(joliet ? 21 : 19).copy(vd, 140);
    u32le(0).copy(vd, 144);
    u32be(joliet ? 22 : 20).copy(vd, 148);
    u32be(0).copy(vd, 152);
    // root dir record @156 (34 bytes)
    const rootRec = dirRecord({
      id: Buffer.from([0x00]),
      extent: joliet ? rootJolExtent : rootExtent,
      size: joliet ? rootJolSize : rootSize,
      isDir: true,
      date
    });
    rootRec.copy(vd, 156);
    vd.fill(0x20, 190, 318); // volume set id
    padEnd(Buffer.from('VPSDECK', 'ascii'), 128).copy(vd, 318);
    padEnd(Buffer.from('VPSDECK', 'ascii'), 128).copy(vd, 446);
    padEnd(Buffer.from('VPSDECK', 'ascii'), 128).copy(vd, 574);
    vd.fill(0x20, 702, 739);
    vd.fill(0x20, 739, 776);
    vd.fill(0x20, 776, 813);
    // dates: creation / modification / expiration / effective
    const vdDate = Buffer.from('0000000000000000', 'ascii');
    vdDate.copy(vd, 813);
    vdDate.copy(vd, 830);
    vd.fill(0x30, 847, 864); // expiration: all zeros ascii
    vdDate.copy(vd, 864);
    vd[881] = 1; // file structure version
    return vd;
  };

  makeVD(1, false).copy(out, 16 * SECTOR);
  makeVD(2, true).copy(out, 17 * SECTOR);
  const term = Buffer.alloc(SECTOR);
  term[0] = 255;
  term.write('CD001', 1, 'ascii');
  term[6] = 1;
  term.copy(out, 18 * SECTOR);

  return out;
}

module.exports = { buildIso, isoId, SECTOR };
