import { registerBundledSkill } from '../bundledSkills.js'

const SYSTEMONE_PROMPT = `# /systemone — typed decisions from the local model

Use the Systemone tool to ask the local ninfer model typed questions about a context. Do not substitute your own judgment when the user invoked /systemone; call the tool and report its answers. Do not call the endpoint with Bash/curl.

1. Build ONE context from what the user provides. If the context is in a file the user named, pass its path as state_path: the tool reads it, so do not Read the file or paste its contents. Otherwise put the text in state. For local images, pass their paths in files/images: the tool reads and encodes them, so do not Read the image or produce base64 yourself. If the images are the whole context, omit state.
2. Ask every question about that context in ONE Systemone call:
   - choice: criteria is an object mapping option keys to descriptions (or null).
   - score: criteria is an ordered array of 2-10 level descriptions, lowest first.
   - noul: yes/no; optional criteria descriptions for true and false.
   Batching matters: the server prefills the state once and reuses its KV prefix for the remaining questions.
3. The result includes a context_id. For follow-ups about the same context, call Systemone with that context_id and omit state, state_path, and images; the tool resends the exact cached bytes so ninfer restores its prefix. If the context or its images changed, send the new state/state_path/images (a new context id is fine).
4. If the context or the questions are missing, use AskUserQuestion before calling the tool.
5. You may pass the whole request as XML in request_xml instead of the structured fields: <systemone state_path="/tmp/doc.txt"><question id="q" type="noul">Is it urgent?</question></systemone>. Use <option key="...">description</option>, <level>, <true>/<false>, and <image path="..."/> inside it; the full grammar is in the tool prompt.
6. Report the decision concisely: the chosen option, the expected score or the yes/no probability, plus confidence. Mention that probabilities are uncalibrated if it matters.

Limits: 64 questions, 52 choice options, 2-10 score levels, 8 images (paths or data URLs; PNG, JPEG, GIF, or WebP), state_path files up to 16 MB. The tool defaults to the local/private model server configured in /login, at /v1/systemone, and falls back to http://127.0.0.1:8080; override with SYSTEMONE_URL or SYSTEMONE_BASE_URL. The server must be running.`

export function registerSystemoneSkill(): void {
  registerBundledSkill({
    name: 'systemone',
    description:
      'Ask the local ninfer model typed decision questions (choice, score, or yes/no) about a context.',
    whenToUse:
      'When the user asks for a typed classification, routing, yes/no, or rating decision from the local ninfer model, or explicitly invokes /systemone.',
    argumentHint: '[decision request]',
    allowedTools: ['Systemone'],
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = SYSTEMONE_PROMPT
      if (args.trim()) {
        prompt += `\n\n## User Request\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
