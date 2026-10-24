import { z } from 'zod';

const strList = z.array(z.coerce.string()).default([]);

/** Consensus plan, shown in the TUI and sent to Telegram. */
export const ArchPlanSchema = z.object({
  phase: z.literal('PLAN_READY').catch('PLAN_READY'),
  summary: z.string().min(1),
  files_to_modify: strList,
  dependencies: strList,
  risks: strList,
  steps: strList.optional(),
  questions: strList.optional(),
});

export const TaskSchema = z.object({
  phase: z.literal('CODING').catch('CODING'),
  target_worker: z.string().min(1),
  action: z.enum(['create_file', 'update_file']),
  file_path: z.string().min(1),
  instruction: z.string().min(1),
  context_snippets: z.record(z.string()).catch({}).default({}),
});

export const TaskListSchema = z.preprocess(
  (v) => (Array.isArray(v) ? { tasks: v } : v),
  z.object({ tasks: z.array(TaskSchema).min(1) }),
);

/** Collect every balanced {...} / [...] region that parses as JSON. */
function scanBalanced(text) {
  const results = [];
  for (let start = 0; start < text.length; start++) {
    const open = text[start];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) {
        try {
          results.push(JSON.parse(text.slice(start, i + 1)));
          start = i;
        } catch {
          // not valid JSON; keep scanning from the next start position
        }
        break;
      }
    }
  }
  return results;
}

/**
 * Pull a JSON value out of free-form model output. Prefers fenced ```json blocks,
 * then the whole text, then the largest balanced object/array.
 */
export function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Boş çıktı, JSON bulunamadı');
  const fences = [...text.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const body of fences.reverse()) {
    try {
      return JSON.parse(body);
    } catch {
      // try next
    }
  }
  try {
    return JSON.parse(text.trim());
  } catch {
    // fall through
  }
  const found = scanBalanced(text);
  if (!found.length) throw new Error('Çıktıda geçerli JSON bulunamadı');
  return found.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
}

/** extractJson + zod validation. Throws an Error with a readable reason on failure. */
export function parseWith(schema, text) {
  const raw = extractJson(text);
  const res = schema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `${i.path.join('.') || '(kök)'}: ${i.message}`).join('; ');
    throw new Error(`Şema doğrulaması başarısız: ${issues}`);
  }
  return res.data;
}

const ENVELOPE_RE = /^[ \t]*=== FILE: (.+?) ===[ \t]*\r?\n([\s\S]*?)\r?\n?^[ \t]*=== END FILE ===[ \t]*$/gm;

function stripWrappingFence(content) {
  const lines = content.split(/\r?\n/);
  if (lines.length >= 2 && /^```[\w+-]*\s*$/.test(lines[0]) && /^```\s*$/.test(lines[lines.length - 1])) {
    return lines.slice(1, -1).join('\n');
  }
  return content;
}

/**
 * Parse worker output written in the file envelope format:
 *   === FILE: path/to/file ===
 *   ...content...
 *   === END FILE ===
 */
export function parseFileEnvelope(text) {
  const files = [];
  for (const m of text.matchAll(ENVELOPE_RE)) {
    const content = stripWrappingFence(m[2]);
    files.push({ path: m[1].trim().replace(/^["'`]|["'`]$/g, ''), content: content.endsWith('\n') ? content : content + '\n' });
  }
  return files;
}

export function normalizeRel(p) {
  return String(p).trim().replace(/\\/g, '/').replace(/^\.\//, '');
}
