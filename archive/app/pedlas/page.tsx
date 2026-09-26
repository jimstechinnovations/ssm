import { redirect } from 'next/navigation'

// The standalone /pedlas builder is superseded by the session flow (Bet Manager → session).
export default function LegacyPedlas() {
  redirect('/bet-manager')
}
