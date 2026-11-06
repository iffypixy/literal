import assert from "node:assert/strict";
import { test } from "node:test";
import { zip } from "#/web/lib/zip.ts";

test("an export is a zip whose directory points at each file, with its checksum", async () => {
  const data = new Uint8Array(
    await zip([
      { name: "hello.txt", text: "hello", modified: new Date(2026, 0, 2, 3, 4, 6) },
      { name: "café.txt", text: "", modified: new Date(2026, 0, 2) },
    ]).arrayBuffer(),
  );
  const view = new DataView(data.buffer);
  const end = data.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 2);

  const directory = view.getUint32(end + 16, true);
  assert.equal(view.getUint32(directory, true), 0x02014b50);
  // CRC-32 of "hello".
  assert.equal(view.getUint32(directory + 16, true), 0x3610a686);
  const local = view.getUint32(directory + 42, true);
  assert.equal(view.getUint32(local, true), 0x04034b50);
  const nameLength = view.getUint16(local + 26, true);
  assert.equal(new TextDecoder().decode(data.subarray(local + 30, local + 30 + nameLength)), "hello.txt");
  assert.equal(new TextDecoder().decode(data.subarray(local + 30 + nameLength, local + 35 + nameLength)), "hello");
});
