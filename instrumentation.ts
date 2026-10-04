// instrumentation.ts — runs once when the Next.js server starts (node_modules/next/dist/docs/01-app/02-guides/instrumentation.md).
// Starts the background live monitor (lib/monitor/scheduler.ts), which also keeps Windows awake while a
// session has open bets. MONITOR_SCHEDULER=off turns it off.

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.MONITOR_SCHEDULER === 'off') return
  const { startMonitorScheduler } = await import('./lib/monitor/scheduler')
  startMonitorScheduler()
}
