import { useEffect, useRef, useState, type ReactNode } from 'react';
import { deliveryOf, layoutTree, rootsOf, stageOf, type Box, type OfficeDelivery, type OfficeNode, type OfficeRole, type OfficeRunNode } from '../../shared/office';
import { fmt, useT, type Dict } from '../i18n';
import { ClaudeMark, CodexMark } from './Brand';

const ROLE_ICON: Record<OfficeRole, string> = { lead: '👑', manager: '📋', engineer: '🛠', researcher: '🔎', reviewer: '🧐', tester: '🧪', writer: '✍' };
const DELIVERY_KEY: Record<OfficeDelivery, keyof Dict> = {
  none: 'dlvNone',
  waiting: 'dlvWaiting',
  making: 'dlvMaking',
  delivered: 'dlvDelivered',
  accepted: 'dlvAccepted',
  rejected: 'dlvRejected',
  failed: 'dlvFailed',
  skipped: 'dlvSkipped',
};
const DELIVERY_ICON: Record<OfficeDelivery, string> = { none: '○', waiting: '○', making: '⏳', delivered: '📦', accepted: '✓', rejected: '✗', failed: '✗', skipped: '–' };
const FLOW_KEY = 'vp.office.flow';

// the handoff diagram: small boxes, room between the levels for what goes up
const HW = 180;
const HH = 62;
const HGX = 40;
const HGY = 108;
const YOU_H = 40;
// the acceptance diagram: one box per delivery, as tall as its list of criteria
const AW = 236;
const AGX = 28;
const AGY = 56;
const acceptH = (n: OfficeNode) => 88 + 21 * Math.max(1, n.criteria?.length ?? 0);

