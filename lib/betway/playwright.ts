import 'server-only'

import { chromium } from 'playwright'
import type { APIResponse, Response as PlaywrightResponse } from 'playwright'
import type { Fixture, MarketType, OddsValue } from '../ssm/types'

const BETWAY_HIGHLIGHTS_URL = 'https://www.betway.com.ng/sport/soccer/highlights'
const BETWAY_FEED_URL = 'https://feeds-roa2.betwayafrica.com/br/_apis/sport/v1/BetBook/Highlights/'
const COUNTRY_CODE = 'NG'
const CULTURE_CODE = 'en-US'
const HIGH_LINES = new Set([4.5, 5.5, 6.5])
const CACHE_TTL_MS = 60_000

interface BetwayEvent {
  eventId: number
  isActive?: boolean
  isFinished?: boolean
  isLive?: boolean
  shouldDisplay?: boolean
  name?: string
  displayName?: string
  expectedStartEpoch?: number
  leagueId?: string
  league?: string
  homeTeam?: string
  awayTeam?: string
}

interface BetwayMarket {
  marketId: string
  eventId: number
  isActive?: boolean
  shouldDisplay?: boolean
  isSuspended?: boolean
  handicap?: number
  marketTypeCName?: string
  displayName?: string
  isSquashedParent?: boolean
}

interface BetwayOutcome {
  outcomeId: string
  eventId: number
  marketId: string
  originalMarketId?: string
  shouldDisplay?: boolean
  isTradingActive?: boolean
  name?: string
  displayName?: string
  sbv?: string
  handicap?: number
}

interface BetwayPrice {
  outcomeId: string
  priceDecimal?: number
}

interface BetwayFeed {
  events?: BetwayEvent[]
  markets?: BetwayMarket[]
  outcomes?: BetwayOutcome[]
  prices?: BetwayPrice[]
}

interface CacheEntry {
  expires: number
  fixtures: Fixture[]
  feedUrl: string
}

const cache = new Map<string, CacheEntry>()

function dateToEpochStart(date: string): number {
  return Math.floor(new Date(`${date}T00:00:00.000Z`).getTime() / 1000)
}

function dateToEpochEnd(date: string): number {
  return Math.floor(new Date(`${date}T23:59:59.999Z`).getTime() / 1000)
}

function buildFeedUrl(dateFrom: string, dateTo: string, take: number): string {
  const url = new URL(BETWAY_FEED_URL)
  url.searchParams.set('countryCode', COUNTRY_CODE)
  url.searchParams.set('sportId', 'soccer')
  url.searchParams.set('Skip', '0')
  url.searchParams.set('Take', String(take))
  url.searchParams.set('cultureCode', CULTURE_CODE)
  url.searchParams.set('isEsport', 'false')
  url.searchParams.set('boostedOnly', 'false')
  url.searchParams.set('fromStartEpoch', String(dateToEpochStart(dateFrom)))
  url.searchParams.set('toStartEpoch', String(dateToEpochEnd(dateTo)))
  url.searchParams.append('marketTypes', '[Total Goals]')
  return url.toString()
}

function buildPageUrl(dateFrom: string, dateTo: string): string {
  const url = new URL(BETWAY_HIGHLIGHTS_URL)
  url.searchParams.set('sortOrder', 'League')
  url.searchParams.set('fromStartEpoch', String(dateToEpochStart(dateFrom)))
  url.searchParams.set('toStartEpoch', String(dateToEpochEnd(dateTo)))
  return url.toString()
}

function hashLeagueId(leagueId: string | undefined, league: string | undefined): number {
  const input = leagueId || league || 'unknown'
  let hash = 0
  for (let i = 0; i < input.length; i++) hash = ((hash * 31) + input.charCodeAt(i)) | 0
  return Math.abs(hash) || 1
}

function isBetwayFeed(value: unknown): value is BetwayFeed {
  if (!value || typeof value !== 'object') return false
  const v = value as BetwayFeed
  return Array.isArray(v.events) && Array.isArray(v.markets) && Array.isArray(v.outcomes) && Array.isArray(v.prices)
}

async function responseJson(res: APIResponse | PlaywrightResponse): Promise<BetwayFeed | null> {
  if (!res.ok()) return null
  const json = await res.json().catch(() => null) as unknown
  return isBetwayFeed(json) ? json : null
}

function lineFromOutcome(outcome: BetwayOutcome, market?: BetwayMarket): number | null {
  if (typeof outcome.handicap === 'number' && HIGH_LINES.has(outcome.handicap)) return outcome.handicap
  if (typeof market?.handicap === 'number' && HIGH_LINES.has(market.handicap)) return market.handicap
  const match = outcome.sbv?.match(/(\d+(?:\.\d+)?)/)
  if (!match) return null
  const line = Number(match[1])
  return HIGH_LINES.has(line) ? line : null
}

function sideFromOutcome(outcome: BetwayOutcome): 'Over' | 'Under' | null {
  const raw = `${outcome.name ?? ''} ${outcome.displayName ?? ''}`.trim().toLowerCase()
  if (raw.startsWith('over')) return 'Over'
  if (raw.startsWith('under')) return 'Under'
  return null
}

function inDateRange(event: BetwayEvent, dateFrom: string, dateTo: string): boolean {
  if (typeof event.expectedStartEpoch !== 'number') return false
  const start = dateToEpochStart(dateFrom)
  const end = dateToEpochEnd(dateTo)
  return event.expectedStartEpoch >= start && event.expectedStartEpoch <= end
}

