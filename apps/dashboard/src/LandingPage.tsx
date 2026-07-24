import { useEffect } from 'react';

const systemQuestions = [
  {
    title: 'Did the process finish?',
    body: 'Correlate events from separate tools with one business identifier.',
    tone: 'paper',
  },
  {
    title: 'Which stage is missing?',
    body: 'Detect reported failures, missing stages, SLA violations, and unexpected sequences.',
    tone: 'signal',
  },
  {
    title: 'Who is affected?',
    body: 'Translate technical events into client, process, and customer context.',
    tone: 'ink',
  },
  {
    title: 'Who owns the response?',
    body: 'Assign, acknowledge, resolve, and report from one incident workspace.',
    tone: 'paper',
  },
] as const;

const processStages = [
  ['Make', 'Payment received'],
  ['Custom API', 'Account provisioned'],
  ['n8n', 'Workspace created'],
  ['Email', 'Welcome sent'],
  ['Slack', 'Operations notified'],
] as const;

const architecture = [
  ['Ingest', 'Secure HTTP events from n8n, Make, and custom services.'],
  ['Correlate', 'Deterministic process instances with idempotent event handling.'],
  ['Detect', 'Workers evaluate failures, timeouts, and stage order.'],
  ['Operate', 'A multi-client incident inbox keeps access and response clear.'],
] as const;

export function LandingPage() {
  useEffect(() => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      elements.forEach((element) => element.classList.add('is-visible'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.16 },
    );

    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="landing">
      <a className="landing__skip" href="#main">
        Skip to content
      </a>

      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="Outtrace home">
          <span className="wordmark__mark" aria-hidden="true">
            O/
          </span>
          <span>Outtrace</span>
        </a>
        <nav className="site-nav" aria-label="Portfolio case study">
          <a href="#problem">Problem</a>
          <a href="#system">System</a>
          <a href="#architecture">Architecture</a>
        </nav>
        <a
          className="header-link"
          href="https://github.com/ostenmatrixx/outtrace"
          target="_blank"
          rel="noreferrer"
        >
          View source
        </a>
      </header>

      <main id="main">
        <section className="hero" id="top">
          <div className="hero__copy">
            <p className="eyebrow">Cross-platform process monitoring</p>
            <h1>Catch process failures.</h1>
            <p className="hero__intro">
              Outtrace turns scattered workflow events into business-level incidents your agency can
              act on.
            </p>
            <div className="hero__actions">
              <a className="button button--primary" href="#system">
                View the system
              </a>
              <a
                className="button button--secondary"
                href="https://github.com/ostenmatrixx/outtrace"
                target="_blank"
                rel="noreferrer"
              >
                View source
              </a>
            </div>
          </div>
          <figure className="hero__art">
            <img
              src="/assets/outtrace-trace-field.jpg"
              alt="Abstract process traces converging into one clear operational timeline"
              width="1456"
              height="1092"
              fetchPriority="high"
            />
          </figure>
        </section>

        <dl className="project-band" aria-label="Project details">
          <div>
            <dt>Project</dt>
            <dd>Outtrace MVP</dd>
          </div>
          <div>
            <dt>Focus</dt>
            <dd>Product design and engineering</dd>
          </div>
          <div>
            <dt>Audience</dt>
            <dd>Automation agencies</dd>
          </div>
          <div>
            <dt>Year</dt>
            <dd>2026</dd>
          </div>
        </dl>

        <section className="problem section-shell" id="problem" data-reveal>
          <div className="section-heading">
            <h2>Platform logs show executions. Agencies need the full story.</h2>
            <p>
              A client onboarding can cross five systems. Each tool sees its own step, but none can
              confirm that the business process finished.
            </p>
          </div>
          <div className="problem__body">
            <figure className="problem__art">
              <img
                src="/assets/outtrace-missing-stage.jpg"
                alt="A process sequence with one visibly missing stage"
                width="1254"
                height="1254"
                loading="lazy"
              />
            </figure>
            <blockquote>
              <p>
                The failure is often discovered when the client asks why their customer is still
                waiting.
              </p>
              <footer>Product problem</footer>
            </blockquote>
          </div>
        </section>

        <section className="process section-shell" aria-labelledby="process-title" data-reveal>
          <div>
            <h2 id="process-title">One process can span every tool.</h2>
            <p>
              Outtrace follows the business identifier across platforms, then evaluates the whole
              sequence.
            </p>
          </div>
          <ol className="process__track">
            {processStages.map(([source, stage], index) => (
              <li key={stage} style={{ '--stage-index': index } as React.CSSProperties}>
                <span>{source}</span>
                <strong>{stage}</strong>
              </li>
            ))}
          </ol>
        </section>

        <section className="system section-shell" id="system" data-reveal>
          <div className="section-heading section-heading--narrow">
            <h2>Designed around the operator’s next question.</h2>
            <p>
              The product turns telemetry into four concrete answers, without collecting complete
              customer payloads.
            </p>
          </div>
          <div className="system-grid">
            {systemQuestions.map((item, index) => (
              <article
                className={`system-card system-card--${item.tone}`}
                key={item.title}
                style={{ '--card-index': index } as React.CSSProperties}
              >
                <span className="system-card__number" aria-hidden="true">
                  0{index + 1}
                </span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="architecture section-shell" id="architecture" data-reveal>
          <div className="architecture__lead">
            <h2>A small system with deliberate boundaries.</h2>
            <p>
              Outtrace observes and explains. It does not execute workflows, retry external actions,
              or store full payloads by default.
            </p>
            <a
              className="text-link"
              href="https://github.com/ostenmatrixx/outtrace"
              target="_blank"
              rel="noreferrer"
            >
              View source
            </a>
          </div>
          <ol className="architecture__list">
            {architecture.map(([title, body], index) => (
              <li key={title}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="closing section-shell" data-reveal>
          <div>
            <p>Portfolio case study</p>
            <h2>Built from event contract to incident response.</h2>
          </div>
          <a
            className="button button--primary"
            href="https://github.com/ostenmatrixx/outtrace"
            target="_blank"
            rel="noreferrer"
          >
            View source
          </a>
        </section>
      </main>

      <footer className="site-footer">
        <a className="wordmark" href="#top">
          <span className="wordmark__mark" aria-hidden="true">
            O/
          </span>
          <span>Outtrace</span>
        </a>
        <p>Designed and built by Austin Gabriel Diaz.</p>
        <p>Process clarity for automation agencies.</p>
      </footer>
    </div>
  );
}
