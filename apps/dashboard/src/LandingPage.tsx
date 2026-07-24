import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useRef, useState } from 'react';

gsap.registerPlugin(useGSAP, ScrollTrigger);

const bentoItems = [
  {
    key: 'correlate',
    eyebrow: 'Correlation engine',
    title: 'One process instance across every runtime.',
    body: 'A deterministic correlation key joins separate tool executions into a single operational record.',
  },
  {
    key: 'detect',
    eyebrow: 'Sequence evaluator',
    title: 'Find the exact break.',
    body: 'Reported failures, missing stages, SLA violations, and invalid order are evaluated as one sequence.',
  },
  {
    key: 'explain',
    eyebrow: 'Context layer',
    title: 'Signal with business identity.',
    body: 'Every incident resolves to a client, process, instance, source, and failed stage.',
  },
  {
    key: 'respond',
    eyebrow: 'Operator state',
    title: 'Acknowledge. Assign. Resolve.',
    body: 'One controlled response path.',
  },
] as const;

const incidentTypes = [
  {
    title: 'Reported failure',
    body: 'A connected runtime emits a failed event with its source execution and error classification attached.',
    code: 'event.status === "failed"',
  },
  {
    title: 'Missing stage',
    body: 'An expected handoff does not arrive inside the stage window defined by the process contract.',
    code: 'now > expected_at',
  },
  {
    title: 'SLA violation',
    body: 'The end-to-end process exceeds its maximum duration even when every individual execution succeeds.',
    code: 'elapsed_ms > sla_ms',
  },
  {
    title: 'Unexpected sequence',
    body: 'A later stage arrives before a required predecessor has reached a terminal state.',
    code: 'index < completed_index',
  },
] as const;

const architecture = [
  [
    'Ingest',
    'Signed HTTP events arrive from n8n, Make, and custom services through one normalized contract.',
  ],
  [
    'Correlate',
    'Idempotent writes resolve into deterministic client, process, and instance identities.',
  ],
  [
    'Evaluate',
    'Workers compare reported state, expected sequence, and elapsed time against the process definition.',
  ],
  [
    'Operate',
    'A multi-client incident queue preserves ownership, status history, and source execution context.',
  ],
] as const;

const operatorNotes = [
  {
    quote:
      'The unit of observability should be the client process—not the automation tool that happened to run it.',
    label: 'Product principle / 01',
  },
  {
    quote: 'A successful execution is not proof that the business process completed.',
    label: 'Product principle / 02',
  },
  {
    quote:
      'The first useful incident message says what broke, where it broke, and who it affected.',
    label: 'Product principle / 03',
  },
] as const;