const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const my = (y1 + y2) / 2;
  return `M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
};

/**
 * What goes between the roles: a handoff diagram (who hands which deliverable to whom,
 * in what order) and an acceptance diagram (the criteria each delivery is judged by,
 * ticked off by the desk and accepted or rejected by its supervisor during a run).
 */
export function OfficeFlows({ nodes, progress, selected, onPick }: { nodes: OfficeNode[]; progress: Record<string, OfficeRunNode>; selected: string | null; onPick: (id: string) => void }) {
  const { t } = useT();
  const [mode, setMode] = useState<'handoff' | 'accept'>(() => (localStorage.getItem(FLOW_KEY) === 'accept' ? 'accept' : 'handoff'));
  const pick = (m: typeof mode) => {
    setMode(m);
    localStorage.setItem(FLOW_KEY, m);
  };
  const designed = nodes.some((n) => n.deliverable || n.criteria?.length);
  return (
    <section className="card office-flows" aria-labelledby="h-flows">
      <div className="office-flows-head">
        <h3 id="h-flows">{t.officeFlows}</h3>
        <div className="office-flows-tabs" role="tablist" aria-label={t.officeFlows}>
          <button role="tab" aria-selected={mode === 'handoff'} className={`chip ${mode === 'handoff' ? 'on' : ''}`} onClick={() => pick('handoff')}>
            📦 {t.officeFlowHandoff}
          </button>
          <button role="tab" aria-selected={mode === 'accept'} className={`chip ${mode === 'accept' ? 'on' : ''}`} onClick={() => pick('accept')}>
            ✅ {t.officeFlowAccept}
          </button>
        </div>
      </div>
      <p className="muted tiny">{mode === 'handoff' ? t.officeFlowHandoffHelp : t.officeFlowAcceptHelp}</p>
      {!nodes.length ? null : (
        <>
          {!designed && <p className="office-flows-empty small">{t.officeFlowEmpty}</p>}
          {mode === 'handoff' ? <Handoffs nodes={nodes} progress={progress} selected={selected} onPick={onPick} /> : <Acceptance nodes={nodes} progress={progress} selected={selected} onPick={onPick} />}
          <div className="office-flows-legend tiny">
            {(['waiting', 'making', 'delivered', 'accepted', 'rejected'] as OfficeDelivery[]).map((d) => (
              <span key={d} className={`dlv dlv-${d}`}>
                <i aria-hidden>{DELIVERY_ICON[d]}</i> {t[DELIVERY_KEY[d]]}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** The diagram's scroll box: opens centred on the top of the tree (phones see the lead first). */
function FlowScroll({ children, at }: { children: ReactNode; at: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, [at]);
  return (
    <div className="flow-scroll" ref={ref}>
      {children}
    </div>
  );
}

function Who({ node }: { node: OfficeNode }) {
  const { t } = useT();
  return (
    <span className="flow-who">
      {node.agent === 'claude' ? <ClaudeMark size={10} /> : <CodexMark size={10} />} {node.model || t.byDefault} · {node.effort || t.byDefault}
    </span>
  );
}

/** Who hands what to whom: the bottom delivers first, the lead delivers to you. */
function Handoffs({ nodes, progress, selected, onPick }: { nodes: OfficeNode[]; progress: Record<string, OfficeRunNode>; selected: string | null; onPick: (id: string) => void }) {
  const { t } = useT();
  const top = 24 + YOU_H + HGY;
  const pos = layoutTree(nodes, { w: HW, h: () => HH, gapX: HGX, gapY: HGY, pad: 24 });
  for (const b of pos.values()) b.y += top - 24;
  const roots = rootsOf(nodes);
  const rootX = roots.map((r) => pos.get(r.id)!.x + HW / 2);
  const you: Box = { x: Math.round((Math.min(...rootX) + Math.max(...rootX)) / 2 - HW / 2), y: 24, w: HW, h: YOU_H };
  const boxes = [...pos.values()];
  const W = Math.max(you.x + HW, ...boxes.map((b) => b.x + b.w)) + 24;
  const H = Math.max(...boxes.map((b) => b.y + b.h)) + 24;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const lines = nodes.map((n) => {
    const b = pos.get(n.id)!;
    const to = n.parent && byId.has(n.parent) ? pos.get(n.parent)! : you;
    const boss = n.parent ? byId.get(n.parent) : undefined;
    const x1 = b.x + HW / 2;
    const x2 = to.x + to.w / 2;
    const y2 = to.y + to.h + 2;
    return { n, b, boss, d: curve(x1, b.y - 2, x2, y2), tip: `M${x2 - 5} ${y2 + 8} L${x2} ${y2} L${x2 + 5} ${y2 + 8}`, dlv: deliveryOf(progress[n.id]) };
  });
  return (
    <FlowScroll at={`h${W}`}>
      <div className="flow-plane" style={{ width: W, height: H }}>
        <svg className="flow-edges" width={W} height={H} aria-hidden>
          {lines.map(({ n, d, tip, dlv }) => (
            <g key={n.id} className={`flow-edge dlv-${dlv}`}>
              <path d={d} />
              <path className="flow-tip" d={tip} />
            </g>
          ))}
        </svg>
        <div className="flow-you" style={{ left: you.x, top: you.y, width: you.w, height: you.h }}>
          👤 {t.officeToYou}
        </div>
        {lines.map(({ n, b, boss, dlv }) => {
          const p = progress[n.id];
          const title = [
            `${n.name} → ${boss?.name ?? t.officeToYou}`,
            n.deliverable ? `📦 ${n.deliverable}` : t.officeNoDeliverable,
            ...(n.criteria ?? []).map((c) => `• ${c}`),
            p?.acceptNote ? `“${p.acceptNote}”` : '',
          ]
            .filter(Boolean)
            .join('\n');
          return (
            <div key={n.id} className={`flow-label dlv-${dlv}`} style={{ left: b.x, top: b.y - 74, width: HW }} title={title}>
              <span className="flow-stage" title={fmt(t.officeStage, { n: stageOf(nodes, n.id) })}>
                {stageOf(nodes, n.id)}
              </span>
              <span className={`flow-deliv ${n.deliverable ? '' : 'muted'}`}>{n.deliverable || t.officeNoDeliverable}</span>
              {dlv !== 'none' && (
                <span className="flow-dlv" aria-label={t[DELIVERY_KEY[dlv]]}>
                  {DELIVERY_ICON[dlv]}
                </span>
              )}
            </div>
          );
        })}
        {nodes.map((n) => {
          const b = pos.get(n.id)!;
          const st = progress[n.id]?.state;
          return (
            <button key={n.id} className={`flow-box ag-${n.agent} ${st ? `st-${st}` : ''} ${selected === n.id ? 'on' : ''}`} style={{ left: b.x, top: b.y, width: HW, height: HH }} onClick={() => onPick(n.id)}>
              <span className="flow-name">
                {ROLE_ICON[n.role]} {n.name}
              </span>
              <Who node={n} />
            </button>
          );
        })}
      </div>
    </FlowScroll>
  );
}

/** Every delivery with the criteria it is judged by, and whether it passed. */
function Acceptance({ nodes, progress, selected, onPick }: { nodes: OfficeNode[]; progress: Record<string, OfficeRunNode>; selected: string | null; onPick: (id: string) => void }) {
  const { t } = useT();
  const pos = layoutTree(nodes, { w: AW, h: acceptH, gapX: AGX, gapY: AGY, pad: 16 });
  const boxes = [...pos.values()];
  const W = Math.max(...boxes.map((b) => b.x + b.w)) + 16;
  const H = Math.max(...boxes.map((b) => b.y + b.h)) + 16;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let met = 0;
  let total = 0;
  let accepted = 0;
  let judged = 0;
  for (const n of nodes) {
    const p = progress[n.id];
    total += n.criteria?.length ?? 0;
    met += p?.checks?.filter((c) => c === 'met').length ?? 0;
    if (n.parent && byId.has(n.parent)) {
      judged++;
      if (p?.accepted) accepted++;
    }
  }
  const ran = Object.keys(progress).length > 0;
  return (
    <>
      {ran && <p className="small office-flows-sum">{fmt(t.officeCriteriaSum, { a: met, b: total, c: accepted, d: judged })}</p>}
      <FlowScroll at={`a${W}`}>
        <div className="flow-plane" style={{ width: W, height: H }}>
          <svg className="flow-edges" width={W} height={H} aria-hidden>
            {nodes
              .filter((n) => n.parent && byId.has(n.parent))
              .map((n) => {
                const b = pos.get(n.id)!;
                const to = pos.get(n.parent!)!;
                const x1 = b.x + AW / 2;
                const x2 = to.x + AW / 2;
                const y2 = to.y + to.h + 2;
                return (
                  <g key={n.id} className={`flow-edge dlv-${deliveryOf(progress[n.id])}`}>
                    <path d={curve(x1, b.y - 2, x2, y2)} />
                    <path className="flow-tip" d={`M${x2 - 5} ${y2 + 8} L${x2} ${y2} L${x2 + 5} ${y2 + 8}`} />
                  </g>
                );
              })}
          </svg>
          {nodes.map((n) => {
            const b = pos.get(n.id)!;
            const p = progress[n.id];
            const dlv = deliveryOf(p);
            const boss = n.parent ? byId.get(n.parent) : undefined;
            const crit = n.criteria ?? [];
            const gate = !boss
              ? t.officeYourCall
              : p?.accepted === true
                ? fmt(t.officeAcceptedBy, { name: boss.name })
                : p?.accepted === false
                  ? fmt(t.officeRejectedBy, { name: boss.name })
                  : fmt(t.officeAwaiting, { name: boss.name });
            return (
              <button key={n.id} className={`accept-box ag-${n.agent} dlv-${dlv} ${selected === n.id ? 'on' : ''}`} style={{ left: b.x, top: b.y, width: AW, height: b.h }} onClick={() => onPick(n.id)}>
                <span className="accept-head">
                  <span className="flow-name">
                    {ROLE_ICON[n.role]} {n.name}
                  </span>
                  {dlv !== 'none' && <span className={`accept-state dlv dlv-${dlv}`}>{t[DELIVERY_KEY[dlv]]}</span>}
                </span>
                <span className={`accept-deliv ${n.deliverable ? '' : 'muted'}`} title={n.deliverable}>
                  📦 {n.deliverable || t.officeNoDeliverable}
                </span>
                <span className="accept-crit">
                  {crit.length ? (
                    crit.map((c, i) => {
                      const ck = p?.checks?.[i] ?? (p?.state === 'running' ? 'busy' : p?.state === 'done' ? 'unknown' : 'pending');
                      return (
                        <span key={i} className={`crit crit-${ck}`} title={`${c} · ${t[CHECK_KEY[ck]]}`}>
                          <i aria-label={t[CHECK_KEY[ck]]}>{CHECK_ICON[ck]}</i> {c}
                        </span>
                      );
                    })
                  ) : (
                    <span className="crit muted">{t.officeNoCriteria}</span>
                  )}
                </span>
                <span className={`accept-gate ${p?.accepted === true ? 'yes' : p?.accepted === false ? 'no' : ''}`} title={p?.acceptNote}>
                  🛂 {gate}
                  {p?.acceptNote ? ` · ${p.acceptNote}` : ''}
                </span>
              </button>
            );
          })}
        </div>
      </FlowScroll>
    </>
  );
}

type CheckShown = 'met' | 'unmet' | 'unknown' | 'busy' | 'pending';
const CHECK_ICON: Record<CheckShown, string> = { met: '✓', unmet: '✗', unknown: '?', busy: '⏳', pending: '○' };
const CHECK_KEY: Record<CheckShown, keyof Dict> = { met: 'checkMet', unmet: 'checkUnmet', unknown: 'checkUnknown', busy: 'checkBusy', pending: 'checkPending' };
