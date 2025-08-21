import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const list = await client.beta.vectorStores.list({ limit: 5 });
console.log(list.data.map(v => `${v.id}  ${v.name}`));
