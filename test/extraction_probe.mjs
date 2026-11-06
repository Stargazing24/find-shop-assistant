// 读图测试：用 runExtraction 识别菜单照片
// 用法：node test/extraction_probe.mjs <modelId> <imagePath>
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk';
import * as core from '../src/core.mjs';
import fs from 'node:fs';

const modelId = process.argv[2];
const imagePath = process.argv[3];
if (!modelId || !imagePath) { console.error('用法: node test/extraction_probe.mjs <modelId> <imagePath>'); process.exit(1); }

const endpoint = process.env.WB_ENDPOINT || 'https://find-shop.app.workbuddy.host';
const publishableKey = process.env.WB_PUBLISHABLE_KEY;
const cloud = createWorkBuddyCloud({ endpoint, publishableKey });

async function callLLM({ system, user, images, temperature, maxTokens }) {
  const messages = [{ role: 'system', content: system }];
  if (images && images.length) {
    const content = [{ type: 'text', text: user }];
    for (const img of images) content.push({ type: 'image_url', image_url: { url: img } });
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: user });
  }
  let text = '';
  let sawReasoning = false;
  for await (const chunk of cloud.llm.chat.completions.create({
    model: modelId, messages, stream: true,
    temperature: temperature ?? 0, max_tokens: maxTokens,
    stream_options: { include_usage: true },
  })) {
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.reasoning_content) sawReasoning = true;
    if (delta?.content) text += delta.content;
  }
  return { text, sawReasoning };
}

const buf = fs.readFileSync(imagePath);
const dataUrl = 'data:image/jpeg;base64,' + buf.toString('base64');

const t0 = Date.now();
const ex = await core.runExtraction({ images: [dataUrl], callLLM: async (o) => (await callLLM(o)).text });
const dt = Date.now() - t0;

console.log(JSON.stringify({
  model: modelId,
  ok: ex.ok,
  firstTryOk: ex.firstTryOk,
  attempts: ex.attempts,
  dishCount: (ex.dishes || []).length,
  ms: dt,
  dishes: (ex.dishes || []).map(d => ({ name: d.name, price: d.price, confidence: d.confidence })),
  errors: ex.errors,
}, null, 2));
