// Regenerates the synthetic Sinhala fixtures (zero copyrighted content — every line is synthetic).
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { deflateRawSync, crc32 } from 'node:zlib';

function mkzip(entries) {
  const chunks = [], central = []; let off = 0;
  for (const [name, data] of entries) {
    const nb = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc >>> 0, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
    const comp = deflateRawSync(data);
    chunks.push(lh, nb, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc >>> 0, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    central.push(Buffer.concat([ch, nb]));
    off += 30 + nb.length + comp.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(central.length, 8); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...chunks, ...central, eocd]);
}

const si = '1\n00:00:01,000 --> 00:00:03,500\nආයුබෝවන් ලොව! මෙය කෘත්‍රිම පරීක්ෂණ දර්ශනයකි.\n\n2\n00:00:04,000 --> 00:00:06,000\nදෙවන කෘත්‍රිම පේළිය\n\n3\n00:00:07,000 --> 00:00:09,000\nතුන්වන පරීක්ෂණය\n';
const en = '1\n00:00:01,000 --> 00:00:03,500\nHello world! This is a synthetic test cue.\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond synthetic line\n\n3\n00:00:07,000 --> 00:00:09,000\nThird synthetic line\n';

writeFileSync(new URL('./si.srt', import.meta.url), si, 'utf8');
writeFileSync(new URL('./en.srt', import.meta.url), en, 'utf8');
writeFileSync(new URL('./si_bom_crlf.srt', import.meta.url), '\ufeff' + si.replace(/\n/g, '\r\n'), 'utf8');
writeFileSync(new URL('./si.srt.gz', import.meta.url), gzipSync(Buffer.from(si, 'utf8')));
writeFileSync(new URL('./pack.zip', import.meta.url), mkzip([
  ['__MACOSX/._junk', Buffer.from('junkjunkjunk')],
  ['Subs/Nested/Synthetic.si.srt', Buffer.from(si, 'utf8')],
  ['Synthetic.en.srt', Buffer.from(en, 'utf8')],
  ['info.nfo', Buffer.from('nfo')],
]));
console.log('fixtures regenerated (synthetic Sinhala only)');
