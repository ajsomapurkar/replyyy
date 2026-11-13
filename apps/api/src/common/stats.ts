export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
export const median = (v: number[]) => quantile(v, 0.5);
export const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
export function gini(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const n = v.length, sum = v.reduce((a, b) => a + b, 0);
  if (!n || !sum) return 0;
  let acc = 0;
  v.forEach((x, i) => (acc += (2 * (i + 1) - n - 1) * x));
  return acc / (n * sum);
}
