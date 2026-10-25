// Role prompts for the two-phase loop. Kept in English for instruction-following;
// models are told to write prose in the language of the user's request.

const clip = (s, n = 6000) => (s && s.length > n ? `${s.slice(0, n)}\n...[truncated]` : s || '');

export const BASE_SYSTEM = `You are a member of KERBEROS, a multi-agent software team working inside one local workspace.
- You MUST NOT create, edit or delete files yourself and MUST NOT run commands that change anything. KERBEROS applies all changes.
- Read-only inspection of the workspace is allowed if your tools permit it.
- Be concise and concrete. No pleasantries, no restating the question.
- Write prose in the same natural language as the user's request.`;

export const PLANNING_RULES = `PLANNING_MODE rules:
- NEVER output full file contents or long code. Short signatures or <10 line snippets only when essential.
- Discuss architecture, file tree changes, data flow, dependencies, edge cases and risks.
- Reference concrete file paths relative to the workspace root.`;

const ARCH_PLAN_SHAPE = `{
  "phase": "PLAN_READY",
  "summary": "2-5 sentence summary of the agreed approach",
  "files_to_modify": ["relative/path.ext", "..."],
  "dependencies": ["npm-or-other-package", "..."],
  "risks": ["open risk or decision", "..."],
  "steps": ["ordered implementation step", "..."],
  "questions": ["clarifying question for the user", "..."]
}`;

const OUTCOME = {
  answered: 'answered, no file changes',
  applied: 'applied',
  partial: 'partially applied',
  rolledBack: 'rolled back by the user',
  cancelled: 'plan cancelled by the user',
  noop: 'no file changes',
  aborted: 'stopped by the user',
  failed: 'failed',
};
const HISTORY_TURNS = 6;
const HISTORY_CHARS = 6000;
const BRIEF_CHARS = 1500;
const SUMMARY_CHARS = 4000;

const oneLine = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** One line per turn that fell out of the detailed window. */
function briefTurn(t, n) {
  const files = t.files?.length ? ` → ${t.files.slice(0, 5).map((f) => f.path).join(', ')}${t.files.length > 5 ? `, +${t.files.length - 5}` : ''}` : '';
  return `- Turn ${n} (${OUTCOME[t.outcome] || t.outcome}): ${oneLine(t.request, 140)}${files}`;
}

/**
 * Earlier turns of this conversation, newest last, so follow-ups like "now add tests
 * for it" resolve. Context stays bounded however long the conversation gets:
 *   - a summary written by /compact (covers everything before `turns`),
 *   - one line per older turn (oldest dropped past BRIEF_CHARS),
 *   - the last HISTORY_TURNS turns in detail (within HISTORY_CHARS).
 */
export function renderHistory(turns = [], summary = null) {
  let start = Math.max(0, turns.length - HISTORY_TURNS);
  const detail = (t, n) => {
    const lines = [`### Turn ${n} (${OUTCOME[t.outcome] || t.outcome})`, `Request: ${clip(t.request, 800)}`];
    if (t.feedback?.length) lines.push(`User feedback: ${t.feedback.join(' / ')}`);
    if (t.answer) lines.push(`Answer: ${clip(t.answer, 800)}`);
    if (t.planSummary) lines.push(`Plan: ${clip(t.planSummary, 800)}`);
    if (t.files?.length) lines.push(`Files: ${t.files.map((f) => `${f.status || '?'} ${f.path}`).join(', ')}`);
    return lines.join('\n');
  };
  let blocks = turns.slice(start).map((t, i) => detail(t, start + i + 1));
  while (blocks.length > 1 && blocks.join('\n\n').length > HISTORY_CHARS) {
    blocks = blocks.slice(1);
    start++;
  }
  let brief = turns.slice(0, start).map((t, i) => briefTurn(t, i + 1));
  let omitted = 0;
  while (brief.length && brief.join('\n').length > BRIEF_CHARS) {
    brief = brief.slice(1);
    omitted++;
  }
  const parts = [];
  if (summary) parts.push(`### Summary of the conversation before these turns\n${clip(summary, SUMMARY_CHARS)}`);
  if (brief.length) parts.push(`### Older turns (brief)\n${omitted ? `- (${omitted} older turns omitted)\n` : ''}${brief.join('\n')}`);
  return [...parts, ...blocks].join('\n\n');
}

