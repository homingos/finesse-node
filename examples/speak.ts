// Synthesize one sentence with the first ready voice and save it as speak.wav.
import { writeFile } from "node:fs/promises";
import { Finesse, isReady } from "../src/index.js";

const client = new Finesse();
for await (const voice of await client.voices.list()) {
  if (!isReady(voice)) continue;
  const audio = await client.speech.create({ voice_id: voice.id, text: "Hello from Finesse!" });
  await writeFile("speak.wav", audio.data);
  console.log(
    `Saved speak.wav (${audio.data.length} bytes, ${audio.sampleRate} Hz) with ${voice.name}`,
  );
  break;
}