function ProcessTrace({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={compact ? 'trace trace--compact' : 'trace'}
      aria-label="Client onboarding process trace"
    >
      <div className="trace__header">
        <div>
          <span className="trace__kicker">process instance</span>
          <strong>client-onboarding</strong>
        </div>
        <span className="status status--incident">incident</span>
      </div>

      <dl className="trace__metadata">
        <div>
          <dt>instance</dt>
          <dd>customer_4821</dd>
        </div>
        <div>
          <dt>correlation</dt>
          <dd>otr_7Q4A92</dd>
        </div>
        {!compact ? (
          <div>
            <dt>elapsed</dt>
            <dd>00:06:42</dd>
          </div>
        ) : null}
      </dl>

      <ol className="trace__stages">
        <li data-state="complete">
          <span className="trace__node" aria-hidden="true" />
          <div>
            <strong>payment_received</strong>
            <span>Make · complete · 09:41:02</span>
          </div>
          <code>200</code>
        </li>
        <li data-state="failed">
          <span className="trace__node" aria-hidden="true" />
          <div>
            <strong>account_created</strong>
            <span>API · failed · 09:41:08</span>
          </div>
          <code>503</code>
        </li>
        <li data-state="waiting">
          <span className="trace__node" aria-hidden="true" />
          <div>
            <strong>workspace_created</strong>
            <span>n8n · waiting</span>
          </div>
          <code>—</code>
        </li>
      </ol>

      {!compact ? (
        <div className="trace__payload">
          <span>latest_event.json</span>
          <pre>
            <code>{`{
  "status": "failed",
  "stage": "account_created",
  "error_class": "upstream_unavailable"
}`}</code>
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function SystemTopology() {
  return (
    <div className="topology scale-media" aria-label="Outtrace system topology">
      <div className="topology__header">
        <span>event topology</span>
        <span>live contract / v1</span>
      </div>
      <div className="topology__canvas">
        <div className="topology__source topology__source--one">n8n</div>
        <div className="topology__source topology__source--two">Make</div>
        <div className="topology__source topology__source--three">API</div>
        <div className="topology__core">
          <span>Outtrace</span>
          <strong>correlate()</strong>
          <small>3 events · 1 instance</small>
        </div>
        <div className="topology__output">
          <span>INC-0248</span>
          <strong>missing_stage</strong>
          <small>severity / high</small>
        </div>
        <span className="topology__line topology__line--one" aria-hidden="true" />
        <span className="topology__line topology__line--two" aria-hidden="true" />
        <span className="topology__line topology__line--three" aria-hidden="true" />
        <span className="topology__line topology__line--out" aria-hidden="true" />
      </div>
      <div className="topology__footer">
        <span>event sources</span>
        <strong>3</strong>
        <span>incident types</span>
        <strong>4</strong>
      </div>
    </div>
  );
}

export function LandingPage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [activeIncident, setActiveIncident] = useState(0);
  const [activeNote, setActiveNote] = useState(0);

  useGSAP(
    () => {
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reducedMotion) {
        gsap.set('[data-enter], .scale-media, .hero__trace', { clearProps: 'all' });
        return;
      }

      gsap.from('[data-hero-enter]', {
        opacity: 0,
        y: 22,
        duration: 0.75,
        stagger: 0.07,
        ease: 'power3.out',
      });

      gsap.fromTo(
        '.hero__trace',
        { opacity: 0, scale: 0.92, y: 18 },
        { opacity: 1, scale: 1, y: 0, duration: 1, ease: 'power3.out' },
      );

      gsap.utils.toArray<HTMLElement>('[data-enter]').forEach((element) => {
        gsap.from(element, {
          opacity: 0,
          y: 18,
          duration: 0.68,
          ease: 'power3.out',
          scrollTrigger: {
            trigger: element,
            start: 'top 87%',
            once: true,
          },
        });
      });

      gsap.utils.toArray<HTMLElement>('.scale-media').forEach((element) => {
        gsap
          .timeline({
            scrollTrigger: {
              trigger: element,
              start: 'top bottom',
              end: 'bottom top',
              scrub: 1,
            },
          })
          .fromTo(element, { scale: 0.88, opacity: 0.35 }, { scale: 1, opacity: 1 })
          .to(element, { scale: 0.97, opacity: 0.35 });
      });

      const media = gsap.matchMedia();
      media.add('(min-width: 1001px)', () => {
        ScrollTrigger.create({
          trigger: '.desire',
          start: 'top top',
          end: 'bottom bottom',
          pin: '.desire__sticky',
          pinSpacing: false,
        });
      });

      return () => media.revert();
    },
    { scope: rootRef },
  );

  const note = operatorNotes[activeNote] ?? operatorNotes[0]!;

  return (
    <div className="landing" ref={rootRef}>
      <a className="landing__skip" href="#main">
        Skip to content
      </a>

      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="Outtrace home">
          <span className="wordmark__mark" aria-hidden="true">
            OT
          </span>
          <span>Outtrace</span>
        </a>
        <nav className="site-nav" aria-label="Portfolio case study">
          <a href="#system">System</a>
          <a href="#incidents">Incidents</a>
          <a href="#architecture">Architecture</a>
        </nav>
        <a
          className="header-link"
          href="https://github.com/ostenmatrixx/outtrace"
          target="_blank"
          rel="noreferrer"
        >
          Source / GitHub
        </a>
      </header>

      <main id="main">
        <section className="hero" id="top">
          <div className="hero__copy">
            <div className="hero__eyebrow" data-hero-enter>
              <span className="signal-dot" aria-hidden="true" />
              Process observability / agencies
            </div>
            <h1 data-hero-enter>Trace the process beyond the workflow.</h1>
            <p className="hero__intro" data-hero-enter>
              Outtrace correlates automation events across runtimes, detects sequence failures, and
              turns technical execution state into one client-level incident record.
            </p>
            <div className="hero__actions" data-hero-enter>
              <a className="button button--primary" href="#system">
                Explore system
              </a>
              <a className="button button--secondary" href="#architecture">
                View architecture
              </a>
            </div>
          </div>

          <div className="hero__trace">
            <div className="hero__trace-bar">
              <span>outtrace://operations</span>
              <span>UTC+08 · live</span>
            </div>
            <ProcessTrace />
          </div>
        </section>

        <dl className="project-band" aria-label="Project details">
          <div>
            <dt>System</dt>
            <dd>Cross-runtime observability</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>Event → process → incident</dd>
          </div>
          <div>
            <dt>Stack</dt>
            <dd>React · API · PostgreSQL · Redis</dd>
          </div>
          <div>
            <dt>Interface</dt>
            <dd>Multi-client operations console</dd>
          </div>
        </dl>

        <section className="interest section-shell" id="system">
          <div className="section-heading" data-enter>
            <span className="section-kicker">Operational model</span>
            <h2>
              Follow the business process
              <span className="inline-trace" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              end to end.
            </h2>
            <p>
              Runtime logs stop at tool boundaries. Outtrace retains the business identity that
              connects every execution, wait state, and handoff.
            </p>
          </div>

          <div className="bento-grid" data-enter>
            {bentoItems.map((item) => (
              <article className={`bento-card bento-card--${item.key}`} key={item.key}>
                {item.key === 'correlate' ? (
                  <div className="bento-card__trace">
                    <ProcessTrace compact />
                  </div>
                ) : null}
                <div className="bento-card__copy">
                  <span className="card-kicker">{item.eyebrow}</span>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="incident-section section-shell" id="incidents">
          <div className="section-heading section-heading--compact" data-enter>
            <span className="section-kicker">Detection surface</span>
            <h2>Four failure modes. One incident contract.</h2>
            <p>Each detector evaluates a different break in the process lifecycle.</p>
          </div>

          <div className="incident-accordion" data-enter>
            {incidentTypes.map((incident, index) => (
              <article
                className="incident-panel"
                data-active={activeIncident === index}
                key={incident.title}
              >
                <button
                  type="button"
                  aria-expanded={activeIncident === index}
                  onClick={() => setActiveIncident(index)}
                  onFocus={() => setActiveIncident(index)}
                  onMouseEnter={() => setActiveIncident(index)}
                >
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <strong>{incident.title}</strong>
                </button>
                <div className="incident-panel__body">
                  <code>{incident.code}</code>
                  <p>{incident.body}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="operator-notes section-shell" aria-label="Product principles">
          <div className="operator-notes__top">
            <span className="section-kicker">Operator requirements</span>
            <div className="operator-notes__controls" aria-label="Select product principle">
              <button
                type="button"
                aria-label="Previous principle"
                onClick={() =>
                  setActiveNote(
                    (current) => (current - 1 + operatorNotes.length) % operatorNotes.length,
                  )
                }
              >
                Prev
              </button>
              <span>
                {String(activeNote + 1).padStart(2, '0')} /{' '}
                {String(operatorNotes.length).padStart(2, '0')}
              </span>
              <button
                type="button"
                aria-label="Next principle"
                onClick={() => setActiveNote((current) => (current + 1) % operatorNotes.length)}
              >
                Next
              </button>
            </div>
          </div>
          <blockquote key={note.label}>
            <p>“{note.quote}”</p>
            <footer>{note.label}</footer>
          </blockquote>
        </section>

        <section className="desire section-shell" id="architecture">
          <div className="desire__sticky">
            <span className="section-kicker">System boundary</span>
            <h2>Small surface. Explicit responsibilities.</h2>
            <p>
              Outtrace observes and explains. It does not execute workflows, retry external actions,
              or retain full business payloads by default.
            </p>
          </div>

          <div className="desire__story">
            <SystemTopology />
            <ol className="architecture-list">
              {architecture.map(([title, body], index) => (
                <li key={title} data-enter>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <h3>{title}</h3>
                    <p>{body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="closing section-shell" data-enter>
          <div>
            <span className="section-kicker">Repository access</span>
            <h2>Inspect the system behind the incident.</h2>
            <p>
              Event contract, API, worker, data model, and operator workspace are in the repository.
            </p>
          </div>
          <a
            className="button button--light"
            href="https://github.com/ostenmatrixx/outtrace"
            target="_blank"
            rel="noreferrer"
          >
            Open repository
          </a>
        </section>
      </main>

      <footer className="site-footer">
        <a className="wordmark" href="#top">
          <span className="wordmark__mark" aria-hidden="true">
            OT
          </span>
          <span>Outtrace</span>
        </a>
        <p>Product design and engineering by Austin Gabriel Diaz.</p>
        <p>Process observability / 2026</p>
      </footer>
    </div>
  );
}