function respectsKickoffGap(event: BetwayEvent, minKickoffEpoch: number): boolean {
  if (event.isLive === true) return false
  if (typeof event.expectedStartEpoch !== 'number') return false
  return event.expectedStartEpoch >= minKickoffEpoch
}

export function parseBetwayFeedToFixtures(
  feed: BetwayFeed,
  dateFrom: string,
  dateTo: string,
  minKickoffEpoch = Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
): Fixture[] {
  const prices = new Map<string, number>()
  for (const price of feed.prices ?? []) {
    if (typeof price.priceDecimal === 'number' && price.priceDecimal > 1) {
      prices.set(price.outcomeId, price.priceDecimal)
    }
  }

  const markets = new Map<string, BetwayMarket>()
  for (const market of feed.markets ?? []) {
    markets.set(market.marketId, market)
  }

  const oddsByEvent = new Map<number, OddsValue[]>()
  for (const outcome of feed.outcomes ?? []) {
    if (outcome.shouldDisplay === false || outcome.isTradingActive === false) continue

    const price = prices.get(outcome.outcomeId)
    if (!price) continue

    const sourceMarketId = outcome.originalMarketId || outcome.marketId
    const market = markets.get(sourceMarketId) || markets.get(outcome.marketId)
    if (!market || market.shouldDisplay === false || market.isActive === false || market.isSuspended === true) continue

    const line = lineFromOutcome(outcome, market)
    const side = sideFromOutcome(outcome)
    if (line == null || side == null) continue

    const arr = oddsByEvent.get(outcome.eventId) ?? []
    arr.push({
      bookmaker: 'Betway Nigeria',
      market: `OVER_UNDER_${line}` as MarketType,
      label: `${side} ${line}`,
      value: price,
    })
    oddsByEvent.set(outcome.eventId, arr)
  }

  const fixtures: Fixture[] = []
  for (const event of feed.events ?? []) {
    if (event.shouldDisplay === false || event.isActive === false || event.isFinished === true) continue
    if (!respectsKickoffGap(event, minKickoffEpoch)) continue
    if (!event.homeTeam || !event.awayTeam || !inDateRange(event, dateFrom, dateTo)) continue

    const odds = oddsByEvent.get(event.eventId) ?? []
    const hasCompleteHighLine = [...HIGH_LINES].some((line) =>
      odds.some(o => o.market === `OVER_UNDER_${line}` && o.label === `Over ${line}`) &&
      odds.some(o => o.market === `OVER_UNDER_${line}` && o.label === `Under ${line}`),
    )
    if (!hasCompleteHighLine) continue

    const expectedStartEpoch = event.expectedStartEpoch
    if (typeof expectedStartEpoch !== 'number') continue

    fixtures.push({
      id: event.eventId,
      homeTeam: event.homeTeam,
      awayTeam: event.awayTeam,
      league: event.league || 'Betway Soccer',
      leagueId: hashLeagueId(event.leagueId, event.league),
      kickoff: new Date(expectedStartEpoch * 1000).toISOString(),
      odds,
    })
  }

  return fixtures.sort((a, b) => a.kickoff.localeCompare(b.kickoff))
}

export interface FetchBetwayFixturesOptions {
  dateFrom: string
  dateTo: string
  scanLimit?: number
  minKickoffGapMinutes?: number
}

export async function fetchBetwayPedlasFixtures(opts: FetchBetwayFixturesOptions): Promise<{
  fixtures: Fixture[]
  feedUrl: string
  source: 'playwright-feed' | 'playwright-page-capture' | 'cache'
}> {
  const take = Math.max(20, opts.scanLimit ?? 80)
  const minKickoffGapMinutes = opts.minKickoffGapMinutes ?? 60
  const minKickoffEpoch = Math.floor((Date.now() + minKickoffGapMinutes * 60_000) / 1000)
  const key = `${opts.dateFrom}:${opts.dateTo}:${take}:${minKickoffGapMinutes}:${Math.floor(minKickoffEpoch / 60)}`
  const cached = cache.get(key)
  if (cached && cached.expires > Date.now()) {
    return { fixtures: cached.fixtures, feedUrl: cached.feedUrl, source: 'cache' }
  }

  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({
      locale: 'en-US',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    })

    const feedUrl = buildFeedUrl(opts.dateFrom, opts.dateTo, take)
    const direct = await responseJson(await context.request.get(feedUrl, {
      headers: {
        accept: 'application/json',
        origin: 'https://www.betway.com.ng',
        referer: buildPageUrl(opts.dateFrom, opts.dateTo),
      },
      timeout: 45_000,
    }))

    if (direct) {
      const fixtures = parseBetwayFeedToFixtures(direct, opts.dateFrom, opts.dateTo, minKickoffEpoch)
      cache.set(key, { fixtures, feedUrl, expires: Date.now() + CACHE_TTL_MS })
      return { fixtures, feedUrl, source: 'playwright-feed' }
    }

    const page = await context.newPage()
    let captured: BetwayFeed | null = null
    page.on('response', async (res) => {
      if (captured || !res.url().includes('/BetBook/Highlights/')) return
      captured = await responseJson(res).catch(() => null)
    })
    await page.goto(buildPageUrl(opts.dateFrom, opts.dateTo), { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForTimeout(5_000)

    const fixtures = captured ? parseBetwayFeedToFixtures(captured, opts.dateFrom, opts.dateTo, minKickoffEpoch) : []
    cache.set(key, { fixtures, feedUrl, expires: Date.now() + CACHE_TTL_MS })
    return { fixtures, feedUrl, source: 'playwright-page-capture' }
  } finally {
    await browser.close()
  }
}