/** /compact: fold the conversation so far into a summary that replaces it in later prompts. */
export function compactHistory({ summary, turns, focus }) {
  return `You are the CHIEF of KERBEROS. Summarise this conversation so far so it can replace the full history in future prompts.
Write at most 25 short lines, in the language of the requests:
- what was asked and decided, in order,
- which files were created or changed and their current role (applied turns are in the workspace; rolled back or cancelled ones are not),
- open questions, pending ideas and user preferences that should carry over.
No code. No preamble.${focus ? `\nKeep the following especially: ${focus}` : ''}

${renderHistory(turns, summary)}`;
}

const requestText = (request) => (typeof request === 'string' ? request : request.text);

function context({ request, tree }) {
  const { history = [], summary = null, mentions = {} } = typeof request === 'string' ? {} : request;
  const past =
    history.length || summary
      ? `## Earlier in this conversation\nThe current request may refer to these turns. Files from applied turns are already in the workspace.\n${renderHistory(history, summary)}\n\n`
      : '';
  const files = Object.entries(mentions)
    .map(([p, c]) => `--- ${p} ---\n${c}`)
    .join('\n\n');
  return `${past}## User request
${requestText(request)}
${files ? `\n## Files the user mentioned with @\n${files}\n` : ''}
## Workspace tree
\`\`\`
${clip(tree, 12000)}
\`\`\``;
}

function renderTranscript(transcript) {
  return transcript.map((t) => `### ${t.label} (${t.role}, round ${t.round})\n${clip(t.text)}`).join('\n\n');
}

export function chiefDraft({ request, tree, previousPlan, feedback }) {
  const revise = previousPlan
    ? `\n\n## Previous plan (rejected or needs revision)\n\`\`\`json\n${JSON.stringify(previousPlan, null, 2)}\n\`\`\`\n## User feedback\n${feedback || '(none: produce an improved alternative)'}`
    : '';
  return `${PLANNING_RULES}

You are the CHIEF ARCHITECT. Produce a first architectural draft for the request below:
1. Goal and scope (what is in / out).
2. Proposed file tree changes (create / update), each with one line of purpose.
3. Key design decisions and why.
4. Dependencies to add.
5. Risks and open questions.

${context({ request, tree })}${revise}`;
}

export const KINDS = ['chat', 'question', 'task'];

/**
 * The chief's first call: decide what the message needs and answer in the same call,
 * so triage costs nothing extra. Chat ends here; a question goes to every agent;
 * a task continues the debate with this draft.
 */
export function chiefTriage({ request, tree }) {
  return `${PLANNING_RULES}

You are the CHIEF of a team of AI engineers. Decide what the user's message needs, then respond.
Your FIRST line must be exactly one of these, nothing else on it:
KIND: chat
KIND: question
KIND: task

- chat: greetings, thanks, small talk, or something you can answer correctly in a few sentences without real reasoning. Then reply to the user directly and briefly. The other engineers are NOT consulted, so do this only when the reply is trivial.
- question: anything that needs real reasoning but no change to the workspace: maths, algorithms, debugging ideas, explaining code, comparing designs. Then give your own complete answer (key steps, then the result). Other engineers will solve it independently and you will reconcile.
- task: the user wants files in the workspace created, changed or deleted. Then write the architectural draft:
  1. Goal and scope (what is in / out).
  2. Proposed file tree changes (create / update), each with one line of purpose.
  3. Key design decisions and why.
  4. Dependencies to add.
  5. Risks and open questions.

When unsure between chat and question, choose question. If any file change is asked for, choose task.

${context({ request, tree })}`;
}

/** Split the triage reply into its kind and the rest. Anything unparseable is a task draft. */
export function parseTriage(text) {
  const m = /^\s*(?:\*\*)?KIND:\s*(chat|question|task)\b(?:\*\*)?[^\n]*\n?/i.exec(String(text || ''));
  if (!m) return { kind: 'task', text: String(text || '').trim() };
  return { kind: m[1].toLowerCase(), text: text.slice(m[0].length).trim() };
}

export function answerQuestion({ request, tree, label }) {
  return `You are ${label}, an engineer on a team. Answer the user's question below on your own, carefully and correctly.
Show the key steps of your reasoning briefly, then give the final result on a line starting with "RESULT:".
Do not change any files.

${context({ request, tree })}`;
}

