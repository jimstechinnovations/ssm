import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { searchFixtures } from '@/lib/football-api/client'

const QuerySchema = z.object({
  search: z.string().min(1).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  league: z.coerce.number().int().positive().optional(),
})

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl

  const raw = {
    search: searchParams.get('search') ?? undefined,
    date: searchParams.get('date') ?? undefined,
    league: searchParams.get('league') ?? undefined,
  }

  const parsed = QuerySchema.safeParse(raw)

  if (!parsed.success) {
    return Response.json(
      { error: 'Invalid query parameters', details: parsed.error.flatten() },
      { status: 400 },
    )
  }

  const fixtures = await searchFixtures(parsed.data)

  return Response.json({ fixtures })
}
