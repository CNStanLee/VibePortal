import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityVerb, LaunchAgent, LaunchOptions, PendingPermission, Snapshot } from '../../shared/types';
import {
  DESK_H,
  DESK_W,
  OFFICE_GRANTS,
  OFFICE_ROLES,
  ROLE_GRANTS,
  autoLayout,
  cascadeGrants,
  chainOf,
  childrenOf,
  estimateTeam,
  fitToBudget,
  newOfficeId,
  wouldCycle,
  type OfficeAsk,
  type OfficeGrant,
  type OfficeNode,
  type OfficeReview,
  type OfficeNodeState,
  type OfficeRole,
  type OfficeRun,
  type OfficeRunNode,
  type OfficeTeam,
  type OfficeView,
} from '../../shared/office';
import { api, cachedLaunchOptions } from '../api';
import { isDemo } from '../demo';
import { fmt, useT, type Dict } from '../i18n';
import { fmtTokens, fmtUsd, relTime } from '../format';
import { Mascot, type CrabScene, type MascotKind } from './Mascots';
import { ClaudeMark, CodexMark } from './Brand';

const ROLE_KEY: Record<OfficeRole, keyof Dict> = {
  lead: 'roleLead',
  manager: 'roleManager',
  engineer: 'roleEngineer',
  researcher: 'roleResearcher',
  reviewer: 'roleReviewer',
  tester: 'roleTester',
  writer: 'roleWriter',
};
const ROLE_ICON: Record<OfficeRole, string> = { lead: '👑', manager: '📋', engineer: '🛠', researcher: '🔎', reviewer: '🧐', tester: '🧪', writer: '✍' };
/** what a new desk of each role starts with */
const ROLE_DEFAULTS: Record<OfficeRole, Pick<OfficeNode, 'model' | 'effort'>> = {
  lead: { model: 'opus', effort: 'high' },
  manager: { model: 'sonnet', effort: 'medium' },
  engineer: { model: 'sonnet', effort: 'medium' },
  researcher: { model: 'haiku', effort: 'medium' },
  reviewer: { model: 'sonnet', effort: 'medium' },
  tester: { model: 'haiku', effort: 'medium' },
  writer: { model: 'haiku', effort: 'low' },
};
const GRANT_KEY: Record<OfficeGrant, keyof Dict> = { edit: 'grantEdit', run: 'grantRun', git: 'grantGit', web: 'grantWeb', tools: 'grantTools' };
const GRANT_ICON: Record<OfficeGrant, string> = { edit: '✏️', run: '▶️', git: '⎇', web: '🌐', tools: '🧩' };
const REVIEW_KEY: Record<OfficeReview, keyof Dict> = { agent: 'reviewAgent', auto: 'reviewAuto', user: 'reviewUser' };
const ASK_KEY: Record<OfficeAsk['state'], keyof Dict> = { reviewing: 'askReviewing', allowed: 'askAllowed', denied: 'askDenied', user: 'askUser' };
/** team-wide permission presets: the top of the team gets the set, everyone else its role's share of it */
const PRESETS: { key: keyof Dict; grants: OfficeGrant[] }[] = [
  { key: 'presetRead', grants: [] },
  { key: 'presetEdit', grants: ['edit'] },
  { key: 'presetBuild', grants: ['edit', 'run'] },
  { key: 'presetAll', grants: ['edit', 'run', 'git', 'web', 'tools'] },
];
const STATE_KEY: Record<OfficeNodeState, keyof Dict> = { waiting: 'deskWaiting', running: 'deskRunning', done: 'deskDone', failed: 'deskFailed', skipped: 'deskSkipped' };
const RUN_KEY: Record<OfficeRun['state'], keyof Dict> = { running: 'officeRunRunning', done: 'officeRunDone', failed: 'officeRunFailed', stopped: 'officeRunStopped', 'over-budget': 'officeRunOver' };
const VERB_ICON: Partial<Record<ActivityVerb, string>> = { read: '📖', edit: '⌨', write: '⌨', run: '▶', search: '🔍', web: '🌐', agent: '🤝', ask: '❓', wait: '⏳' };
const SCENE_OF: Partial<Record<ActivityVerb, CrabScene>> = { read: 'read', edit: 'code', write: 'code', run: 'code', search: 'search', web: 'search' };

const B_MIN = 0.5;
const B_MAX = 200;
const toSlider = (b: number) => Math.round((100 * Math.log(Math.max(B_MIN, b) / B_MIN)) / Math.log(B_MAX / B_MIN));
const fromSlider = (v: number) => {
  const b = B_MIN * (B_MAX / B_MIN) ** (v / 100);
  return b < 10 ? Math.round(b * 10) / 10 : Math.round(b);
};
const TEAM_KEY = 'vp.office.team';
/** minutes without new tokens before a working desk says it may be stuck */
const QUIET_MIN = 5;
const RECENT_MS = 30 * 60_000;

const blankTeam = (t: Dict, budget = 5): OfficeTeam => ({ id: newOfficeId('t'), name: t.officeNewTeamName, goal: '', budget, nodes: [], updatedAt: new Date().toISOString() });

