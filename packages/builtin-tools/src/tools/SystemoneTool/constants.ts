export const SYSTEMONE_TOOL_NAME = 'Systemone'

// Local ninfer-serve default. Override with SYSTEMONE_BASE_URL.
export const SYSTEMONE_DEFAULT_BASE_URL = 'http://127.0.0.1:8080'

// A cold prefill of a large state can take minutes; the tool call stays
// cancellable through the session abort signal.
export const SYSTEMONE_DEFAULT_TIMEOUT_MS = 300_000
export const SYSTEMONE_MIN_TIMEOUT_MS = 1_000
export const SYSTEMONE_MAX_TIMEOUT_MS = 600_000

// The decision response is small; the request can carry a large state.
export const SYSTEMONE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const SYSTEMONE_MAX_REQUEST_BYTES = 32 * 1024 * 1024

// Images are read and base64-encoded by the tool. Keep the per-file raw size
// and the total encoded size below the request cap so state still fits.
export const SYSTEMONE_MAX_IMAGES = 8
export const SYSTEMONE_MAX_IMAGE_BYTES = 16 * 1024 * 1024
export const SYSTEMONE_MAX_ENCODED_IMAGE_BYTES = 24 * 1024 * 1024

// A state file is read verbatim into the request; keep it within the cap.
export const SYSTEMONE_MAX_STATE_BYTES = 16 * 1024 * 1024

// The XML form is meant to stay compact (paths, not inline payloads).
export const SYSTEMONE_MAX_XML_BYTES = 4 * 1024 * 1024

// In-process cache of contexts referenced by context_id. It guarantees the
// exact same state bytes, including images, are resent so ninfer can restore
// its KV prefix. Image data URLs dominate the budget.
export const SYSTEMONE_CONTEXT_CACHE_ENTRIES = 16
export const SYSTEMONE_CONTEXT_CACHE_BYTES = 64 * 1024 * 1024
