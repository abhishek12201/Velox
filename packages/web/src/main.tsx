import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import type { Card, Itinerary, Nudge } from '@velox/core';
import { appTitle } from './index.js';
import { useAgent } from './useAgent.js';
import './styles.css';

document.title = appTitle;

const suggestedPrompts = [
  'Weekend in Goa under 20k',
  'A comfortable weekend in Goa under 20k',
  'Same as last Goa trip, but my sister is coming',
];

function money(amount: number): string {
  return `₹${new Intl.NumberFormat('en-IN').format(amount)}`;
}

function statusIcon(status: string): string {
  if (status === 'confirmed') return '✓';
  if (status === 'held') return '◷';
  if (status === 'failed' || status === 'rolled_back') return '!';
  if (status === 'released' || status === 'cancelled') return '↩';
  return '○';
}

function legIcon(kind: string): string {
  if (kind === 'air') return '✈';
  if (kind === 'stay') return '⌂';
  if (kind === 'local') return '◇';
  return '•';
}

function holdCountdown(expiresAt: string, now: number): string {
  const remaining = Math.max(0, Date.parse(expiresAt) - now);
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s remaining`;
}

function ItineraryCard({ card, onConfirm, onChange, now, busy, hasReplacement }: {
  card: Itinerary;
  onConfirm: (planId: string) => void;
  onChange: () => void;
  now: number;
  busy: boolean;
  hasReplacement: boolean;
}) {
  const expired = Date.parse(card.expires_at) <= now;
  const notBookable = card.status === 'rolled_back' || card.status === 'failed';
  const progress = card.budget > 0 ? Math.min(100, (card.total / card.budget) * 100) : 100;
  return (
    <article className="itinerary card-surface">
      <div className="card-kicker">Itinerary · {card.status}</div>
      <h3>{card.title}</h3>
      {card.days.map((day) => (
        <section className="day-group" key={day.label}>
          <h4>{day.label}</h4>
          <ul className="legs">
            {day.items.map((item) => (
              <li key={item.hold_id ?? `${item.kind}-${item.title}`}>
                <span className="leg-icon" aria-hidden="true">{legIcon(item.kind)}</span>
                <span className="leg-name">{item.title}</span>
                <span className={`status status-${item.status}`}>
                  <span aria-hidden="true">{statusIcon(item.status)}</span> {item.status}
                </span>
                {typeof item.amount === 'number' && <span className="leg-price">{money(item.amount)}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <div className="budget-row">
        <span>Code-computed total</span><strong>{money(card.total)}</strong>
        <span>Budget {money(card.budget)}</span>
      </div>
      <div className="budget-meter" role="meter" aria-label="Budget used" aria-valuemin={0} aria-valuemax={card.budget} aria-valuenow={card.total}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <p className="hold-expiry">
        <span aria-hidden="true">{statusIcon(expired ? 'expired' : 'held')}</span>
        {expired ? 'Hold expired' : `Held · ${holdCountdown(card.expires_at, now)}`}
      </p>
      <div className="card-actions">
        <button
          className="primary"
          disabled={busy || card.status === 'confirmed' || expired || notBookable}
          onClick={() => onConfirm(card.plan_id)}
        >
          {card.status === 'confirmed'
            ? 'Confirmed'
            : notBookable
              ? hasReplacement ? 'Replaced by a new plan' : 'Not booked'
              : `Confirm all (${money(card.total)})`}
        </button>
        <button className="secondary" onClick={onChange}>Change plan</button>
      </div>
    </article>
  );
}

function CarouselCard({ card, index, onIndex, onChoose }: {
  card: Extract<Card, { kind: 'carousel' }>;
  index: number;
  onIndex: (index: number) => void;
  onChoose: (index: number) => void;
}) {
  const selected = Math.min(index, card.items.length - 1);
  return (
    <article
      className="carousel card-surface"
      tabIndex={0}
      aria-label={`${card.title}. Use arrow keys to move between options.`}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') onIndex((selected + 1) % card.items.length);
        if (event.key === 'ArrowLeft') onIndex((selected - 1 + card.items.length) % card.items.length);
      }}
    >
      <div className="card-kicker">Options · {card.items.length} choices</div>
      <h3>{card.title}</h3>
      <ol>
        {card.items.map((item, itemIndex) => (
          <li key={item.id} className={itemIndex === selected ? 'selected' : ''}>
            <button onClick={() => onChoose(itemIndex)} aria-label={`Choose option ${itemIndex + 1}: ${item.title}`}>
              <span className="option-number">{itemIndex + 1}</span>
              <span><strong>{item.title}</strong>{item.subtitle && <small>{item.subtitle}</small>}</span>
              {typeof item.price === 'number' && <span className="leg-price">{money(item.price)}</span>}
            </button>
          </li>
        ))}
      </ol>
      <div className="carousel-controls">
        <button className="secondary" onClick={() => onIndex((selected - 1 + card.items.length) % card.items.length)}>Previous</button>
        <span>{selected + 1} / {card.items.length}</span>
        <button className="secondary" onClick={() => onIndex((selected + 1) % card.items.length)}>Next</button>
      </div>
    </article>
  );
}

function NudgeCard({ card, onAccept, busy }: { card: Nudge; onAccept: (planId: string) => void; busy: boolean }) {
  return (
    <article className="nudge-card card-surface">
      <div className="card-kicker">Weather update</div>
      <p>{card.text}</p>
      {card.plan_id && <button className="primary" disabled={busy} onClick={() => onAccept(card.plan_id as string)}>{card.action_label}</button>}
    </article>
  );
}

function renderCard(card: Card, handlers: {
  confirm: (id: string) => void;
  accept: (id: string) => void;
  change: () => void;
  now: number;
  busy: boolean;
  carouselIndex: number;
  setCarouselIndex: (index: number) => void;
  choose: (index: number) => void;
  hasReplacement: boolean;
}) {
  if (card.kind === 'itinerary') {
    return <ItineraryCard
      card={card}
      onConfirm={handlers.confirm}
      onChange={handlers.change}
      now={handlers.now}
      busy={handlers.busy}
      hasReplacement={handlers.hasReplacement}
    />;
  }
  if (card.kind === 'nudge') return <NudgeCard card={card} onAccept={handlers.accept} busy={handlers.busy} />;
  return (
    <CarouselCard
      card={card}
      index={handlers.carouselIndex}
      onIndex={handlers.setCarouselIndex}
      onChoose={handlers.choose}
    />
  );
}

function App() {
  const { state, dispatch, sendText, confirmPlan, postJson, newSession, sessionId } = useAgent();
  const [draft, setDraft] = useState('');
  const [tab, setTab] = useState<'trace' | 'memory'>('trace');
  const [breakBooking, setBreakBooking] = useState(false);
  const [now, setNow] = useState(Date.now());
  const feedEnd = useRef<HTMLDivElement>(null);
  const handledStayFailures = useRef(0);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    feedEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [state.feed]);

  useEffect(() => {
    const count = state.feed.filter((item) =>
      item.kind === 'recovery' && /confirmation failed on stay/i.test(item.detail),
    ).length;
    if (count > handledStayFailures.current) setBreakBooking(false);
    handledStayFailures.current = count;
  }, [state.feed]);

  const submit = (text = draft) => {
    if (!text.trim() || state.loading) return;
    setDraft('');
    void sendText(text);
  };

  const travelToTripDay = async () => {
    const value = await postJson('/api/clock', { preset: 'trip_day' });
    if (typeof value?.now === 'string') {
      dispatch({ type: 'event', event: { type: 'clock', now: value.now } });
    }
  };

  const addTwoHours = async () => {
    const value = await postJson('/api/clock', { plus_hours: 2 });
    if (typeof value?.now === 'string') {
      dispatch({ type: 'event', event: { type: 'clock', now: value.now } });
    }
  };

  const toggleChaos = async () => {
    const next = !breakBooking;
    const value = await postJson('/api/chaos', { server: next ? 'stay' : null });
    if (value) setBreakBooking(next);
  };

  const resetDemo = async () => {
    const value = await postJson('/api/reset', { scope: 'all' });
    if (value) {
      setBreakBooking(false);
      newSession();
    }
  };

  const handlers = {
    confirm: (planId: string) => void confirmPlan(planId),
    accept: (planId: string) => void confirmPlan(planId, true),
    change: () => void sendText('Change plan.'),
    now,
    busy: state.loading,
    carouselIndex: state.carouselIndex,
    setCarouselIndex: (index: number) => dispatch({ type: 'carousel', index }),
    choose: (index: number) => void sendText(`I'll take option ${index + 1}.`),
  };

  return (
    <main className="app-shell">
      <section className="device-panel">
        <header className="topbar">
          <div className="brand-mark" aria-hidden="true">V</div>
          <div className="brand-copy"><strong>Velox</strong><span>Hey Velox</span></div>
          <span className="clock-chip"><span className="clock-dot" />{state.clock ? new Date(state.clock).toLocaleString() : 'Clock connecting'}</span>
        </header>

        <details className="demo-tray" open>
          <summary>Demo controls</summary>
          <div className="tray-actions">
            <button className="secondary" onClick={() => void travelToTripDay()}>Jump to trip day</button>
            <button className="secondary" onClick={() => void addTwoHours()}>+2 hours</button>
            <button className={`secondary ${breakBooking ? 'is-active' : ''}`} aria-pressed={breakBooking} onClick={() => void toggleChaos()}>
              {breakBooking ? 'Booking chaos on' : 'Break a booking'}
            </button>
            <button className="secondary" onClick={newSession}>New session</button>
            <button className="quiet-danger" onClick={() => void resetDemo()}>Reset demo</button>
          </div>
        </details>

        {state.error && <div className="error-banner" role="alert">{state.error}</div>}
        <div className="conversation" aria-live="polite" aria-label="Conversation">
          {state.feed.length === 0 && (
            <div className="welcome-card">
              <p className="eyebrow">Your trip, already in motion</p>
              <h1>Where would you like to go?</h1>
              <p>Plan and confirm each leg before anything is booked. All data is synthetic.</p>
            </div>
          )}
          {state.feed.map((item, index) => {
            if (item.kind === 'say') return (
              <p key={item.id} className={`message message-${item.role}`}>{item.text}</p>
            );
            if (item.kind === 'card') {
              const hasReplacement = item.card.kind === 'itinerary' &&
                (item.card.status === 'rolled_back' || item.card.status === 'failed') &&
                state.feed.slice(index + 1).some((next) =>
                  next.kind === 'card' && next.card.kind === 'itinerary' && next.card.status === 'proposed',
                );
              return (
                <div key={`card-${index}`} className="feed-card">
                  {renderCard(item.card, { ...handlers, hasReplacement })}
                </div>
              );
            }
            if (item.kind === 'recovery') return (
              <div key={`recovery-${index}`} className="recovery-note" role="status">
                <strong>Recovery step {item.step}</strong><p>{item.detail}</p>
              </div>
            );
            if (item.kind === 'chip') return <span key={`chip-${index}`} className="memory-chip">◇ {item.text}</span>;
            return <p key={`error-${index}`} className="message message-error" role="alert">{item.message}</p>;
          })}
          {state.loading && <p className="thinking" role="status">Working through your options…</p>}
          <div ref={feedEnd} />
        </div>

        <section className="composer-wrap">
          <div className="suggestions" aria-label="Suggested prompts">
            {suggestedPrompts.map((prompt) => (
              <button key={prompt} onClick={() => submit(prompt)} disabled={state.loading}>{prompt}</button>
            ))}
          </div>
          <form className="composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
            <label className="sr-only" htmlFor="composer-input">Message Velox</label>
            <input
              id="composer-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Tell Velox what you have in mind"
              disabled={state.loading}
            />
            <button className="primary" type="submit" disabled={state.loading || !draft.trim()}>Send</button>
          </form>
          <footer>All data is synthetic. <span>Session {sessionId.slice(0, 8)}</span></footer>
        </section>
      </section>

      <aside className="inspector" aria-label="Agent details">
        <div className="inspector-tabs" role="tablist" aria-label="Agent details">
          <button role="tab" aria-selected={tab === 'trace'} onClick={() => setTab('trace')}>MCP trace</button>
          <button role="tab" aria-selected={tab === 'memory'} onClick={() => setTab('memory')}>Memory</button>
        </div>
        <div className="inspector-content">
          {tab === 'trace' ? (
            state.trace.length === 0
              ? <p className="empty-state">Tool activity will appear here.</p>
              : state.trace.map((group, index) => (
                <section className="trace-group" key={`trace-${index}`}>
                  {group.length > 1 && <p className="parallel-label">Parallel calls · {group.length}</p>}
                  {group.map(({ call, result }) => (
                    <details key={call.id} className="trace-entry">
                      <summary>
                        <span>{call.server} · {call.tool} · {result ? `${result.ms} ms` : 'running'}</span>
                        {result && <strong className={result.ok ? 'trace-ok' : 'trace-failed'}>{result.ok ? 'Done' : 'Failed'}</strong>}
                      </summary>
                      <p>{result?.summary ?? 'Waiting for result'}</p>
                      <pre>{JSON.stringify(call.args, null, 2)}</pre>
                    </details>
                  ))}
                </section>
              ))
          ) : (
            <div className="memory-panel">
              <p className="eyebrow">Remembered in this vault</p>
              {state.memoryChips.length === 0
                ? <p className="empty-state">Preferences from your trip planning will appear here.</p>
                : state.memoryChips.map((chip, index) => <span key={`${chip}-${index}`} className="memory-chip">◇ {chip}</span>)}
              <p className="vault-note">New sessions keep saved preferences and trips.</p>
            </div>
          )}
        </div>
        <div className="stream-state"><span className={`connection-dot connection-${state.connection}`} />Events {state.connection}</div>
      </aside>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
ReactDOM.createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
