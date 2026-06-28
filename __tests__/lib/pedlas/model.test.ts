// __tests__/lib/pedlas/model.test.ts
// The learnable model actually learns: on held-out data it beats the base-rate baseline.

import { describe, it, expect } from 'vitest'
import { trainLogReg, predictLogReg, logLoss } from '../../../lib/pedlas/model'

function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

describe('logistic-regression model', () => {
  it('learns a real signal and beats base-rate log-loss out-of-sample', () => {
    const rnd = mulberry32(7)
    // y depends on two features (+ noise); a third feature is pure noise.
    const X: number[][] = [], y: number[] = []
    for (let i = 0; i < 600; i++) {
      const a = rnd() * 2 - 1, b = rnd() * 2 - 1, noise = rnd() * 2 - 1
      const logit = 1.6 * a - 1.1 * b + (rnd() - 0.5) * 0.8
      X.push([a, b, noise]); y.push(1 / (1 + Math.exp(-logit)) > rnd() ? 1 : 0)
    }
    const tr = 450
    const model = trainLogReg(X.slice(0, tr), y.slice(0, tr), { featureNames: ['a', 'b', 'noise'] })
    const Xte = X.slice(tr), yte = y.slice(tr)
    const preds = Xte.map(x => predictLogReg(model, x))
    const base = yte.reduce((s, v) => s + v, 0) / yte.length
    const modelLoss = logLoss(preds, yte)
    const baseLoss = logLoss(yte.map(() => base), yte)
    expect(modelLoss).toBeLessThan(baseLoss)                 // model adds information
    // learned the right signs, and shrank the noise weight
    expect(model.weights[0]).toBeGreaterThan(0)
    expect(model.weights[1]).toBeLessThan(0)
    expect(Math.abs(model.weights[2])).toBeLessThan(Math.abs(model.weights[0]))
  })

  it('predicts in [0,1]', () => {
    const m = trainLogReg([[0, 0], [1, 1], [0, 1], [1, 0]], [0, 1, 0, 1])
    for (const x of [[0, 0], [1, 1], [2, -1]]) {
      const p = predictLogReg(m, x); expect(p).toBeGreaterThanOrEqual(0); expect(p).toBeLessThanOrEqual(1)
    }
  })
})
