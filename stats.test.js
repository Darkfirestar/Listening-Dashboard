const S = require('../docs/stats.js');
let fails = 0;
const near = (a, b, tol, msg) => { const ok = Math.abs(a - b) <= tol; if (!ok) fails++; console.log((ok ? 'PASS  ' : 'FAIL  ') + msg + '  got ' + a + ' want ' + b); };

// known two-sided p-values from standard t tables
near(S.tTwoSidedP(2.228, 10), 0.05, 0.0006, 't=2.228, df=10 -> p 0.05');
near(S.tTwoSidedP(2.0, 10), 0.0734, 0.0005, 't=2.0, df=10 -> p 0.0734');
near(S.tTwoSidedP(1.96, 100000), 0.05, 0.0005, 't=1.96, df large -> p 0.05');
near(S.tTwoSidedP(0, 5), 1, 1e-9, 't=0 -> p 1');
near(S.tTwoSidedP(12.706, 1), 0.05, 0.0005, 't=12.706, df=1 -> p 0.05');
near(S.tTwoSidedP(3.169, 10), 0.01, 0.0003, 't=3.169, df=10 -> p 0.01');

// regression on a perfect and a known noisy line
const xs = [1, 2, 3, 4, 5, 6, 7, 8], perfect = xs.map((x) => 2 * x + 1);
const r1 = S.linreg(xs, perfect);
near(r1.slope, 2, 1e-12, 'perfect line slope'); near(r1.r2, 1, 1e-12, 'perfect line r2');
const ys = [2.1, 3.9, 6.2, 7.8, 10.1, 12.2, 13.8, 16.1];
const r2 = S.linreg(xs, ys);
near(r2.slope, 2.0, 0.05, 'noisy line slope'); near(r2.p, 0, 1e-6, 'noisy line p is tiny');
const flat = S.linreg(xs, [5, 5, 5, 5, 5, 5, 5, 5]);
near(flat.slope, 0, 1e-12, 'flat slope'); near(flat.p, 1, 1e-9, 'flat p = 1');

// Welch: reference values computed independently with scipy.stats.ttest_ind(equal_var=False)
const a = [27.5, 21.0, 19.0, 23.6, 17.0, 17.9, 16.9, 20.1, 21.9, 22.6, 23.1, 19.6, 19.0, 21.7, 21.4];
const b = [27.1, 22.0, 20.8, 23.4, 23.4, 23.5, 25.8, 22.0, 24.8, 20.2, 21.9, 22.1, 22.9, 23.5, 22.1];
const w = S.welch(a, b);
near(w.t, -2.565058914870545, 1e-9, 'welch t matches scipy'); near(w.p, 0.016994847045679, 1e-9, 'welch p matches scipy');
near(w.df, 23.9894633502594, 1e-6, 'welch df matches scipy'); near(w.d, -0.9366270860028808, 1e-9, "cohen's d matches");
near(r2.p, 4.888933612552941e-10, 1e-15, 'regression p matches scipy'); near(r2.r2, 0.9988392866011391, 1e-12, 'regression r2 matches scipy');

// descriptive
near(S.median([5, 1, 3]), 3, 1e-12, 'median'); near(S.percentile([1, 2, 3, 4, 5], 0.9), 4.6, 1e-12, 'p90');
near(S.sd([2, 4, 4, 4, 5, 5, 7, 9]), 2.138, 0.001, 'sample sd');
near(S.entropy([1, 1, 1, 1]).effective, 4, 1e-9, 'four equal items -> effective 4');
near(S.entropy([97, 1, 1, 1]).effective, 1.14, 0.05, 'one dominant item -> effective near 1');
near(S.gini([1, 1, 1, 1]), 0, 1e-12, 'gini equal'); near(S.gini([0, 0, 0, 10]), 0.75, 1e-12, 'gini one holds all of 4');
const st = S.streaks([10, 11, 12, 20, 21, 22, 23, 30], 23);
near(st.longest, 4, 0, 'longest streak'); near(st.current, 4, 0, 'current streak ending last day');
near(S.streaks([5, 6], 7).current, 2, 0, 'streak still alive if today not over');
near(S.streaks([5, 6], 9).current, 0, 0, 'streak broken after a missed day');
console.log(fails + ' failure(s)'); process.exit(fails ? 1 : 0);
