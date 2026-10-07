import { useEffect, useState } from 'react';
import { DAY_MS, type ResetCalendarView, type ResetEvent } from '../../shared/resets';
import type { Snapshot } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function ResetCalendar({ snapshot }: { snapshot: Snapshot }) {
  const { lang } = useT();
  const zh = lang === 'zh';
  const [data, setData] = useState<ResetCalendarView>();
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [selected, setSelected] = useState(() => dayKey(new Date()));
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [url, setUrl] = useState('');
  useEffect(() => {
    let live = true;
    const get = () => api.resets().then((v) => { if (live) { setData(v); setError(''); } }, (e) => { if (live) setError(e.message); });
    void get();
    const timer = window.setInterval(get, 60_000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const run = async (action: () => Promise<ResetCalendarView>) => {
    setBusy(true); setError('');
    try { setData(await action()); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const locale = zh ? 'zh-CN' : 'en-GB';
  const time = (at: string) => new Date(at).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const labels: Record<ResetEvent['kind'], string> = zh
    ? { observed: '观测到回落', scheduled: '账户重置时间', estimated: '周期推测', reset: '重置公告', credit: '重置券消息', pledge: '条件承诺', announcement: '重置预告' }
    : { observed: 'Observed drop', scheduled: 'Account reset', estimated: 'Cycle estimate', reset: 'Reset announcement', credit: 'Reset credit', pledge: 'Conditional pledge', announcement: 'Advance notice' };
  const now = Date.now();
  const events = (data?.events ?? []).filter((e) => filter === 'all' || (filter === 'tibo' ? !!e.url : !e.url));
  const byDay = new Map<string, ResetEvent[]>();
  for (const event of events) {
    const key = dayKey(new Date(event.at));
    byDay.set(key, [...(byDay.get(key) ?? []), event]);
  }
  const offset = (month.getDay() + 6) % 7;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = Math.ceil((offset + days) / 7) * 7;
  const outlook = data?.outlook;
  const future = (data?.events ?? []).filter((e) => e.kind === 'scheduled' && Date.parse(e.at) > now).slice(0, 4);
  const posts = [...(data?.posts ?? [])].sort((a, b) => b.postedAt.localeCompare(a.postedAt));
  const fresh = data?.feed.state === 'ok' && data.feed.fetchedAt && now - Date.parse(data.feed.fetchedAt) < 60 * 60_000;
  const onMonth = (n: number) => { const d = new Date(month.getFullYear(), month.getMonth() + n, 1); setMonth(d); setSelected(dayKey(d)); };

  return <section className="card reset-calendar" aria-labelledby="reset-title">
    <header className="card-head">
      <div><h2 id="reset-title">{zh ? '重置日历与预测' : 'Reset calendar & outlook'}</h2><span className="muted tiny">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span></div>
      <button className="btn" disabled={busy} onClick={() => void run(api.refreshResets)}>{busy ? '…' : zh ? '刷新消息' : 'Refresh posts'}</button>
    </header>
    <div className="reset-summary">
      <div><b>{zh ? '账户下次重置' : 'Next account reset'}</b>
        {future.length ? future.map((e) => <p key={e.id} className="small">{e.provider === 'claude' ? 'Claude' : 'ChatGPT'} · {e.label}<br /><time dateTime={e.at}>{time(e.at)}</time></p>) : <p className="muted small">{zh ? '等待新鲜的账户重置时间。' : 'Waiting for a fresh account reset time.'}</p>}
      </div>
      <div><b>{zh ? 'Tibo 额外重置预测' : 'Tibo extra-reset outlook'}</b>
        {outlook?.from && outlook.to ? <>
          <p className="reset-range">{time(outlook.from)} — {time(outlook.to)}</p>
          <p className="muted tiny">{zh ? `低置信度 · ${outlook.samples} 次收录事件 · 间隔中位数 ${outlook.medianDays!.toFixed(1)} 天` : `Low confidence · ${outlook.samples} recorded events · median gap ${outlook.medianDays!.toFixed(1)} days`}</p>
          {outlook.overdue && <p className="small">{zh ? '历史估计区间已过，等待新公告；不会自动顺延。' : 'The estimated range has passed. Awaiting an announcement; the estimate is not rolled forward.'}</p>}
        </> : <p className="muted small">{zh ? `已收录 ${outlook?.samples ?? 0} 次重置，至少需要 4 次才能估计间隔。` : `${outlook?.samples ?? 0} resets recorded; at least 4 are needed to estimate an interval.`}</p>}
        <p className="muted tiny">{zh ? '按近 120 天已收录重置间隔的 25%–75% 分位数估计，记录可能不完整。这是额外重置的参考区间，不是账户恢复保证。' : 'Based on the middle 50% of recorded gaps over 120 days. History may be incomplete; this is not a guarantee of account recovery.'}</p>
      </div>
      <div><b>{zh ? '最新收录消息' : 'Latest collected post'}</b>
        {posts[0] && <p className="small"><a href={posts[0].url} target="_blank" rel="noreferrer">Tibo · {time(posts[0].postedAt)} ↗</a><br />{posts[0].text.slice(0, 400)}{posts[0].text.length > 400 ? '…' : ''}</p>}
        <p className="muted tiny">{fresh ? (zh ? '已读取公开时间线；X 可能不返回全部发言。' : 'Public timeline fetched; X may omit posts.') : (zh ? '当前显示缓存/已收录资料，尚未确认最新发言。' : 'Showing cached/reference data; latest posts are not confirmed.')}</p>
        {data?.feed.checkedAt && <p className="muted tiny">{zh ? '尝试更新：' : 'Last attempt: '}{time(data.feed.checkedAt)}</p>}
        {data?.feed.state === 'error' && <p className="muted tiny" title={data.feed.error}>{zh ? 'X 暂不可读取，保留已有资料。' : 'X is unavailable; previous records are retained.'}</p>}
      </div>
    </div>
    {outlook?.pledge && <p className="reset-pledge small"><a href={outlook.pledge.url} target="_blank" rel="noreferrer">{zh ? `${outlook.pledge.pledgeDays} 天条件承诺` : `${outlook.pledge.pledgeDays}-day conditional pledge`} ↗</a> · {zh ? '每天发布普遍适用的改进，或完整重置；不能据此推断每天必定重置。' : 'A broadly useful improvement or a full reset each day; this does not promise a reset every day.'} {zh ? '参考截止：' : 'Reference end: '}{time(new Date(Date.parse(outlook.pledge.postedAt) + outlook.pledge.pledgeDays! * DAY_MS).toISOString())}</p>}
    <div className="reset-toolbar">
      <div><button className="btn" aria-label={zh ? '上个月' : 'Previous month'} onClick={() => onMonth(-1)}>‹</button> <b>{month.toLocaleDateString(locale, { year: 'numeric', month: 'long' })}</b> <button className="btn" aria-label={zh ? '下个月' : 'Next month'} onClick={() => onMonth(1)}>›</button></div>
      <select aria-label={zh ? '筛选重置来源' : 'Filter reset sources'} value={filter} onChange={(e) => setFilter(e.target.value)}>
        <option value="all">{zh ? '全部来源' : 'All sources'}</option><option value="account">{zh ? '我的账户' : 'My accounts'}</option><option value="tibo">Tibo</option>
      </select>
    </div>
    <div className="reset-grid" role="group" aria-label={month.toLocaleDateString(locale, { year: 'numeric', month: 'long' })}>
      {(zh ? ['一', '二', '三', '四', '五', '六', '日'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']).map((d) => <span className="reset-weekday muted tiny" key={d}>{d}</span>)}
      {Array.from({ length: cells }, (_, i) => {
        const day = i - offset + 1;
        if (day < 1 || day > days) return <span className="reset-day empty" key={i} />;
        const date = new Date(month.getFullYear(), month.getMonth(), day);
        const key = dayKey(date);
        const es = byDay.get(key) ?? [];
        const inRange = filter !== 'account' && outlook?.from && outlook.to && key >= dayKey(new Date(outlook.from)) && key <= dayKey(new Date(outlook.to));
        return <button key={i} type="button" className={`reset-day ${selected === key ? 'selected' : ''} ${key === dayKey(new Date()) ? 'today' : ''} ${inRange ? 'predicted' : ''}`} aria-pressed={selected === key} aria-label={`${date.toLocaleDateString(locale)} · ${es.length} ${zh ? '条记录' : 'events'}${inRange ? (zh ? ' · 预测区间' : ' · estimated range') : ''}`} onClick={() => setSelected(key)}>
          <span>{day}</span><span className="reset-dots">{[...new Set(es.map((e) => e.kind))].map((kind) => <i className={`reset-dot ${kind}`} key={kind} title={labels[kind]} />)}</span>{es.length > 0 && <small>{es.length}</small>}
        </button>;
      })}
    </div>
    <div className="reset-legend tiny">{(['scheduled', 'observed', 'reset', 'credit', 'estimated', 'pledge', 'announcement'] as const).map((kind) => <span key={kind}><i className={`reset-dot ${kind}`} />{labels[kind]}</span>)}<span>▧ {zh ? '额外重置预测区间' : 'Extra-reset estimate'}</span></div>
    <div className="reset-day-events" aria-live="polite"><b className="small">{selected}</b>
      {filter !== 'account' && outlook?.from && outlook.to && selected >= dayKey(new Date(outlook.from)) && selected <= dayKey(new Date(outlook.to)) && <p className="small">{zh ? '这一天在额外重置的历史估计区间内，置信度低，尚无具体日期承诺。' : 'This day falls in the historical estimate for an extra reset. Confidence is low; no date is promised.'}</p>}
      {!(byDay.get(selected)?.length) && <p className="muted small">{zh ? '这一天暂无收录记录；不代表没有发生重置。' : 'No records for this day; this does not establish that no reset happened.'}</p>}
      {(byDay.get(selected) ?? []).map((e) => <p key={e.id} className="small"><i className={`reset-dot ${e.kind}`} /> {time(e.at)} · {e.url ? 'Tibo' : `${e.provider === 'claude' ? 'Claude' : 'ChatGPT'} · ${e.label}`} · {labels[e.kind]} {e.url && <a href={e.url} target="_blank" rel="noreferrer">↗</a>}{e.source === 'reference' && <span className="muted"> · {zh ? '报道收录' : 'Reported by reference'}</span>}{e.after && <span className="muted"> · {zh ? '发生于' : 'Between'} {time(e.after)} – {time(e.at)}</span>}</p>)}
    </div>
    <details className="reset-sources"><summary className="small">{zh ? '消息来源与补充链接' : 'Sources & add a post'}</summary>
      <p className="muted tiny">{zh ? '每 30 分钟尝试读取 @thsottiaux 的公开时间线。也可粘贴遗漏的原帖链接，读取后加入记录。预告只标在发言当天，不会伪造执行时间。' : 'Tries the public @thsottiaux timeline every 30 minutes. Add a missed post by URL. Advance notices are dated by publication, not an invented execution time.'}</p>
      <form onSubmit={(e) => { e.preventDefault(); void run(async () => { const next = await api.importResetPost(url); setUrl(''); return next; }); }}>
        <input type="url" aria-label={zh ? 'Tibo 原帖链接' : 'Tibo post URL'} placeholder="https://x.com/thsottiaux/status/…" value={url} onChange={(e) => setUrl(e.target.value)} required />
        <button className="btn" disabled={busy || !url.trim()}>{zh ? '读取原帖' : 'Read post'}</button>
      </form>
      {posts.slice(0, 12).map((p) => <p key={p.id} className="tiny"><a href={p.url} target="_blank" rel="noreferrer">{time(p.postedAt)} · Tibo ↗</a> · {p.text} {p.referenceUrl && <a href={p.referenceUrl} target="_blank" rel="noreferrer">{zh ? '收录来源' : 'Reference'}</a>}</p>)}
      <p className="muted tiny">{zh ? `账户记录属于 ${snapshot.machineName}；两次新鲜观测间额度从较高值降到 10% 以下才记录回落。定时重置和重置券消息不参与额外重置预测。` : `Account observations belong to ${snapshot.machineName}. Only a substantial drop to 10% or less between fresh samples is recorded. Scheduled resets and reset credits are excluded from extra-reset predictions.`}</p>
    </details>
    {error && <p className="action-msg small" role="alert">{error}</p>}
  </section>;
}
