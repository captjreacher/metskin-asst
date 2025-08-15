import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const assistantId = process.env.ASST_METAMORPHOSIS || process.env.ASST_DEFAULT;

const thread = await client.beta.threads.create({
  messages: [{ role: "user", content: "Give me 3 bullets from our returns policy." }]
});

const run = await client.beta.threads.runs.createAndPoll(thread.id, { assistant_id: assistantId });

if (run.status === "completed") {
  const msgs = await client.beta.threads.messages.list(thread.id);
  console.log("\n--- Answer ---\n" + (msgs.data[0]?.content?.[0]?.text?.value ?? "(no text)"));
} else {
  console.log("Run status:", run.status, run.last_error ?? "");
}
