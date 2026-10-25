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
    default:
      respond();
  }
});

function respond() {
  const request = /## User request\n([^\n]*)/.exec(input)?.[1] || '';
  if (input.includes('Your FIRST line must be exactly one of these')) {
    // Triage: greetings are chat, "?" is a question, anything else a task.
    if (/selam|merhaba/i.test(request)) out('KIND: chat\nMerhaba! Ne yapalım?');
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
      summary: 'hello.js oluşturulacak',
      files_to_modify: ['hello.js'],
      dependencies: [],
      risks: ['yok'],
    }) + '\n```');
  } else if (input.includes('Split the approved plan into file-level tasks')) {
    const worker = /"target_worker" must be one of: ([\w-]+)/.exec(input)?.[1] || 'w1';
    out('```json\n' + JSON.stringify({
      tasks: [
        { phase: 'CODING', target_worker: worker, action: 'create_file', file_path: 'hello.js', instruction: 'print hello', context_snippets: {} },
      ],
    }) + '\n```');
  } else if (input.includes('CODING_MODE. You are a WORKER')) {
    const file = /=== FILE: (.+?) ===/.exec(input)?.[1] || 'out.txt';
    out(`=== FILE: ${file} ===\nconsole.log('hello');\n=== END FILE ===`);
  } else if (input.includes('WORKER engineer reviewing')) {
    out('AGREE: plan iyi.\nOBJECT: yok.\nSUGGEST: yok.');
  } else {
    out('Taslak: hello.js dosyası oluştur.');
  }
}

function out(s) {
  process.stdout.write(s + '\n');
}
