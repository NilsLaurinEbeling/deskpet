import { useEffect, useRef, useState } from 'react';

import { describeError } from '../../shared/ipc';
import { PetStage, type StageStatus } from './PetStage';

const INITIAL: StageStatus = {
  geometry: null,
  cursor: null,
  fps: 0,
  clicks: 0,
  dragging: false,
  mask: null,
  error: null,
};

export function OverlayApp(): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<StageStatus>(INITIAL);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let stage: PetStage | null = null;
    let cancelled = false;

    PetStage.mount(host, setStatus)
      .then((mounted) => {
        if (cancelled) mounted.destroy();
        else stage = mounted;
      })
      .catch((cause: unknown) => setFatal(describeError(cause)));

    return () => {
      cancelled = true;
      stage?.destroy();
    };
  }, []);

  const error = fatal ?? status.error;

  return (
    <>
      <div ref={hostRef} />
      {error !== null && <ErrorBanner message={error} />}
      {import.meta.env.DEV && <DebugHud status={status} />}
    </>
  );
}

/**
 * The overlay has no window chrome and never takes focus, so a failure has to
 * be visible right here — silent failure is not an option (CLAUDE.md §7).
 */
function ErrorBanner({ message }: { message: string }): JSX.Element {
  return (
    <div
      style={{
        position: 'fixed',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        maxWidth: '80vw',
        padding: '8px 14px',
        borderRadius: 8,
        background: 'rgba(140, 22, 22, 0.92)',
        color: '#fff',
        font: '13px/1.4 system-ui, sans-serif',
        boxShadow: '0 6px 20px rgba(0, 0, 0, 0.35)',
        pointerEvents: 'none',
      }}
    >
      deskpet: {message}
    </div>
  );
}

/** Dev-only. The overlay never has focus, so there is no key to toggle it. */
function DebugHud({ status }: { status: StageStatus }): JSX.Element {
  const { geometry, cursor, mask } = status;
  const rows: [string, string][] = [
    ['fps', String(status.fps)],
    [
      'window',
      geometry
        ? `${Math.round(geometry.width)}x${Math.round(geometry.height)} @${geometry.scaleFactor}x`
        : '—',
    ],
    ['ground y', geometry ? String(Math.round(geometry.groundY)) : '—'],
    ['monitor', geometry?.monitor ?? '—'],
    ['cursor', cursor ? `${Math.round(cursor.x)}, ${Math.round(cursor.y)}` : '—'],
    ['over pet', cursor ? String(cursor.overPet) : '—'],
    ['interactive', cursor ? String(cursor.interactive) : '—'],
    ['mask', mask ? `${mask.cols}x${mask.rows} (${mask.bytes} B)` : '—'],
    ['clicks', String(status.clicks)],
    ['dragging', String(status.dragging)],
  ];

  return (
    <div
      style={{
        position: 'fixed',
        top: 12,
        left: 12,
        padding: '10px 12px',
        borderRadius: 8,
        background: 'rgba(16, 20, 32, 0.72)',
        color: '#e8ecf7',
        font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
        pointerEvents: 'none',
      }}
    >
      <strong style={{ display: 'block', marginBottom: 4 }}>deskpet · phase 1</strong>
      <table style={{ borderSpacing: 0 }}>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <td style={{ paddingRight: 12, opacity: 0.6 }}>{label}</td>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