export function chiefAnswer({ request, own, answers }) {
  const rest = answers.map((a) => `### ${a.label}\n${clip(a.text, 5000)}`).join('\n\n');
  return `You are the CHIEF. You and other engineers answered the same question independently.
Compare the answers, check the reasoning yourself where they disagree, and give the user ONE final answer:
- the method in a few lines,
- the result, clearly,
- if the team disagreed, say on what and why your conclusion holds.
Write in the language of the question. Do not mention these instructions.

## Question
${requestText(request)}

## Your own answer
${clip(own, 5000)}

## The other answers
${rest}`;
}

export function workerCritique({ request, tree, draft, label, round, transcript }) {
  const earlier = transcript.length ? `\n\n## Debate so far\n${renderTranscript(transcript)}` : '';
  return `${PLANNING_RULES}

You are ${label}, a WORKER engineer reviewing the chief's draft (round ${round}).
Respond with:
- AGREE: points you accept (one line each).
- OBJECT: concrete problems, missing files, wrong assumptions, security or performance risks.
- SUGGEST: specific changes to the plan.
Keep it under 250 words.

${context({ request, tree })}

## Chief draft
${clip(draft, 10000)}${earlier}`;
}

export function chiefRevise({ request, tree, draft, transcript, round }) {
  return `${PLANNING_RULES}

You are the CHIEF ARCHITECT. Revise your draft using the workers' critiques from round ${round}. Accept good objections, reject weak ones with a one-line reason. Output the revised draft only.

${context({ request, tree })}

## Your current draft
${clip(draft, 10000)}

## Critiques
${renderTranscript(transcript.filter((t) => t.round === round && t.role === 'worker'))}`;
}

export function chiefSynthesize({ request, tree, draft, transcript }) {
  return `You are the CHIEF ARCHITECT. The debate is over. Produce the consensus plan.
Output ONLY one JSON object in a \`\`\`json fenced block with exactly this shape:
${ARCH_PLAN_SHAPE}
Paths must be relative to the workspace root. Do not include file contents.
If the request is too vague to act on, leave "files_to_modify" empty and put what you need to know in "questions"; the user answers them directly and the plan is redone. Never put questions to the user inside "steps".

${context({ request, tree })}

## Final draft
${clip(draft, 10000)}

## Debate transcript
${renderTranscript(transcript)}`;
}

export function chiefDecompose({ request, tree, plan, workers }) {
  return `You are the CHIEF ARCHITECT in CODING_MODE. Split the approved plan into file-level tasks.
Rules:
- Exactly one task per file. Use "create_file" for new files and "update_file" for existing ones.
- "target_worker" must be one of: ${workers.join(', ')}. Spread tasks across workers.
- "instruction" must be self-contained: what the file must contain, exported names, how it connects to the other files.
- "context_snippets" maps related workspace file paths to a short note on why they matter (KERBEROS fills in the real content).
Output ONLY a \`\`\`json fenced block:
{"tasks":[{"phase":"CODING","target_worker":"${workers[0]}","action":"create_file","file_path":"src/x.js","instruction":"...","context_snippets":{"src/y.js":"uses exported foo()"}}]}

${context({ request, tree })}

## Approved plan
\`\`\`json
${JSON.stringify(plan, null, 2)}
\`\`\``;
}

export function workerCode({ request, plan, task, snippets, tree }) {
  const snip = Object.entries(snippets)
    .map(([p, c]) => `--- ${p} ---\n${c}`)
    .join('\n\n');
  return `CODING_MODE. You are a WORKER engineer. Write the COMPLETE final content of exactly one file.
Output format (mandatory, nothing before or after):
=== FILE: ${task.file_path} ===
<entire file content, no markdown fences>
=== END FILE ===

Task: ${task.action} ${task.file_path}
Instruction: ${task.instruction}

## Original user request
${requestText(request)}

## Approved plan
\`\`\`json
${JSON.stringify(plan, null, 2)}
\`\`\`

## Workspace tree
\`\`\`
${clip(tree, 6000)}
\`\`\`
${snip ? `\n## Current contents of relevant files\n${snip}\n` : ''}`;
}

export function repairJson({ badOutput, error, shape }) {
  return `Your previous answer could not be parsed: ${error}
Return ONLY valid JSON in a \`\`\`json fenced block${shape ? ` with this shape:\n${shape}` : ''}.

Previous answer:
${clip(badOutput, 8000)}`;
}

export const SHAPES = { ARCH_PLAN: ARCH_PLAN_SHAPE };
