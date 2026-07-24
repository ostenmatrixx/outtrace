import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useRef, useState } from 'react';

gsap.registerPlugin(useGSAP, ScrollTrigger);

const bentoItems = [
  {
    key: 'correlate',
    title: 'One identifier across every tool.',
    body: 'Outtrace joins separate workflow events into one business-level process instance.',
  },
  {
    key: 'detect',
    title: 'Find the break in sequence.',
    body: 'Reported failures, missing stages, SLA violations, and unexpected order are evaluated together.',
  },
  {
    key: 'explain',
    title: 'Technical signal. Business context.',
    body: 'Every incident names the affected client, process, instance, and stage.',
  },
  {
    key: 'respond',
    title: 'One place to respond.',
    body: 'Assign, acknowledge, resolve.',
  },
] as const;

const incidentTypes = [
  {
    title: 'Reported failure',
    body: 'A connected workflow sends a failed event with its source execution attached.',
  },
  {
    title: 'Missing stage',
    body: 'An expected handoff does not arrive within the time defined for the process.',
  },
  {
    title: 'SLA violation',
    body: 'The complete business process runs beyond its agreed maximum duration.',
  },
  {
    title: 'Unexpected sequence',
    body: 'A later stage arrives before a required predecessor has completed.',
  },
] as const;

const architecture = [
  ['Ingest', 'Secure HTTP events from n8n, Make, and custom services.'],
  ['Correlate', 'Idempotent events resolve into deterministic process instances.'],
  ['Evaluate', 'Workers detect failures, missing stages, and timing violations.'],
  ['Operate', 'A multi-client inbox keeps access, ownership, and response clear.'],
] as const;

const connectedSystems = ['n8n', 'Make', 'Custom APIs', 'Slack', 'PostgreSQL', 'Redis'];

export function LandingPage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [activeIncident, setActiveIncident] = useState(0);

  useGSAP(
    () => {
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reducedMotion) {
        gsap.set('[data-enter], .scale-media', { clearProps: 'all' });
        return;
      }

      gsap.from('[data-hero-enter]', {
        opacity: 0,
        y: 24,
        duration: 0.8,
        stagger: 0.08,
        ease: 'power3.out',
      });

      gsap.fromTo(
        '.hero__art',
        { opacity: 0, scale: 0.88 },
        { opacity: 1, scale: 1, duration: 1.1, ease: 'power3.out' },
      );

      gsap.utils.toArray<HTMLElement>('[data-enter]').forEach((element) => {
        gsap.from(element, {
          opacity: 0,
          y: 18,
          duration: 0.7,
          ease: 'power3.out',
          scrollTrigger: {
            trigger: element,
            start: 'top 86%',
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
          .fromTo(element, { scale: 0.8, opacity: 0.25 }, { scale: 1, opacity: 1 })
          .to(element, { scale: 0.96, opacity: 0.2 });
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

  return (
    <div className="landing" ref={rootRef}>
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
          View source
        </a>
      </header>

      <main id="main">
        <section className="hero" id="top">
          <div className="hero__copy">
            <h1 data-hero-enter>Every workflow. One operational truth.</h1>
            <p className="hero__intro" data-hero-enter>
              Outtrace connects scattered automation events into one incident view your agency can
              understand and act on.
            </p>
            <div className="hero__actions" data-hero-enter>
              <a className="button button--primary" href="#system">
                See how it works
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
              alt="Monochrome process traces converging into one operational timeline"
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
            <dt>Role</dt>
            <dd>Product design and engineering</dd>
          </div>
          <div>
            <dt>Audience</dt>
            <dd>Automation agencies</dd>
          </div>
          <div>
            <dt>Scope</dt>
            <dd>Event contract to incident response</dd>
          </div>
        </dl>

        <section className="systems-marquee" aria-label="Connected systems">
          <div className="systems-marquee__track">
            {[...connectedSystems, ...connectedSystems].map((system, index) => (
              <span key={`${system}-${index}`}>{system}</span>
            ))}
          </div>
        </section>

        <section className="interest section-shell" id="system">
          <div className="section-heading" data-enter>
            <h2>
              See every
              <span
                className="inline-visual"
                role="img"
                aria-label="process trace"
                style={{ backgroundImage: 'url(/assets/outtrace-missing-stage.jpg)' }}
              />
              handoff.
            </h2>
            <p>
              Platform logs describe individual executions. Outtrace follows the business process
              across all of them.
            </p>
          </div>

          <div className="bento-grid" data-enter>
            {bentoItems.map((item) => (
              <article className={`bento-card bento-card--${item.key}`} key={item.key}>
                {item.key === 'correlate' ? (
                  <figure className="bento-card__media">
                    <img
                      src="/assets/outtrace-trace-field.jpg"
                      alt=""
                      width="1456"
                      height="1092"
                      loading="lazy"
                    />
                  </figure>
                ) : null}
                <div className="bento-card__copy">
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="incident-section section-shell" id="incidents">
          <div className="section-heading section-heading--compact" data-enter>
            <h2>Four ways a process can fail.</h2>
            <p>Each incident type answers a different operational question.</p>
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
                  <p>{incident.body}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="desire section-shell" id="architecture">
          <div className="desire__sticky">
            <h2>A small system with clear boundaries.</h2>
            <p>
              Outtrace observes and explains. It does not execute workflows, retry external actions,
              or collect full payloads by default.
            </p>
          </div>

          <div className="desire__story">
            <figure className="desire__media scale-media">
              <img
                src="/assets/outtrace-missing-stage.jpg"
                alt="Monochrome sequence showing one missing process stage"
                width="1254"
                height="1254"
                loading="lazy"
              />
            </figure>
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
            <h2>Built for the gap between execution and impact.</h2>
            <p>
              Explore the event contract, worker, API, and incident workspace in the repository.
            </p>
          </div>
          <a
            className="button button--light"
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
