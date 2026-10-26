export const DESCRIPTION =
  'Ask the local ninfer model typed decision questions (choice, score, or yes/no) about a context'

// This text is part of the cached tool schema. Keep it stable and free of
// dynamic values; endpoint overrides live in the environment.
export const PROMPT = `Ask the local ninfer decision model a set of typed questions about one context.

This is a structured scoring tool, not free-form generation. One call runs one prefill per question and returns the model's next-token probabilities over lettered options:
- choice: pick one option from a keyed set.
- score: rate along 2-10 ordered levels (lowest first); returns an expected level.
- noul: yes/no; returns P(true).

Use it for routing, classification, yes/no checks, and ordinal ratings when a structured answer or a probability is more useful than prose.

Request:
{
  "state": string | object | array,   // the context to judge; may be omitted when state_path or images provide it
  "state_path"?: string,              // local file whose exact text becomes state; preferred over pasting a file context
  "context_id"?: string,              // stable id for prefix reuse; omit state, state_path, and images on follow-ups
  "questions": {
    "<id>": {
      "type": "choice" | "score" | "noul",
      "instructions": string | any,     // the question
      "criteria": ...                   // choice: {optionKey: description|null}
                                        // score: ["lowest", ..., "highest"] (2-10 levels)
                                        // noul: {"true"?: description, "false"?: description}
    }
  },
  "files"?: string[], "images"?: string[],  // local image paths (preferred) or image data URLs, at most 8 total
  "temperature"?: number,                    // softmax temperature over option scores; default 1
  "request_xml"?: string                     // complete XML form below; use instead of all other fields
}

XML form (pass as request_xml):
<systemone state_path="/path/to/context.txt" temperature="1">
  <question id="angry" type="noul">Is the customer angry?</question>
  <question id="request" type="choice">
    What is the customer asking for?
    <option key="refund">a refund</option>
    <option key="shipping">shipping status</option>
  </question>
  <question id="urgency" type="score">
    How urgent is it?
    <level>low</level><level>medium</level><level>high</level>
  </question>
</systemone>
- Root attributes: state_path, context_id, temperature.
- State: root state_path, <state path="..."/>, <state>inline text</state>, <state_path>...</state_path>, or text directly inside <systemone>. Trimmed inline text; use state_path for exact file bytes.
- Question: id and type are attributes; instructions are the instructions attribute or the question's own text.
- choice: <option key="...">description</option>; score: <level>...</level> (2-10); noul: optional <true>/<false> descriptions.
- Images: <image path="..."/> or <image>data:...</image> (also inside <images>); <file> likewise.
- Do not combine request_xml with the structured fields. Escape &amp; and quotes in attributes. An XML follow-up can be <systemone context_id="...">questions</systemone>.

Rules:
- Put the context in state ONCE and ask every question about it in ONE call. The server prefills the state once and reuses its KV prefix for the remaining questions.
- For a file context, pass its path as state_path. The tool reads the file; do not Read it and paste its contents into state.
- For local images, pass their paths in files or images. The tool reads and base64-encodes them; do not Read the image or put base64 into the arguments yourself. When the images are the whole context, omit state (the tool sends it empty).
- For follow-ups about the SAME context, pass the returned context_id and omit state, state_path, and images. The tool resends the exact same state and resolved images so ninfer can restore its checkpoint. Do not edit or paraphrase the state between calls; if the context changed (including new images), send the new state/state_path and images (a new context id is fine).
- Images (paths or data URLs) are part of the context: their resolved bytes are cached under the context_id and resent automatically on follow-ups. Passing a context_id is enough to keep an image-based context identical.
- Do not put the question into state; state is only the material being judged.
- Limits: 64 questions, 52 choice options, 2-10 score levels, 8 images; local images must be PNG, JPEG, GIF, or WebP, up to 16 MB each; state_path files up to 16 MB.
- By default this tool calls the local/private model server you are logged into (the /login endpoint) at /v1/systemone; if the session uses a public API it falls back to http://127.0.0.1:8080. Override with SYSTEMONE_URL (full URL) or SYSTEMONE_BASE_URL; SYSTEMONE_API_KEY adds a bearer token. Use this tool instead of Bash/curl. If the server is down, report that instead of retrying.
- Probabilities are the model's label-token distribution, not calibrated. Use confidence as a relative signal.

Returns the server's answers and usage. The result text also names the context_id to reuse.`
