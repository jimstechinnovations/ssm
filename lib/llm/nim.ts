// lib/llm/nim.ts
// NVIDIA NIM client (OpenAI-compatible /chat/completions). Server-only.
//
// Reads config lazily from process.env so the rest of the system (and tests) work
// with no key configured — callers fall back to the deterministic path.
//   NVIDIA_API_KEY   (required to enable NIM)
//   NVIDIA_MODEL     (default meta/llama-3.3-70b-instruct)
//   NVIDIA_BASE_URL  (default https://integrate.api.nvidia.com/v1)
//
// Determinism aids: temperature 0 by default + an in-memory response cache keyed by
// a stable hash of (model, messages, options).

import 'server-only'

const DEFAULT_MODEL = 'meta/llama-3.3-70b-instruct'
const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1'

export interface NimMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface NimOptions {
  temperature?: number   // default 0
  maxTokens?: number     // default 2048
  json?: boolean         // request JSON object output
  timeoutMs?: number     // default 30000
}

export function nimConfigured(): boolean {
  const k = process.env.NVIDIA_API_KEY
  return !!k && k.trim() !== ''
}

export function nimModel(): string {
  return process.env.NVIDIA_MODEL?.trim() || DEFAULT_MODEL
}

function nimBaseUrl(): string {
  return process.env.NVIDIA_BASE_URL?.trim() || DEFAULT_BASE_URL
}

// ── Stable, dependency-free string hash for cache keys (FNV-1a 32-bit) ───────────
function hashKey(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

const responseCache = new Map<string, string>()

/** Best-effort JSON extraction (handles models that wrap JSON in prose or fences). */
export function parseJsonLoose<T = unknown>(text: string): T | null {
  try { return JSON.parse(text) as T } catch { /* fall through */ }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) { try { return JSON.parse(fenced[1]) as T } catch { /* */ } }
  const start = text.search(/[[{]/)
  if (start >= 0) {
    const open = text[start]
    const close = open === '[' ? ']' : '}'
    const end = text.lastIndexOf(close)
    if (end > start) { try { return JSON.parse(text.slice(start, end + 1)) as T } catch { /* */ } }
  }
  return null
}

/**
 * Calls NIM chat completions and returns the assistant message content.
 * Throws if not configured or on a non-OK response — callers should catch and fall back.
 */
export async function nimChat(messages: NimMessage[], opts: NimOptions = {}): Promise<string> {
  const apiKey = process.env.NVIDIA_API_KEY?.trim()
  if (!apiKey) throw new Error('nimChat: NVIDIA_API_KEY is not set')

  const model = nimModel()
  const temperature = opts.temperature ?? 0
  const max_tokens = opts.maxTokens ?? 2048

  const body: Record<string, unknown> = { model, messages, temperature, max_tokens }
  if (opts.json) body.response_format = { type: 'json_object' }

  const cacheKey = hashKey(JSON.stringify({ model, messages, temperature, max_tokens, json: !!opts.json }))
  const cached = responseCache.get(cacheKey)
  if (cached !== undefined) return cached

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000)
  try {
    const res = await fetch(`${nimBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`nimChat: ${res.status} ${res.statusText} ${detail.slice(0, 200)}`)
    }
    const json = await res.json() as { choices?: { message?: { content?: string } }[] }
    const content = json.choices?.[0]?.message?.content ?? ''
    responseCache.set(cacheKey, content)
    return content
  } finally {
    clearTimeout(timer)
  }
}

/** Test/maintenance helper. */
export function clearNimCache(): void {
  responseCache.clear()
}
