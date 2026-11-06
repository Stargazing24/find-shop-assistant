// 模型真实调用测试（脚本准备好，等用户记下资源点余额并确认后才执行）
// 用法：node test/models_probe.mjs <modelId>
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk';
import * as core from '../src/core.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const modelId = process.argv[2];
if (!modelId) { console.error('用法: node test/models_probe.mjs <modelId>'); process.exit(1); }

const endpoint = process.env.WB_ENDPOINT || 'https://find-shop.app.workbuddy.host';
const publishableKey = process.env.WB_PUBLISHABLE_KEY;

const cloud = createWorkBuddyCloud({ endpoint, publishableKey });

// callLLM：流式拼正文，丢弃 reasoning_content
async function callLLM({ system, user, images, temperature, maxTokens }) {
  const messages = [{ role: 'system', content: system }];
  if (images && images.length) {
    const content = [{ type: 'text', text: user }];
    for (const img of images) {
      content.push({ type: 'image_url', image_url: { url: img } });
    }
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: user });
  }
  let text = '';
  let sawReasoning = false;
  for await (const chunk of cloud.llm.chat.completions.create({
    model: modelId,
    messages,
    stream: true,
    temperature: temperature ?? 0,
    max_tokens: maxTokens,
    stream_options: { include_usage: true },
  })) {
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.reasoning_content) sawReasoning = true;
    if (delta?.content) text += delta.content;
  }
  return { text, sawReasoning };
}

function loadDemo() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'demo_shops.json'), 'utf8'));
}

async function main() {
  const demo = loadDemo();
  const cases = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'cases.json'), 'utf8')).cases;
  const ids = ['D1', 'D5', 'D7'];
  const results = [];

  for (const id of ids) {
    const c = cases.find((x) => x.id === id);
    const t0 = Date.now();
    const r = await core.runFindPipeline({
      query: c.query, nowISO: c.now,
      shops: demo.shops, dishes: demo.dishes,
      callLLM: async (opts) => (await callLLM(opts)).text,
      includeDemo: true,
    });
    const dt = Date.now() - t0;
    const got = (r.candidates || []).map((x) => x.shopId).sort();
    const exp = (c.expected_shop_ids || []).slice().sort();
    results.push({
      case: id,
      model: modelId,
      parseFirstTryOk: r.parseFirstTryOk,
      parser: r.parser,
      candidates: got,
      expected: exp,
      match: JSON.stringify(got) === JSON.stringify(exp),
      ms: dt,
      usedTemplate: r.usedTemplate,
    });
    console.log(`[${id}] parseFirstTryOk=${r.parseFirstTryOk} parser=${r.parser} 候选=${got.join(',')||'(无)'} 期望=${exp.join(',')||'(无)'} 匹配=${JSON.stringify(got)===JSON.stringify(exp)} 耗时=${dt}ms`);
  }

  fs.writeFileSync(path.join(ROOT, 'test', `probe_${modelId}.json`), JSON.stringify(results, null, 2));
  console.log('\n已写入 test/probe_' + modelId + '.json');
}

main().catch((e) => { console.error('测试失败:', e); process.exit(1); });
