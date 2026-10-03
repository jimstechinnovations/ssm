import { describe, it, expect, vi, afterEach } from 'vitest'
vi.mock('server-only', () => ({}))
import { nimChat, nimModel, clearNimCache } from '@/lib/llm/nim'

const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
const fail = (status: number) => new Response('{"detail":"x"}', { status, statusText: 'Err' })

describe('NIM model fallback', () => {
  afterEach(() => { vi.unstubAllGlobals(); clearNimCache() })
  it('a server error on one model moves on to the next', async () => {
    process.env.NVIDIA_API_KEY = 'test'; delete process.env.NVIDIA_MODEL
    const models: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      const m = JSON.parse(String(init.body)).model as string; models.push(m)
      return models.length === 1 ? fail(500) : ok('hello')
    }))
    expect(await nimChat([{ role: 'user', content: 'a' }])).toBe('hello')
    expect(models.length).toBe(2)
    expect(nimModel()).toBe(models[1])
  })
  it('a bad request is ours and does not move on', async () => {
    process.env.NVIDIA_API_KEY = 'test'
    const f = vi.fn(async () => fail(400)); vi.stubGlobal('fetch', f)
    await expect(nimChat([{ role: 'user', content: 'b' }])).rejects.toThrow(/400/)
    expect(f).toHaveBeenCalledTimes(1)
  })
})
