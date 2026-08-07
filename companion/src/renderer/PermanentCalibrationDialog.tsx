import { useEffect, useState } from 'react';
import './permanent-calibration-dialog.css';

/**
 * Confirmation for making a calibration permanent.
 *
 * This is the only action in the app that can leave a controller unusable, so the dialog states
 * that plainly rather than burying it in a caution. It exists to make the decision INFORMED, not
 * to make it feel safe: nobody should agree to this without knowing the sequence is
 * reverse-engineered, that it can fail, and that a reset will not undo it.
 *
 * The confirm phrase is deliberately not "OK". A dialog dismissed by reflex has not obtained
 * consent to a permanent, unrecoverable write to someone else's hardware.
 */

const CONFIRM_PHRASE = 'MAKE PERMANENT';

export function PermanentCalibrationDialog({
  open,
  onCancel,
  onConfirm
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');

  // Never carry a previous confirmation into the next prompt.
  useEffect(() => {
    if (!open) {
      setTyped('');
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const matches = typed.trim().toUpperCase() === CONFIRM_PHRASE;

  return (
    <div className="pcd-backdrop" role="dialog" aria-modal="true" aria-label="Make calibration permanent">
      <div className="pcd">
        <h2>Write calibration permanently?</h2>

        <p className="pcd-lead">
          This unlocks your controller&rsquo;s permanent storage and writes the calibration into
          it. Unlike everything else in this window, <strong>a reset will not undo it</strong>.
        </p>

        <ul className="pcd-risks">
          <li>
            <strong>It can permanently break the controller.</strong> The author of the research
            this is based on puts it plainly: be prepared to throw the controller away.
          </li>
          <li>
            <strong>Nobody can guarantee it works.</strong> The unlock sequence is
            reverse-engineered, not documented by Sony, and was worked out on a handful of units.
            Yours may behave differently.
          </li>
          <li>
            <strong>There is no undo.</strong> Reverting means calibrating again and getting a
            good result &mdash; there is no factory reset for this.
          </li>
          <li>
            <strong>An interruption is the dangerous case.</strong> If the controller disconnects
            or the battery dies mid-write, it can be left with calibration data that is neither
            the old values nor the new ones.
          </li>
        </ul>

        <p className="pcd-advice">
          Run the temporary calibration first and confirm you are happy with how the sticks feel.
          It does the same thing and reverts on reset. Only make it permanent once you know the
          result is one you want to keep.
        </p>

        <label className="pcd-confirm">
          <span>
            Type <strong>{CONFIRM_PHRASE}</strong> to continue
          </span>
          <input
            type="text"
            value={typed}
            autoFocus
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={CONFIRM_PHRASE}
          />
        </label>

        <div className="pcd-actions">
          <button type="button" className="pcd-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="pcd-go"
            disabled={!matches}
            onClick={onConfirm}
          >
            Write permanently
          </button>
        </div>
      </div>
    </div>
  );
}
