import type { Dict, Lang } from './i18n';

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export function fmtUsd(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: n < 100 ? 2 : 0 });
}

export function fmtDuration(ms: number, lang: Lang): string {
  if (ms <= 0) return lang === 'zh' ? '即将' : 'now';
  const m = Math.round(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (lang === 'zh') return d ? `${d}天${h}小时` : h ? `${h}小时${mm}分` : `${mm}分钟`;
  return d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`;
}

export function relTime(iso: string | undefined, t: Dict, lang: Lang): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (ms < 45_000) return t.justNow;
  return lang === 'zh' ? `${fmtDuration(ms, lang)}${t.ago}` : `${fmtDuration(ms, lang)} ${t.ago}`;
}

export function shortDate(date: string, lang: Lang): string {
  const [, m, d] = date.split('-');
  return lang === 'zh' ? `${Number(m)}/${Number(d)}` : `${Number(m)}/${Number(d)}`;
}

export function shortPath(p?: string): string {
  if (!p) return '';
  return p.replace(/^\/home\/[^/]+/, '~').replace(/^C:\\Users\\[^\\]+/i, '~');
}
