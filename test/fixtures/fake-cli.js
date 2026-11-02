#!/usr/bin/env node
// Stand-in for an agent CLI. Reads the prompt from stdin and answers according to
// the Kerberos prompt it recognises. --behavior forces failure modes for tests.
const behavior = process.argv[process.argv.indexOf('--behavior') + 1] || 'ok';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  switch (behavior) {
    case 'hang':
      setInterval(() => {}, 1 << 30);
      return;
    case 'ratelimit':
      process.stderr.write('Error: 429 Too Many Requests - rate limit exceeded\n');
      process.exit(1);
      return;
    case 'crash':
      process.stderr.write('segfault-ish failure\n');
      process.exit(3);
      return;
    case 'violation': // announces a forbidden write, then would keep running
      process.stdout.write('WRITE hello.txt\n');
      setInterval(() => {}, 1 << 30);
      return;
    case 'empty':
      process.exit(0);
      return;
    case 'opencode-steps': // two steps of `opencode run --format json`
      [
        { type: 'tool_use', part: { tool: 'read' } },
        { type: 'step_finish', part: { tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 5 } }, cost: 0.01 } },
        { type: 'text', part: { text: 'Cevap' } },
        { type: 'step_finish', part: { tokens: { input: 20, output: 4, reasoning: 0, cache: { read: 7 } }, cost: 0.02 } },
      ].forEach((ev) => process.stdout.write(JSON.stringify(ev) + '\n'));
      return;
    default:
      respond();
  }
});

const SITE_V1 = '<!doctype html><html lang="tr"><head><meta name="viewport" content="width=device-width"><title>Site</title></head><body><h1>Merhaba dünya</h1><p>Deneme sitesi, birkaç cümlelik metin.</p><button>Bas</button></body></html>';
const SITE_V2 = SITE_V1.replace('<button>Bas</button>', '<button onclick="document.body.append(\'ok\')">Bas</button>');

function respond() {
  const request = /## User request\n([^\n]*)/.exec(input)?.[1] || '';
  const site = /\bsite\b/i.test(request);
  if (input.startsWith('CODE REVIEW.') || input.includes('\nCODE REVIEW.')) {
    // "critic" finds something in the first file it reviews; everyone else is happy.
    const file = /^--- (\S+) \(written by/m.exec(input)?.[1];
    out('```json\n' + JSON.stringify({ findings: behavior === 'critic' && file ? [{ file, severity: 'medium', issue: 'the greeting is too short', fix: 'say hello world' }] : [] }) + '\n```');
    return;
  }
  if (input.includes('SITE REVIEW.')) {
    const shots = [...input.matchAll(/^- (.+\.jpg)$/gm)].map((m) => m[1]);
    const findings = behavior === 'critic' && shots.length ? [{ file: 'index.html', severity: 'high', issue: 'the button does nothing', fix: 'add a click handler' }] : [];
    out('```json\n' + JSON.stringify({ findings }) + '\n```');
    return;
  }
  if (input.includes('You are the engineer responsible for')) {
    const file = /=== FILE: (.+?) ===/.exec(input)?.[1] || 'out.txt';
    out(`=== FILE: ${file} ===\n${file.endsWith('.html') ? SITE_V2 : "console.log('hello world');"}\n=== END FILE ===`);
    return;
  }
  if (input.includes('Your FIRST line must be exactly one of these')) {
    // Triage: greetings are chat, "?" is a question, anything else a task.
    if (/selam|merhaba/i.test(request)) out('KIND: chat\nMerhaba! Ne yapalım?');
    else if (/bana sor/i.test(request)) {
      out('KIND: clarify\n```json\n' + JSON.stringify({
        questions: [
          { question: 'Hangi tema?', header: 'Tema', options: [{ label: 'Koyu (Önerilen)', description: 'koyu arka plan' }, { label: 'Açık' }] },
          { question: 'Hangi sayfalar?', header: 'Sayfalar', options: ['Blog', 'Projeler', 'İletişim'], multiSelect: true },
        ],
      }) + '\n```');
    }
    else if (request.includes('?')) out('KIND: question\nŞefin çözümü.\nRESULT: 42');
    else out('KIND: task\nTaslak: hello.js dosyası oluştur.');
  } else if (input.includes('give the final result on a line starting with "RESULT:"')) {
    out('Çözüm adımları.\nRESULT: 42');
  } else if (input.includes('answered the same question independently')) {
    out('Sonuç: 42 (ekip hemfikir)');
  } else if (behavior === 'noop' && input.includes('Produce the consensus plan')) {
    out('```json\n' + JSON.stringify({
      phase: 'PLAN_READY',
      summary: 'Somut görev yok',
      files_to_modify: [],
      questions: ['Ne inşa etmek istiyorsun?'],
    }) + '\n```');
  } else if (behavior === 'noop' && input.includes('Split the approved plan')) {
    out('```json\n{"tasks":[]}\n```');
  } else if (input.includes('Produce the consensus plan')) {
    out('```json\n' + JSON.stringify({
      phase: 'PLAN_READY',
      summary: site ? 'index.html oluşturulacak' : 'hello.js oluşturulacak',
      files_to_modify: [site ? 'index.html' : 'hello.js'],
      dependencies: [],
      risks: ['yok'],
    }) + '\n```');
  } else if (input.includes('Split the approved plan into file-level tasks')) {
    const worker = /"target_worker" must be one of: ([\w-]+)/.exec(input)?.[1] || 'w1';
    out('```json\n' + JSON.stringify({
      tasks: [
        { phase: 'CODING', target_worker: worker, action: 'create_file', file_path: site ? 'index.html' : 'hello.js', instruction: 'print hello', context_snippets: {} },
      ],
    }) + '\n```');
  } else if (input.includes('CODING_MODE. You are a WORKER')) {
    const file = /=== FILE: (.+?) ===/.exec(input)?.[1] || 'out.txt';
    out(`=== FILE: ${file} ===\n${file.endsWith('.html') ? SITE_V1 : "console.log('hello');"}\n=== END FILE ===`);
  } else if (input.includes('WORKER engineer reviewing')) {
    out('AGREE: plan iyi.\nOBJECT: yok.\nSUGGEST: yok.');
  } else {
    out('Taslak: hello.js dosyası oluştur.');
  }
}

function out(s) {
  process.stdout.write(s + '\n');
}
