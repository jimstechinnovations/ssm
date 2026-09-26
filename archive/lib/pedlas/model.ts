// lib/pedlas/model.ts
// A small, self-contained learnable classifier (logistic regression) trained by gradient descent
// with feature standardisation + L2 regularisation. This is "our own model with tunable parameters,
// like a neural-net layer" — used to learn a calibrated P(outcome) from history + odds features.
// Pure, no I/O. Honest: whether it beats the book is an empirical question measured by backtest.

export interface LogRegModel {
  weights: number[]
  bias: number
  mean: number[]
  std: number[]
  features: string[]   // feature names (for interpretability)
}

export interface TrainOptions {
  lr?: number          // learning rate (default 0.3)
  epochs?: number      // full-batch passes (default 400)
  l2?: number          // L2 penalty (default 1e-3)
  featureNames?: string[]
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z))

function standardise(X: number[][]): { Z: number[][]; mean: number[]; std: number[] } {
  const n = X.length, d = X[0]?.length ?? 0
  const mean = new Array(d).fill(0), std = new Array(d).fill(0)
  for (const row of X) for (let j = 0; j < d; j++) mean[j] += row[j]
  for (let j = 0; j < d; j++) mean[j] /= (n || 1)
  for (const row of X) for (let j = 0; j < d; j++) std[j] += (row[j] - mean[j]) ** 2
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / (n || 1)) || 1
  const Z = X.map(row => row.map((v, j) => (v - mean[j]) / std[j]))
  return { Z, mean, std }
}

/** Train logistic regression on X (rows of features) → y (0/1). Full-batch gradient descent. */
export function trainLogReg(X: number[][], y: number[], opts: TrainOptions = {}): LogRegModel {
  const lr = opts.lr ?? 0.3, epochs = opts.epochs ?? 400, l2 = opts.l2 ?? 1e-3
  const n = X.length, d = X[0]?.length ?? 0
  const { Z, mean, std } = standardise(X)
  const w = new Array(d).fill(0)
  let b = 0
  for (let e = 0; e < epochs; e++) {
    const gw = new Array(d).fill(0)
    let gb = 0
    for (let i = 0; i < n; i++) {
      let z = b
      for (let j = 0; j < d; j++) z += w[j] * Z[i][j]
      const err = sigmoid(z) - y[i]
      gb += err
      for (let j = 0; j < d; j++) gw[j] += err * Z[i][j]
    }
    b -= lr * (gb / (n || 1))
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / (n || 1) + l2 * w[j])
  }
  return { weights: w, bias: b, mean, std, features: opts.featureNames ?? X[0]?.map((_, j) => `f${j}`) ?? [] }
}

/** Predict calibrated probability for one feature row. */
export function predictLogReg(m: LogRegModel, x: number[]): number {
  let z = m.bias
  for (let j = 0; j < m.weights.length; j++) z += m.weights[j] * ((x[j] - m.mean[j]) / m.std[j])
  return sigmoid(z)
}

// ── Scoring helpers (lower is better) ────────────────────────────────────────────
export function logLoss(p: number[], y: number[]): number {
  const eps = 1e-9
  return -p.reduce((s, pi, i) => s + (y[i] ? Math.log(pi + eps) : Math.log(1 - pi + eps)), 0) / (p.length || 1)
}
export function brier(p: number[], y: number[]): number {
  return p.reduce((s, pi, i) => s + (pi - y[i]) ** 2, 0) / (p.length || 1)
}
