/* Statistics helpers. Pure functions, no DOM, so they can be tested in Node. */
(function (root) {
  'use strict';

  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const mean = (a) => (a.length ? sum(a) / a.length : NaN);

  function variance(a) {
    if (a.length < 2) return NaN;
    const m = mean(a);
    return a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1);
  }
  const sd = (a) => Math.sqrt(variance(a));

  function percentile(arr, p) {
    if (!arr.length) return NaN;
    const a = Array.from(arr).sort((x, y) => x - y);
    const idx = (a.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return a[lo] + (a[hi] - a[lo]) * (idx - lo);
  }
  const median = (a) => percentile(a, 0.5);

  // ---- Student t distribution via the regularized incomplete beta function
  function lgamma(x) {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) ser += c[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }

  function betacf(a, b, x) {
    const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }

  function betai(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
  }

  // Two-sided p-value for a t statistic with df degrees of freedom.
  function tTwoSidedP(t, df) {
    if (!isFinite(t) || !(df > 0)) return NaN;
    return betai(df / 2, 0.5, df / (df + t * t));
  }

  // Welch's t-test (unequal variances) plus Cohen's d.
  function welch(a, b) {
    if (a.length < 2 || b.length < 2) return null;
    const ma = mean(a), mb = mean(b), va = variance(a), vb = variance(b);
    const na = a.length, nb = b.length;
    const se2 = va / na + vb / nb;
    if (!(se2 > 0)) return null;
    const t = (ma - mb) / Math.sqrt(se2);
    const df = se2 * se2 / ((va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1));
    const pooled = Math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2));
    return { t, df, p: tTwoSidedP(t, df), meanA: ma, meanB: mb, d: pooled > 0 ? (ma - mb) / pooled : NaN };
  }

  // Ordinary least squares y = intercept + slope * x, with a t-test on the slope.
  function linreg(xs, ys) {
    const n = xs.length;
    if (n < 3) return null;
    const mx = mean(xs), my = mean(ys);
    let sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx, dy = ys[i] - my;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    if (!(sxx > 0)) return null;
    const slope = sxy / sxx, intercept = my - slope * mx;
    const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
    const sse = Math.max(syy - slope * sxy, 0);
    const df = n - 2;
    const se = df > 0 ? Math.sqrt(sse / df / sxx) : NaN;
    const t = se > 0 ? slope / se : (slope === 0 ? 0 : Infinity);
    const p = isFinite(t) ? tTwoSidedP(t, df) : 0;
    return { slope, intercept, r2, se, t, df, p, n };
  }

  // Shannon entropy in nats and the "effective number" of equally used items (e^H).
  function entropy(weights) {
    const total = sum(weights);
    if (!(total > 0)) return { H: 0, effective: 0 };
    let H = 0;
    for (const w of weights) {
      if (w > 0) { const p = w / total; H -= p * Math.log(p); }
    }
    return { H, effective: Math.exp(H) };
  }

  // Gini coefficient: 0 = every item used equally, near 1 = one item takes everything.
  function gini(weights) {
    const a = weights.filter((w) => w >= 0).sort((x, y) => x - y);
    const n = a.length, total = sum(a);
    if (n < 2 || !(total > 0)) return 0;
    let acc = 0;
    for (let i = 0; i < n; i++) acc += (i + 1) * a[i];
    return (2 * acc) / (n * total) - (n + 1) / n;
  }

  // Longest and current run of consecutive integers in a set of day numbers.
  function streaks(dayNumbers, lastDay) {
    const days = Array.from(new Set(dayNumbers)).sort((a, b) => a - b);
    if (!days.length) return { longest: 0, longestEnd: null, current: 0 };
    let longest = 1, longestEnd = days[0], run = 1;
    for (let i = 1; i < days.length; i++) {
      run = days[i] === days[i - 1] + 1 ? run + 1 : 1;
      if (run > longest) { longest = run; longestEnd = days[i]; }
    }
    let current = 0;
    const set = new Set(days);
    let d = set.has(lastDay) ? lastDay : lastDay - 1; // today may not be over yet
    while (set.has(d)) { current++; d--; }
    return { longest, longestEnd, current };
  }

  const api = { sum, mean, variance, sd, percentile, median, lgamma, betai, tTwoSidedP, welch, linreg, entropy, gini, streaks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Stats = api;
})(typeof self !== 'undefined' ? self : this);