/** Follows the pointer until it is let go (window-level, so it works across elements and on touch). */
function track(onMove: (e: PointerEvent) => void, onUp: (e: PointerEvent) => void) {
  const up = (e: PointerEvent) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    onUp(e);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/**
 * The office: agent teams as an org chart on an office floor. Drag roles in,
 * drag desks around, drag the dot under a desk onto another to put it in charge;
 * every desk has its own agent (Claude or Codex), model, effort and assignment.
 * A goal can be broken down into a team by the small model; a run goes bottom-up
 * (people first, their supervisors once the reports are in) within a budget.
 */
export function OfficePage({ snapshot }: { snapshot: Snapshot }) {
  const { t, lang } = useT();
  const [view, setView] = useState<OfficeView | null>(null);
  const [teamId, setTeamId] = useState(() => localStorage.getItem(TEAM_KEY) ?? '');
  const [draft, setDraft] = useState<OfficeTeam | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [edge, setEdge] = useState<string | null>(null);
  const [opts, setOpts] = useState<LaunchOptions | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'plan' | 'run' | 'stop'>('');
  const [zoom, setZoom] = useState(1);
  const [now, setNow] = useState(Date.now());
  const [link, setLink] = useState<{ from: string; x: number; y: number } | null>(null);
  const [ghost, setGhost] = useState<{ role: OfficeRole; x: number; y: number } | null>(null);
  const planeRef = useRef<HTMLDivElement>(null);
  const floorRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    api.office().then(setView).catch((e) => setError((e as Error).message));
    cachedLaunchOptions().then(setOpts).catch(() => {});
  }, []);

  const teams = view?.teams ?? [];
  const team: OfficeTeam | null = teams.find((x) => x.id === teamId) ?? (draft?.id === teamId ? draft : undefined) ?? teams[0] ?? draft;
  const teamRef = useRef(team);
  teamRef.current = team;
  useEffect(() => {
    if (view && !teams.length && !draft) setDraft(blankTeam(t));
  }, [view, teams.length, draft, t]);
  useEffect(() => {
    if (team) localStorage.setItem(TEAM_KEY, team.id);
  }, [team?.id]);

  // the live runs (from the snapshot stream) over the stored ones
  const runs = useMemo(() => {
    const byId = new Map((view?.runs ?? []).map((r) => [r.id, r]));
    for (const r of snapshot.office ?? []) {
      const old = byId.get(r.id);
      // live reports are clipped: keep the full ones we have
      byId.set(r.id, old ? { ...r, progress: Object.fromEntries(Object.entries(r.progress).map(([k, v]) => [k, { ...v, report: (old.progress[k]?.report?.length ?? 0) > (v.report?.length ?? 0) ? old.progress[k].report : v.report }])) } : r);
    }
    return [...byId.values()];
  }, [view?.runs, snapshot.office]);
  const run = team ? runs.filter((r) => r.teamId === team.id).pop() : undefined;
  const active = run?.state === 'running';
  const showRun = !!run && (active || (!!run.endedAt && now - Date.parse(run.endedAt) < RECENT_MS));
  const progress: Record<string, OfficeRunNode> = showRun ? run!.progress : {};

  // a desk finished: fetch the full reports
  const sig = (snapshot.office ?? []).map((r) => `${r.id}:${r.state}:${Object.values(r.progress).map((p) => p.state[0]).join('')}`).join('|');
  useEffect(() => {
    if (sig) api.office().then(setView).catch(() => {});
  }, [sig]);
  // the demo has no snapshot stream for the office: ask now and then
  useEffect(() => {
    if (!isDemo() || !active) return;
    const id = window.setInterval(() => api.office().then(setView).catch(() => {}), 1200);
    return () => clearInterval(id);
  }, [active]);
  // couriers and timers run on the clock
  useEffect(() => {
    if (!showRun) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [showRun]);

  /** Changes the team on screen; saved shortly after (or right away). */
  const update = (fn: (t: OfficeTeam) => OfficeTeam, save: 'soon' | 'later' | 'now' = 'soon') => {
    const cur = teamRef.current;
    if (!cur) return;
    const changed = fn(cur);
    // a desk keeps only the permissions its supervisor holds
    const next = { ...changed, nodes: cascadeGrants(changed.nodes), updatedAt: new Date().toISOString() };
    teamRef.current = next;
    setView((v) => {
      const list = v?.teams ?? [];
      return { runs: v?.runs ?? [], teams: list.some((x) => x.id === next.id) ? list.map((x) => (x.id === next.id ? next : x)) : [...list, next] };
    });
    if (draft?.id === next.id) setDraft(null);
    setTeamId(next.id);
    if (save === 'later') return;
    window.clearTimeout(saveTimer.current);
    const go = () => api.officeSave(teamRef.current!).catch((e) => setError((e as Error).message));
    if (save === 'now') void go();
    else saveTimer.current = window.setTimeout(go, 600);
  };
  const flush = () => update((x) => x, 'now');

  // a team opens zoomed to fit the floor's width (phones)
  const fitted = useRef('');
  useEffect(() => {
    const el = floorRef.current;
    if (!team || !el || !team.nodes.length || fitted.current === team.id) return;
    fitted.current = team.id;
    const right = Math.max(...team.nodes.map((n) => n.x + DESK_W)) + 24;
    setZoom(Math.max(0.5, Math.min(1, Math.floor((el.clientWidth / right) * 20) / 20)));
  });

  const nodes = team?.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const est = useMemo(() => estimateTeam(nodes), [nodes]);
  const sel = selected ? byId.get(selected) : undefined;
  const locked = active;
  /** permission prompts a working desk is stuck on */
  const asksOf = (p?: OfficeRunNode) => (p?.state === 'running' && p.jobId ? (snapshot.permissions ?? []).filter((x) => x.jobId === p.jobId) : []);
  const kindOf = (a: LaunchAgent): MascotKind => (a === 'claude' ? snapshot.petConfig.claudePet : snapshot.petConfig.codexPet);

  const toPlane = (e: { clientX: number; clientY: number }) => {
    const r = planeRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
  };
  const overPlane = (e: { clientX: number; clientY: number }) => {
    const host = planeRef.current?.parentElement?.parentElement;
    const r = host?.getBoundingClientRect();
    return !!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  };

  const addNode = (role: OfficeRole, at?: { x: number; y: number }, parent?: string) => {
    if (locked || !team) return;
    const p = parent ? byId.get(parent) : undefined;
    const spot =
      at ??
      (p
        ? { x: p.x + childrenOf(nodes, p.id).length * (DESK_W + 24), y: p.y + DESK_H + 70 }
        : { x: 24 + nodes.filter((n) => !n.parent).length * (DESK_W + 28), y: 24 });
    const n: OfficeNode = { id: newOfficeId('n'), name: t[ROLE_KEY[role]], role, agent: 'claude', ...ROLE_DEFAULTS[role], grants: ROLE_GRANTS[role], task: '', ...(parent ? { parent } : {}), x: Math.max(8, Math.round(spot.x)), y: Math.max(8, Math.round(spot.y)) };
    update((x) => ({ ...x, nodes: [...x.nodes, n] }));
    setSelected(n.id);
  };
  const removeNode = (id: string) => {
    if (locked) return;
    // its people move up to its own supervisor
    update((x) => {
      const gone = x.nodes.find((n) => n.id === id);
      return { ...x, nodes: x.nodes.filter((n) => n.id !== id).map((n) => (n.parent === id ? { ...n, parent: gone?.parent } : n)) };
    });
    setSelected(null);
  };
  const patchNode = (id: string, patch: Partial<OfficeNode>, save: 'soon' | 'later' = 'soon') => update((x) => ({ ...x, nodes: x.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }), save);
  const setParent = (child: string, parent: string | undefined) => {
    if (locked || child === parent || (parent && wouldCycle(nodes, child, parent))) return;
    patchNode(child, { parent });
  };

  // Delete removes the selected desk (when not typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (!selected || locked || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') removeNode(selected);
      if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onDeskDown = (e: React.PointerEvent, n: OfficeNode) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.desk-port')) return;
    e.preventDefault();
    const start = toPlane(e);
    const orig = { x: n.x, y: n.y };
    let moved = false;
    track(
      (ev) => {
        const p = toPlane(ev);
        if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 4) return;
        moved = true;
        patchNode(n.id, { x: Math.max(0, Math.round(orig.x + p.x - start.x)), y: Math.max(0, Math.round(orig.y + p.y - start.y)) }, 'later');
      },
      () => {
        if (moved) flush();
        else {
          setSelected(n.id);
          setEdge(null);
        }
      },
    );
  };
  const onPortDown = (e: React.PointerEvent, from: string) => {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    setLink({ from, ...toPlane(e) });
    track(
      (ev) => setLink({ from, ...toPlane(ev) }),
      (ev) => {
        setLink(null);
        const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-desk]')?.dataset.desk;
        if (target && target !== from) setParent(target, from);
        else if (!target && overPlane(ev)) {
          const p = toPlane(ev);
          addNode('engineer', { x: p.x - DESK_W / 2, y: p.y - 20 }, from);
        }
      },
    );
  };
  const onPaletteDown = (e: React.PointerEvent, role: OfficeRole) => {
    if (locked || e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    let dragging = false;
    track(
      (ev) => {
        if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        dragging = true;
        setGhost({ role, x: ev.clientX, y: ev.clientY });
      },
      (ev) => {
        setGhost(null);
        if (!dragging) return addNode(role, undefined, selected ?? undefined);
        if (!overPlane(ev)) return;
        const p = toPlane(ev);
        const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-desk]')?.dataset.desk;
        // dropped on a desk: a new member of that desk's team
        if (under) addNode(role, undefined, under);
        else addNode(role, { x: p.x - DESK_W / 2, y: p.y - DESK_H / 2 });
      },
    );
  };

  const plan = async () => {
    if (!team?.goal.trim()) return;
    if (nodes.length && !confirm(t.officePlanReplace)) return;
    setBusy('plan');
    setError('');
    try {
      const next = await api.officePlan({ id: team.id, goal: team.goal, budget: team.budget, lang, cwd: team.cwd });
      teamRef.current = next;
      setView((v) => ({ runs: v?.runs ?? [], teams: [...(v?.teams ?? []).filter((x) => x.id !== next.id), next] }));
      setDraft(null);
      setTeamId(next.id);
      setSelected(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const start = async () => {
    if (!team) return;
    setBusy('run');
    setError('');
    try {
      window.clearTimeout(saveTimer.current);
      await api.officeSave(team);
      const r = await api.officeRun(team.id);
      setView((v) => (v ? { ...v, runs: [...v.runs.filter((x) => x.id !== r.id), r] } : v));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const stop = async () => {
    if (!run) return;
    setBusy('stop');
    try {
      const r = await api.officeStop(run.id);
      setView((v) => (v ? { ...v, runs: v.runs.map((x) => (x.id === r.id ? r : x)) } : v));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const removeTeam = async () => {
    if (!team || !confirm(fmt(t.officeDeleteAsk, { name: team.name }))) return;
    try {
      if (teams.some((x) => x.id === team.id)) await api.officeDelete(team.id);
      const rest = teams.filter((x) => x.id !== team.id);
      setView((v) => (v ? { ...v, teams: rest } : v));
      setTeamId(rest[0]?.id ?? '');
      setDraft(rest.length ? null : blankTeam(t));
      setSelected(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const newTeam = () => {
    const b = blankTeam(t, team?.budget ?? 5);
    setDraft(b);
    teamRef.current = b;
    setTeamId(b.id);
    // shown at once; stored with its first change
    setSelected(null);
  };

  if (!view || !team)
    return (
      <div className="loading">
        <div className="spinner" aria-hidden />
        {error || t.loading}
      </div>
    );

  // the floor grows with the team
  const W = Math.max(860, ...nodes.map((n) => n.x + DESK_W + 120));
  const H = Math.max(500, ...nodes.map((n) => n.y + DESK_H + 120));
  const edgePath = (p: OfficeNode, c: OfficeNode) => {
    const x1 = p.x + DESK_W / 2;
    const y1 = p.y + DESK_H - 4;
    const x2 = c.x + DESK_W / 2;
    const y2 = c.y + 4;
    const my = (y1 + y2) / 2;
    return `M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
  };
  const edges = nodes.filter((n) => n.parent && byId.has(n.parent)).map((c) => ({ c, p: byId.get(c.parent!)!, d: edgePath(byId.get(c.parent!)!, c) }));
  const overBudget = est.cost > team.budget;
  const spent = showRun ? run!.spent : 0;
  const scale = Math.max(team.budget, est.cost, spent) * 1.08 || 1;
  const why = !nodes.length ? t.officeNeedNodes : !team.cwd ? t.officeNeedFolder : !(opts?.agents.claude.available ?? true) && nodes.some((n) => n.agent === 'claude') ? `Claude Code ${t.cliMissing}` : !(opts?.agents.codex.available ?? true) && nodes.some((n) => n.agent === 'codex') ? `Codex ${t.cliMissing}` : '';
  const teamList = teams.some((x) => x.id === team.id) ? teams : [...teams, team];

  return (
    <div className="office">
      <section className="card office-head">
        <div className="office-title">
          <div>
            <h2>{t.officeTitle}</h2>
            <p className="muted small">{t.officeTagline}</p>
          </div>
          <div className="office-teams" role="tablist" aria-label={t.officeTeams}>
            {teamList.map((x) => (
              <button
                key={x.id}
                role="tab"
                aria-selected={x.id === team.id}
                className={`chip ${x.id === team.id ? 'on' : ''}`}
                onClick={() => {
                  setTeamId(x.id);
                  setSelected(null);
                }}
              >
                {runs.some((r) => r.teamId === x.id && r.state === 'running') && <span className="office-live" aria-hidden />}
                {x.name}
              </button>
            ))}
            <button className="chip office-add-team" onClick={newTeam}>
              + {t.officeNewTeam}
            </button>
          </div>
        </div>

        <div className="office-setup">
          <div className="office-goal">
            <label className="nt-label" htmlFor="office-goal">
              {t.officeGoal}
            </label>
            <textarea
              id="office-goal"
              rows={3}
              value={team.goal}
              disabled={locked}
              placeholder={t.officeGoalPh}
              onChange={(e) => update((x) => ({ ...x, goal: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void plan();
              }}
            />
            <div className="office-goal-foot">
              <button className="btn" onClick={() => void plan()} disabled={locked || !!busy || !team.goal.trim()} title="Ctrl+Enter">
                {busy === 'plan' ? (
                  <>
                    <span className="spin-inline" aria-hidden>
                      ⟳
                    </span>{' '}
                    {t.officePlanning}
                  </>
                ) : (
                  <>✨ {t.officePlan}</>
                )}
              </button>
              <span className="muted tiny">{t.officePlanHelp}</span>
            </div>
          </div>
          <div className="office-fields">
            <label>
              <span className="nt-label">{t.officeTeamName}</span>
              <input value={team.name} disabled={locked} onChange={(e) => update((x) => ({ ...x, name: e.target.value }))} />
            </label>
            <label>
              <span className="nt-label">{t.officeFolder}</span>
              <input list="office-folders" value={team.cwd ?? ''} disabled={locked} placeholder={t.officeFolderPh} spellCheck={false} onChange={(e) => update((x) => ({ ...x, cwd: e.target.value.trim() || undefined }))} />
              <datalist id="office-folders">
                {opts?.projects.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.name}
                  </option>
                ))}
              </datalist>
            </label>
            <label>
              <span className="nt-label">{t.officePerms}</span>
              <select
                value=""
                disabled={locked || !nodes.length}
                title={t.officePermsHelp}
                onChange={(e) => {
                  const pre = PRESETS[Number(e.target.value)];
                  if (!pre) return;
                  update((x) => ({ ...x, nodes: x.nodes.map((n) => ({ ...n, grants: !n.parent || !byId.has(n.parent) ? pre.grants : ROLE_GRANTS[n.role].filter((g) => pre.grants.includes(g)) })) }));
                }}
              >
                <option value="">{t.officePreset}</option>
                {PRESETS.map((p, i) => (
                  <option key={p.key} value={i}>
                    {t[p.key]}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn ghost danger office-del" onClick={() => void removeTeam()} disabled={locked}>
              {t.officeDeleteTeam}
            </button>
          </div>
        </div>
      </section>

      <section className="card office-budget" aria-labelledby="h-budget">
        <div className="office-budget-top">
          <div>
            <h3 id="h-budget">{t.officeBudget}</h3>
            <div className="office-budget-set">
              <input type="range" min={0} max={100} value={toSlider(team.budget)} disabled={locked} onChange={(e) => update((x) => ({ ...x, budget: fromSlider(Number(e.target.value)) }))} aria-label={t.officeBudget} />
              <span className="office-usd">
                $
                <input type="number" min={0.1} step={0.1} value={team.budget} disabled={locked} onChange={(e) => Number(e.target.value) > 0 && update((x) => ({ ...x, budget: Number(e.target.value) }))} aria-label={t.officeBudget} />
              </span>
            </div>
          </div>
          <div className="office-run">
            {showRun && (
              <span className={`office-run-state rs-${run!.state}`}>
                {active && <span className="office-live" aria-hidden />}
                {t[RUN_KEY[run!.state]]}
                <span className="muted"> · {relTime(run!.startedAt, t, lang)}</span>
              </span>
            )}
            {active ? (
              <button className="btn danger" onClick={() => void stop()} disabled={!!busy}>
                ■ {t.officeStop}
              </button>
            ) : (
              <button className="btn primary" onClick={() => void start()} disabled={!!busy || !!why} title={why || undefined}>
                ▶ {busy === 'run' ? t.starting : t.officeRun}
              </button>
            )}
          </div>
        </div>

        <div className="office-meter" role="img" aria-label={`${t.officeEstimate} ${fmtUsd(est.cost)} / ${fmtUsd(team.budget)}`}>
          <div className="office-meter-est">
            {nodes.map((n) => (
              <span key={n.id} className={`seg-${n.agent} ${selected === n.id ? 'on' : ''}`} style={{ width: `${(100 * (est.byNode[n.id]?.cost ?? 0)) / scale}%` }} title={`${n.name} · ≈ ${fmtUsd(est.byNode[n.id]?.cost ?? 0)}`} onClick={() => setSelected(n.id)} />
            ))}
          </div>
          {showRun && <div className="office-meter-spent" style={{ width: `${(100 * spent) / scale}%` }} />}
          <div className="office-meter-cap" style={{ left: `${(100 * team.budget) / scale}%` }} />
        </div>
        <div className="office-meter-legend small">
          <span>
            {t.officeEstimate} <b>≈ {fmtUsd(est.cost)}</b> <span className="muted">· {fmt(t.officeTokens, { n: fmtTokens(est.tokens) })} · {fmt(t.officeDesks, { n: nodes.length })}</span>
          </span>
          {showRun && (
            <span>
              {t.officeSpent} <b>{fmtUsd(spent)}</b>
            </span>
          )}
          <span>
            {t.officeBudgetShort} <b>{fmtUsd(team.budget)}</b>
          </span>
        </div>
        {overBudget && !locked && (
          <div className="office-over small">
            <span>{fmt(t.officeOver, { n: fmtUsd(est.cost - team.budget) })}</span>
            <button
              className="btn"
              onClick={() => {
                const r = fitToBudget(nodes, team.budget);
                update((x) => ({ ...x, nodes: r.nodes }));
                setError(r.fits ? '' : t.officeFitNo);
              }}
            >
              {t.officeFit}
            </button>
          </div>
        )}
        <p className="muted tiny">{t.officeEstNote}</p>
        {error && <p className="action-msg small">{error}</p>}
      </section>

      <div className="office-work">
        <section className="card office-floor-card">
          <div className="office-tools">
            <div className="office-palette" aria-label={t.officePalette}>
              {OFFICE_ROLES.map((r) => (
                <button key={r} className="office-role" disabled={locked} onPointerDown={(e) => onPaletteDown(e, r)} title={t.officePaletteHelp}>
                  <span aria-hidden>{ROLE_ICON[r]}</span> {t[ROLE_KEY[r]]}
                </button>
              ))}
            </div>
            <div className="office-zoom">
              <button className="btn ghost" onClick={() => update((x) => ({ ...x, nodes: autoLayout(x.nodes) }))} disabled={!nodes.length}>
                {t.officeArrange}
              </button>
              <button className="btn ghost" onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))} aria-label={t.officeZoomOut}>
                −
              </button>
              <span className="muted small">{Math.round(zoom * 100)}%</span>
              <button className="btn ghost" onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(2)))} aria-label={t.officeZoomIn}>
                +
              </button>
            </div>
          </div>
          <p className="muted tiny office-hint">{locked ? t.officeLocked : t.officeHint}</p>

          <div
            className="office-floor"
            ref={floorRef}
            onPointerDown={(e) => {
              if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('office-plane')) {
                setSelected(null);
                setEdge(null);
              }
            }}
          >
            <div style={{ width: W * zoom, height: H * zoom }}>
              <div className="office-plane" ref={planeRef} style={{ width: W, height: H, transform: `scale(${zoom})` }}>
                <svg className="office-edges" width={W} height={H} aria-hidden>
                  {edges.map(({ c, d }) => {
                    const st = progress[c.id]?.state;
                    return (
                      <g key={c.id} className={`edge ${st ? `st-${st}` : ''} ${edge === c.id ? 'on' : ''}`}>
                        <path className="edge-line" d={d} />
                        {!locked && <path className="edge-hit" d={d} onClick={() => setEdge(edge === c.id ? null : c.id)} />}
                      </g>
                    );
                  })}
                  {link &&
                    (() => {
                      const f = byId.get(link.from);
                      if (!f) return null;
                      const x1 = f.x + DESK_W / 2;
                      const y1 = f.y + DESK_H;
                      return <path className="edge-draft" d={`M${x1} ${y1} C${x1} ${(y1 + link.y) / 2} ${link.x} ${(y1 + link.y) / 2} ${link.x} ${link.y}`} />;
                    })()}
                </svg>

                {/* permission requests: a slip goes up to the supervisor deciding, a key (or a stop sign) comes back down */}
                {edges.map(({ c, d }) => {
                  // the requests that pass along this line: from this desk or anyone below it, to someone above it
                  const above = new Set(chainOf(nodes, c.id).map((x) => x.id));
                  const passing = nodes
                    .filter((n) => n.id === c.id || chainOf(nodes, n.id).some((x) => x.id === c.id))
                    .flatMap((n) => progress[n.id]?.asks ?? [])
                    .filter((a) => a.to && above.has(a.to));
                  const open = passing.find((a) => a.state === 'reviewing');
                  const back = passing.filter((a) => a.decidedAt && (a.state === 'allowed' || a.state === 'denied') && now - Date.parse(a.decidedAt) < 4000).pop();
                  if (!open && !back) return null;
                  return open ? (
                    <div key={`${c.id}-ask-${open.id}`} className="courier ask" style={{ offsetPath: `path('${d}')` }} aria-hidden>
                      <span className="memo">📝</span>
                    </div>
                  ) : (
                    <div key={`${c.id}-back-${back!.id}`} className="courier down" style={{ offsetPath: `path('${d}')` }} aria-hidden>
                      <span className="memo">{back!.state === 'allowed' ? '🔑' : '⛔'}</span>
                    </div>
                  );
                })}

                {/* couriers: the assignment goes down when a desk starts, its report is carried up when it is done */}
                {edges.map(({ c, d }) => {
                  const pr = progress[c.id];
                  if (!pr) return null;
                  const up = pr.state === 'done' && pr.endedAt && now - Date.parse(pr.endedAt) < 7000;
                  const down = pr.state === 'running' && pr.startedAt && now - Date.parse(pr.startedAt) < 4000;
                  if (!up && !down) return null;
                  return (
                    <div key={`${c.id}-${up ? 'up' : 'down'}`} className={`courier ${up ? 'up' : 'down'}`} style={{ offsetPath: `path('${d}')` }} aria-hidden>
                      {up ? (
                        <>
                          <span className="crate" />
                          <Mascot kind={kindOf(c.agent)} mood="working" size={18} />
                        </>
                      ) : (
                        <span className="memo">✉</span>
                      )}
                    </div>
                  );
                })}

                {edges
                  .filter(({ c }) => edge === c.id && !locked)
                  .map(({ c, p }) => (
                    <button
                      key={c.id}
                      className="edge-cut"
                      style={{ left: (p.x + c.x) / 2 + DESK_W / 2 - 11, top: (p.y + DESK_H + c.y) / 2 - 11 }}
                      onClick={() => {
                        setParent(c.id, undefined);
                        setEdge(null);
                      }}
                      title={t.officeUnlink}
                      aria-label={t.officeUnlink}
                    >
                      ×
                    </button>
                  ))}

                {nodes.map((n) => (
                  <Desk
                    key={n.id}
                    node={n}
                    kind={kindOf(n.agent)}
                    est={est.byNode[n.id]}
                    prog={progress[n.id]}
                    asks={asksOf(progress[n.id])}
                    asking={(() => {
                      const a = progress[n.id]?.asks?.filter((x) => x.state === 'reviewing').pop();
                      return a ? fmt(t.officeAsking, { name: byId.get(a.to ?? '')?.name ?? t.officeYou, grant: t[GRANT_KEY[a.grant]] }) : undefined;
                    })()}
                    reviewing={(() => {
                      const from = nodes.find((m) => progress[m.id]?.asks?.some((x) => x.state === 'reviewing' && x.to === n.id));
                      return from ? fmt(t.officeReviewing, { name: from.name }) : undefined;
                    })()}
                    now={now}
                    waitingOn={childrenOf(nodes, n.id).filter((k) => ['waiting', 'running'].includes(progress[k.id]?.state ?? '')).length}
                    delivered={childrenOf(nodes, n.id).filter((k) => progress[k.id]?.state === 'done').length}
                    selected={selected === n.id}
                    linking={!!link && link.from !== n.id}
                    locked={locked}
                    onPointerDown={(e) => onDeskDown(e, n)}
                    onPortDown={(e) => onPortDown(e, n.id)}
                  />
                ))}

                {!nodes.length && (
                  <div className="office-empty">
                    <Mascot kind={kindOf('claude')} mood="sleeping" size={56} />
                    <p className="muted small">{t.officeEmpty}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        <aside className="card office-inspector" aria-label={t.officeInspector}>
          {sel ? (
            <NodeEditor
              node={sel}
              nodes={nodes}
              opts={opts}
              est={est.byNode[sel.id]}
              prog={progress[sel.id]}
              asks={asksOf(progress[sel.id])}
              locked={locked}
              onChange={(patch) => patchNode(sel.id, patch)}
              onParent={(p) => setParent(sel.id, p)}
              onAddSub={() => addNode('engineer', undefined, sel.id)}
              onRemove={() => removeNode(sel.id)}
              onClose={() => setSelected(null)}
            />
          ) : (
            <TeamRoster nodes={nodes} est={est.byNode} progress={progress} onPick={setSelected} kindOf={kindOf} />
          )}
        </aside>
      </div>

      {ghost && (
        <div className="office-ghost" style={{ left: ghost.x, top: ghost.y }} aria-hidden>
          <span>{ROLE_ICON[ghost.role]}</span> {t[ROLE_KEY[ghost.role]]}
        </div>
      )}
    </div>
  );
}

/** One desk on the floor: the agent behind its desk, doing what its run is doing. */
function Desk({
  node,
  kind,
  est,
  prog,
  asks,
  asking,
  reviewing,
  now,
  waitingOn,
  delivered,
  selected,
  linking,
  locked,
  onPointerDown,
  onPortDown,
}: {
  node: OfficeNode;
  kind: MascotKind;
  est?: { tokens: number; cost: number };
  prog?: OfficeRunNode;
  asks: PendingPermission[];
  asking?: string;
  reviewing?: string;
  now: number;
  waitingOn: number;
  delivered: number;
  selected: boolean;
  linking: boolean;
  locked: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onPortDown: (e: React.PointerEvent) => void;
}) {
  const { t } = useT();
  const st = prog?.state;
  const mood = asks.length ? 'waiting' : st === 'running' ? 'working' : st === 'done' ? 'happy' : st === 'failed' ? 'alert' : st === 'skipped' ? 'sleeping' : 'idle';
  const quiet = st === 'running' && !asks.length ? Math.floor((now - Date.parse(prog?.movedAt ?? prog?.startedAt ?? new Date(now).toISOString())) / 60_000) : 0;
  const scene = st === 'running' && kind === 'crab' && prog?.verb ? SCENE_OF[prog.verb] : undefined;
  return (
    <div
      className={`desk ag-${node.agent} ${st ? `st-${st}` : ''} ${asks.length ? 'asks' : ''} ${selected ? 'on' : ''} ${linking ? 'drop' : ''}`}
      style={{ left: node.x, top: node.y, width: DESK_W, height: DESK_H }}
      data-desk={node.id}
      onPointerDown={onPointerDown}
      role="button"
      tabIndex={0}
      aria-label={`${node.name} · ${t[ROLE_KEY[node.role]]}${st ? ` · ${t[STATE_KEY[st]]}` : ''}`}
    >
      <div className="desk-scene">
        {asks.length > 0 ? (
          <div className="desk-bubble ask" title={`${asks[0].tool}: ${asks[0].summary}`}>
            🔐 {t.officeNeedsYou}
          </div>
        ) : asking ? (
          <div className="desk-bubble ask">📝 {asking}</div>
        ) : reviewing ? (
          <div className="desk-bubble review">🧐 {reviewing}</div>
        ) : quiet >= QUIET_MIN ? (
          <div className="desk-bubble ask" title={prog?.doing}>
            ⚠ {fmt(t.officeQuiet, { n: quiet })}
          </div>
        ) : st === 'running' && (
          <div className="desk-bubble" title={prog?.doing}>
            <span aria-hidden>{(prog?.verb && VERB_ICON[prog.verb]) ?? '⌨'}</span> {prog?.doing || t.deskRunning}
          </div>
        )}
        {st === 'waiting' && waitingOn > 0 && !reviewing && <div className="desk-bubble wait">⏳ {fmt(t.officeWaitingFor, { n: waitingOn })}</div>}
        <div className="desk-agent">
          <Mascot kind={kind} mood={mood} size={40} scene={scene} />
        </div>
        <div className="desk-table">
          <div className="desk-monitor">
            <span />
            <span />
            <span />
            <span />
          </div>
          <div className="desk-keys" />
          {delivered > 0 && (
            <div className="desk-crates" title={fmt(t.officeDelivered, { n: delivered })}>
              {Array.from({ length: Math.min(delivered, 4) }, (_, i) => (
                <i key={i} className="crate" />
              ))}
            </div>
          )}
        </div>
        {st === 'running' && !asks.length && (
          <div className="desk-typing" aria-hidden>
            <span>{'{'}</span>
            <span>;</span>
            <span>{'}'}</span>
            <span>=</span>
          </div>
        )}
        {st === 'done' && (
          <div className="desk-confetti" aria-hidden>
            {Array.from({ length: 6 }, (_, i) => (
              <i key={i} />
            ))}
          </div>
        )}
      </div>
      <div className="desk-name">
        <span aria-hidden>{ROLE_ICON[node.role]}</span> {node.name}
      </div>
      <div className="desk-grants" aria-label={t.officePerms}>
        {OFFICE_GRANTS.filter((g) => (prog?.grants ?? node.grants).includes(g)).map((g) => (
          <span key={g} className={node.grants.includes(g) ? '' : 'new'} title={`${t[GRANT_KEY[g]]}${node.grants.includes(g) ? '' : ` · ${t.officeHandedDown}`}`}>
            {GRANT_ICON[g]}
          </span>
        ))}
      </div>
      <div className="desk-meta">
        {node.agent === 'claude' ? <ClaudeMark size={10} /> : <CodexMark size={10} />} {node.model || t.byDefault} · {node.effort || t.byDefault}
      </div>
      <div className="desk-cost">
        {prog?.tokens ? (
          <>
            {fmtUsd(prog.cost ?? 0)} · {fmtTokens(prog.tokens)}
          </>
        ) : (
          <>≈ {fmtUsd(est?.cost ?? 0)}</>
        )}
        {st && <span className={`desk-badge b-${st}`}>{t[STATE_KEY[st]]}</span>}
      </div>
      {!locked && <span className="desk-port" onPointerDown={onPortDown} title={t.officePortHelp} />}
    </div>
  );
}

/** The selected desk: who sits there, what it runs on, whom it reports to and what it does. */
function NodeEditor({
  node,
  nodes,
  opts,
  est,
  prog,
  asks,
  locked,
  onChange,
  onParent,
  onAddSub,
  onRemove,
  onClose,
}: {
  node: OfficeNode;
  nodes: OfficeNode[];
  opts: LaunchOptions | null;
  est?: { tokens: number; cost: number };
  prog?: OfficeRunNode;
  asks: PendingPermission[];
  locked: boolean;
  onChange: (p: Partial<OfficeNode>) => void;
  onParent: (p: string | undefined) => void;
  onAddSub: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const info = opts?.agents[node.agent];
  const models = [...new Set([...(node.model ? [node.model] : []), ...(info?.models ?? (node.agent === 'claude' ? ['fable', 'opus', 'sonnet', 'haiku'] : []))])];
  const efforts = info?.efforts ?? (node.agent === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['minimal', 'low', 'medium', 'high', 'xhigh']);
  const bosses = nodes.filter((n) => n.id !== node.id && !wouldCycle(nodes, node.id, n.id));
  return (
    <div className="office-editor">
      <div className="nt-head">
        <b>
          {ROLE_ICON[node.role]} {node.name}
        </b>
        <button type="button" className="link" onClick={onClose} aria-label="close">
          ×
        </button>
      </div>
      <fieldset disabled={locked}>
        <div className="office-row">
          <label>
            <span className="nt-label">{t.officeName}</span>
            <input value={node.name} onChange={(e) => onChange({ name: e.target.value })} />
          </label>
          <label>
            <span className="nt-label">{t.officeRole}</span>
            <select value={node.role} onChange={(e) => onChange({ role: e.target.value as OfficeRole })}>
              {OFFICE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_ICON[r]} {t[ROLE_KEY[r]]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <span className="nt-label">{t.agent}</span>
        <div className="nt-agents" role="radiogroup" aria-label={t.agent}>
          {(['claude', 'codex'] as LaunchAgent[]).map((a) => {
            const ok = opts?.agents[a]?.available ?? true;
            return (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={node.agent === a}
                className={`nt-agent ${node.agent === a ? 'on' : ''}`}
                onClick={() => node.agent !== a && onChange({ agent: a, model: a === 'claude' ? ROLE_DEFAULTS[node.role].model : undefined, effort: 'medium' })}
                title={ok ? undefined : t.cliMissing}
              >
                {a === 'claude' ? <ClaudeMark size={13} /> : <CodexMark size={13} />} {a === 'claude' ? 'Claude' : 'Codex'}
                {!ok && <span className="muted tiny"> · {t.cliMissing}</span>}
              </button>
            );
          })}
        </div>
        <div className="office-row">
          <label>
            <span className="nt-label">{t.model}</span>
            <select value={node.model ?? ''} onChange={(e) => onChange({ model: e.target.value || undefined })}>
              <option value="">
                {t.byDefault}
                {info?.defaultModel ? ` (${info.defaultModel})` : ''}
              </option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="nt-label">{t.effort}</span>
            <select value={node.effort ?? ''} onChange={(e) => onChange({ effort: e.target.value || undefined })}>
              <option value="">{t.byDefault}</option>
              {efforts.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          <span className="nt-label">{t.officeReportsTo}</span>
          <select value={node.parent ?? ''} onChange={(e) => onParent(e.target.value || undefined)}>
            <option value="">{t.officeNobody}</option>
            {bosses.map((n) => (
              <option key={n.id} value={n.id}>
                {ROLE_ICON[n.role]} {n.name}
              </option>
            ))}
          </select>
        </label>
        <div>
          <span className="nt-label" title={t.officePermsHelp}>
            {t.officePerms}
          </span>
          <div className="office-grants">
            {OFFICE_GRANTS.map((g) => {
              const boss = nodes.find((n) => n.id === node.parent);
              const blocked = !!boss && !boss.grants.includes(g);
              const on = node.grants.includes(g);
              return (
                <button
                  key={g}
                  type="button"
                  className={`grant-chip ${on ? 'on' : ''} ${blocked ? 'blocked' : ''}`}
                  aria-pressed={on}
                  disabled={blocked}
                  title={blocked ? t.officeGrantNoBoss : t[GRANT_KEY[g]]}
                  onClick={() => onChange({ grants: on ? node.grants.filter((x) => x !== g) : [...node.grants, g] })}
                >
                  {GRANT_ICON[g]} {t[GRANT_KEY[g]]}
                </button>
              );
            })}
          </div>
          <p className="muted tiny">{node.agent === 'codex' ? t.officeCodexPerms : t.officePermsHelp}</p>
        </div>
        {nodes.some((n) => n.parent === node.id) && (
          <label>
            <span className="nt-label">{t.officeReview}</span>
            <select value={node.review ?? 'agent'} onChange={(e) => onChange({ review: e.target.value as OfficeReview })}>
              {(['agent', 'auto', 'user'] as OfficeReview[]).map((r) => (
                <option key={r} value={r}>
                  {t[REVIEW_KEY[r]]}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span className="nt-label">{t.officeTask}</span>
          <textarea rows={5} value={node.task} placeholder={t.officeTaskPh} onChange={(e) => onChange({ task: e.target.value })} />
        </label>
      </fieldset>
      <div className="office-est small">
        {t.officeEstimate} <b>≈ {fmtUsd(est?.cost ?? 0)}</b> <span className="muted">· {fmt(t.officeTokens, { n: fmtTokens(est?.tokens ?? 0) })}</span>
      </div>
      {prog && (
        <div className={`office-prog small b-${prog.state}`}>
          <b>{t[STATE_KEY[prog.state]]}</b>
          {prog.tokens ? (
            <span className="muted">
              {' '}
              · {fmtUsd(prog.cost ?? 0)} · {fmt(t.officeTokens, { n: fmtTokens(prog.tokens) })}
            </span>
          ) : null}
          {prog.error && <div className="action-msg">{prog.error}</div>}
          {asks.map((a) => (
            <PermissionAsk key={a.id} ask={a} />
          ))}
          {!!prog.asks?.length && (
            <>
              <span className="nt-label">{t.officeAsks}</span>
              <ul className="office-asks">
                {[...prog.asks].reverse().map((a) => (
                  <li key={a.id} className={`ask-${a.state}`}>
                    <span>
                      {GRANT_ICON[a.grant]} <b>{t[GRANT_KEY[a.grant]]}</b> → {nodes.find((n) => n.id === a.to)?.name ?? t.officeYou} · <span className="ask-state">{t[ASK_KEY[a.state]]}</span>
                    </span>
                    <span className="mono muted">{a.summary}</span>
                    {a.reason && <span className="muted">“{a.reason}”</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {prog.report && (
            <>
              <span className="nt-label">{t.officeReport}</span>
              <pre className="office-report">{prog.report}</pre>
            </>
          )}
          {prog.taskId && (
            <a className="link" href="#/tasks">
              {t.officeOpenTask} →
            </a>
          )}
        </div>
      )}
      {!locked && (
        <div className="office-editor-foot">
          <button className="btn" onClick={onAddSub}>
            + {t.officeAddSub}
          </button>
          <button className="btn ghost danger" onClick={onRemove}>
            {t.officeRemove}
          </button>
        </div>
      )}
    </div>
  );
}

/** A desk is waiting for your OK to use a tool. */
function PermissionAsk({ ask }: { ask: PendingPermission }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const answer = (allow: boolean) => {
    setBusy(true);
    api.answerPermission(ask.id, allow).catch(() => setBusy(false));
  };
  return (
    <div className="office-ask">
      <span>
        🔐 <b>{ask.tool}</b> <span className="mono">{ask.summary}</span>
      </span>
      <span className="office-ask-btns">
        <button className="btn primary" disabled={busy} onClick={() => answer(true)}>
          {t.allow}
        </button>
        <button className="btn" disabled={busy} onClick={() => answer(false)}>
          {t.deny}
        </button>
      </span>
    </div>
  );
}

/** Nothing selected: the team at a glance, top-down. */
function TeamRoster({ nodes, est, progress, onPick, kindOf }: { nodes: OfficeNode[]; est: Record<string, { cost: number }>; progress: Record<string, OfficeRunNode>; onPick: (id: string) => void; kindOf: (a: LaunchAgent) => MascotKind }) {
  const { t } = useT();
  const rows: { n: OfficeNode; depth: number }[] = [];
  const walk = (n: OfficeNode, depth: number, seen: Set<string>) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    rows.push({ n, depth });
    for (const k of childrenOf(nodes, n.id)) walk(k, depth + 1, seen);
  };
  const seen = new Set<string>();
  for (const r of nodes.filter((n) => !n.parent || !nodes.some((m) => m.id === n.parent))) walk(r, 0, seen);
  return (
    <div className="office-roster">
      <b>{t.officeRoster}</b>
      {!rows.length ? (
        <p className="muted small">{t.officeSelectHint}</p>
      ) : (
        <>
          <p className="muted tiny">{t.officeSelectHint}</p>
          <ul>
            {rows.map(({ n, depth }) => (
              <li key={n.id} style={{ paddingLeft: depth * 14 }}>
                <button className="office-roster-row" onClick={() => onPick(n.id)}>
                  <Mascot kind={kindOf(n.agent)} mood={progress[n.id]?.state === 'running' ? 'working' : 'idle'} size={16} />
                  <span className="office-roster-name">{n.name}</span>
                  <span className="muted tiny">
                    {n.model || t.byDefault}
                    {progress[n.id] ? ` · ${t[STATE_KEY[progress[n.id].state]]}` : ''}
                  </span>
                  <span className="muted tiny office-roster-cost">≈ {fmtUsd(est[n.id]?.cost ?? 0)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
