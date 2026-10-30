import { useEffect, useMemo, useRef, useState } from 'react';
import { IconClockHour4, IconShieldLock, IconX as X } from '@tabler/icons-react';
import type { BootloaderConfirmationFaceButton, BootloaderConfirmationPresentation } from '../shared/types';
import './bootloader-confirmation.css';

// Ported from upstream 2.0's bootloader-confirmation feature, flattened into the
// fork's single-folder renderer (no localization catalogs here; the strings are
// the English ones both lineages share).

/** How long the "incorrect, start again" state stays up after a wrong press. */
const INCORRECT_FLASH_MS = 1600;

type ConfirmationStepState = 'complete' | 'current' | 'pending';

function confirmationStepState(index: number, progress: number): ConfirmationStepState {
  if (index < progress) return 'complete';
  if (index === progress) return 'current';
  return 'pending';
}

function secondsUntil(expiresAtUnixMs: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAtUnixMs - now) / 1000));
}

const FACE_BUTTON_LABELS: Record<BootloaderConfirmationFaceButton, string> = {
  triangle: 'Triangle',
  circle: 'Circle',
  cross: 'Cross',
  square: 'Square'
};

/** The symbol inside a PlayStation face button, drawn in a 512-unit box like the glyph assets. */
function FaceButtonSymbol({ button }: { readonly button: BootloaderConfirmationFaceButton }) {
  switch (button) {
    case 'triangle':
      return <polygon points="256 158 158 322 354 322" />;
    case 'circle':
      return <circle cx="256" cy="256" r="94" />;
    case 'cross':
      return (
        <>
          <line x1="172" y1="172" x2="340" y2="340" />
          <line x1="340" y1="172" x2="172" y2="340" />
        </>
      );
    case 'square':
      return <rect x="172" y="172" width="168" height="168" />;
  }
}

/**
 * A PlayStation face button: a dark key with the symbol in its traditional
 * color (teal-green triangle, red circle, blue cross, pink square).
 */
function FaceButtonGlyph({ button }: { readonly button: BootloaderConfirmationFaceButton }) {
  return (
    <svg
      className={`face-button-glyph face-button-${button}`}
      viewBox="0 0 512 512"
      role="img"
      aria-label={FACE_BUTTON_LABELS[button]}
    >
      <circle className="face-button-key" cx="256" cy="256" r="232" />
      <g className="face-button-symbol">
        <FaceButtonSymbol button={button} />
      </g>
    </svg>
  );
}

export interface BootloaderConfirmationDialogProps {
  /** The pending confirmation from the snapshot; the dialog renders nothing without one. */
  readonly confirmation: BootloaderConfirmationPresentation | null | undefined;
  readonly onCancel: () => void;
}

/**
 * Shown over every page while the bridge waits for the face-button sequence
 * that allows UF2 mode, or that pairs this computer with the bridge the first
 * time. Cancelling stops the pending Mount, Flash, or Nuke action.
 */
export function BootloaderConfirmationDialog({ confirmation, onCancel }: BootloaderConfirmationDialogProps) {
  if (!confirmation) return null;
  return <PendingConfirmation confirmation={confirmation} onCancel={onCancel} />;
}

function PendingConfirmation({ confirmation, onCancel }: {
  readonly confirmation: BootloaderConfirmationPresentation;
  readonly onCancel: () => void;
}) {
  const { purpose, sequence, progress, mistakes, expiresAtUnixMs } = confirmation;
  const [now, setNow] = useState(() => Date.now());
  // When this deadline was first seen; the time bar drains from there.
  const shownAt = useMemo(() => Date.now(), [expiresAtUnixMs]);
  const [incorrect, setIncorrect] = useState(false);
  const mistakesRef = useRef(mistakes);
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [expiresAtUnixMs]);

  useEffect(() => {
    const previous = mistakesRef.current;
    mistakesRef.current = mistakes;
    if (mistakes <= previous) return undefined;
    setIncorrect(true);
    const timer = window.setTimeout(() => setIncorrect(false), INCORRECT_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [mistakes]);

  useEffect(() => {
    dialogRef.current?.focus();
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelRef.current();
    };
    document.addEventListener('keydown', cancelOnEscape);
    return () => document.removeEventListener('keydown', cancelOnEscape);
  }, []);

  const enrollment = purpose === 'enrollment';
  const secondsRemaining = secondsUntil(expiresAtUnixMs, now);
  const totalMs = Math.max(1, expiresAtUnixMs - shownAt);
  const remainingFraction = Math.min(1, Math.max(0, (expiresAtUnixMs - now) / totalMs));
  const title = enrollment ? "Confirm it's you" : 'Confirm UF2 update mode';

  return (
    <div className="modal-backdrop bootloader-confirmation-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className={`settings-menu bridge-settings-modal bootloader-confirmation-modal ${incorrect ? 'incorrect' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bootloader-confirmation-title"
        aria-describedby="bootloader-confirmation-instructions"
        data-purpose={purpose}
        tabIndex={-1}
      >
        <div className="settings-menu-heading bridge-settings-modal-heading">
          <div className="modal-heading-copy">
            <IconShieldLock size={16} />
            <span>{enrollment ? 'Pair This PC' : 'UF2 Update Mode'}</span>
          </div>
          <button
            className="modal-close-button"
            type="button"
            aria-label="Cancel controller confirmation"
            title="Cancel"
            onClick={onCancel}
          >
            <X size={16} />
          </button>
        </div>

        <div className="bootloader-confirmation-copy">
          <h2 id="bootloader-confirmation-title">{title}</h2>
          {enrollment ? (
            <p>This pairs this PC with the bridge so only DS5 Bridge on this computer can put it into update mode.</p>
          ) : null}
          <p id="bootloader-confirmation-instructions">
            Press these buttons in order on the controller connected to the bridge.
          </p>
        </div>

        <ol className="bootloader-confirmation-sequence" aria-label="Button sequence">
          {sequence.map((button, index) => {
            const state = confirmationStepState(index, progress);
            return (
              <li
                key={`${index}-${button}`}
                className={`bootloader-confirmation-step ${state}`}
                data-step-state={state}
                aria-current={state === 'current' ? 'step' : undefined}
              >
                <span className="bootloader-confirmation-step-number" aria-hidden="true">{index + 1}</span>
                <FaceButtonGlyph button={button} />
              </li>
            );
          })}
        </ol>

        <div className="bootloader-confirmation-time" aria-hidden="true">
          <span style={{ transform: `scaleX(${remainingFraction})` }} />
        </div>

        <div className="bootloader-confirmation-status">
          <span className="bootloader-confirmation-progress" role="status">
            {incorrect ? 'Incorrect, start again' : `${progress} of ${sequence.length} entered`}
          </span>
          <span className={`bootloader-confirmation-countdown ${secondsRemaining <= 10 ? 'urgent' : ''}`}>
            <IconClockHour4 size={15} aria-hidden="true" />
            {`${secondsRemaining}s left`}
          </span>
        </div>

        <div className="bootloader-confirmation-footer">
          <p className="bootloader-confirmation-hint">No controller? Hold BOOTSEL while plugging in the Pico.</p>
          <button type="button" className="secondary-action" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}
