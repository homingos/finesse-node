// Stream a few pieces of text over a realtime session and save the PCM as realtime.wav.
import { writeFile } from "node:fs/promises";
import { Finesse, isReady } from "../src/index.js";

const client = new Finesse();
let voiceId = "";
for await (const v of client.voices.list()) {
  if (isReady(v)) {
    voiceId = v.id;
    break;
  }
}

const rt = await client.realtime.connect();
const ctx = rt.context({ voice_id: voiceId });
for (const piece of ["Hello! ", "This text is streamed ", "a few words at a time."]) {
  await ctx.send(piece);
}
await ctx.finish();
const parts: Uint8Array[] = [];
for await (const pcm of ctx.audio()) parts.push(pcm);
await rt.close();

const rate = ctx.sampleRate ?? 24000;
const data = Buffer.concat(parts);
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + data.length, 4);
header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(rate, 24);
header.writeUInt32LE(rate * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(data.length, 40);
await writeFile("realtime.wav", Buffer.concat([header, data]));
console.log(`Saved realtime.wav (${data.length} bytes at ${rate} Hz)`);
