// Minimal Prometheus text-format metrics: counters and histograms kept in
// process, plus gauges read at scrape time (from the database).

type Labels = Record<string, string>;
const key = (l: Labels) => Object.keys(l).sort().map((k) => `${k}="${String(l[k]).replace(/["\\\n]/g, '_')}"`).join(',');

export class Metrics {
  private counters = new Map<string, { help: string; values: Map<string, number> }>();
  private hists = new Map<string, { help: string; buckets: number[]; series: Map<string, { counts: number[]; sum: number; count: number }> }>();
  private gauges: (() => Promise<string>)[] = [];

  inc(name: string, help: string, labels: Labels = {}, by = 1): void {
    let c = this.counters.get(name);
    if (!c) this.counters.set(name, (c = { help, values: new Map() }));
    const k = key(labels);
    c.values.set(k, (c.values.get(k) ?? 0) + by);
  }

  observe(name: string, help: string, seconds: number, labels: Labels = {}, buckets = [0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2.5, 5, 10]): void {
    let h = this.hists.get(name);
    if (!h) this.hists.set(name, (h = { help, buckets, series: new Map() }));
    const k = key(labels);
    let s = h.series.get(k);
    if (!s) h.series.set(k, (s = { counts: h.buckets.map(() => 0), sum: 0, count: 0 }));
    h.buckets.forEach((b, i) => {
      if (seconds <= b) s!.counts[i]!++;
    });
    s.sum += seconds;
    s.count++;
  }

  /** A gauge family computed at scrape time; return Prometheus lines. */
  gauge(fn: () => Promise<string>): void {
    this.gauges.push(fn);
  }

  static lines(name: string, help: string, type: 'gauge' | 'counter', rows: { labels: Labels; value: number }[]): string {
    return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...rows.map((r) => `${name}${Object.keys(r.labels).length ? `{${key(r.labels)}}` : ''} ${r.value}`)].join('\n');
  }

  async render(): Promise<string> {
    const out: string[] = [];
    for (const [name, c] of this.counters) {
      out.push(`# HELP ${name} ${c.help}`, `# TYPE ${name} counter`);
      for (const [k, v] of c.values) out.push(`${name}${k ? `{${k}}` : ''} ${v}`);
    }
    for (const [name, h] of this.hists) {
      out.push(`# HELP ${name} ${h.help}`, `# TYPE ${name} histogram`);
      for (const [k, s] of h.series) {
        const pre = k ? `${k},` : '';
        h.buckets.forEach((b, i) => out.push(`${name}_bucket{${pre}le="${b}"} ${s.counts[i]}`));
        out.push(`${name}_bucket{${pre}le="+Inf"} ${s.count}`, `${name}_sum${k ? `{${k}}` : ''} ${s.sum}`, `${name}_count${k ? `{${k}}` : ''} ${s.count}`);
      }
    }
    for (const g of this.gauges) out.push(await g().catch((e) => `# gauge error: ${String(e).replace(/\n/g, ' ')}`));
    return out.join('\n') + '\n';
  }
}
