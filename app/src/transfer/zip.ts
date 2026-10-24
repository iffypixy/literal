/** A .zip that stores files as they are, uncompressed: notes are small, and this needs no library. */

export type Entry = { name: string; text: string; modified: Date };

export function zip(entries: Entry[]): Blob {
  const encoder = new TextEncoder();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.text);
    const crc = crc32(data);
    const [time, date] = dosTime(entry.modified);
    const local = header(30, name, [
      [0, 4, 0x04034b50],
      [4, 2, 20], // version needed
      [6, 2, 0x0800], // names are UTF-8
      [8, 2, 0], // stored
      [10, 2, time],
      [12, 2, date],
      [14, 4, crc],
      [18, 4, data.length],
      [22, 4, data.length],
      [26, 2, name.length],
    ]);
    central.push(
      header(46, name, [
        [0, 4, 0x02014b50],
        [4, 2, 20],
        [6, 2, 20],
        [8, 2, 0x0800],
        [10, 2, 0],
        [12, 2, time],
        [14, 2, date],
        [16, 4, crc],
        [20, 4, data.length],
        [24, 4, data.length],
        [28, 2, name.length],
        [42, 4, offset],
      ]),
    );
    parts.push(local, data);
    offset += local.length + data.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = header(22, new Uint8Array(), [
    [0, 4, 0x06054b50],
    [8, 2, entries.length],
    [10, 2, entries.length],
    [12, 4, size],
    [16, 4, offset],
  ]);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

/** A record of `size` fixed bytes, with `fields` written little-endian at their offsets, followed by `name`. */
function header(
  size: number,
  name: Uint8Array,
  fields: [offset: number, bytes: 2 | 4, value: number][],
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size + name.length);
  const view = new DataView(out.buffer);
  for (const [at, bytes, value] of fields) {
    if (bytes === 2) view.setUint16(at, value, true);
    else view.setUint32(at, value, true);
  }
  out.set(name, size);
  return out;
}

/** The two 16-bit MS-DOS fields a zip stores times in, in local time, to the even second. */
function dosTime(date: Date): [number, number] {
  const year = Math.max(1980, date.getFullYear());
  return [
    (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  ];
}

const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
