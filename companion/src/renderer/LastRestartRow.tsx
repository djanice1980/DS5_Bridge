import { useEffect, useState } from 'react';
import { formatRestartDuration, formatRestartReport } from '../shared/bridge-restart';
import type { BridgeRestart } from '../shared/types';

const HEADLINE: Record<BridgeRestart['kind'], string> = {
  crash: 'Crashed',
  hang: 'Froze',
  'audio-stall': 'Audio froze',
  unknown: 'Unexpected'
};

const COPIED_FLASH_MS = 1600;

function detailLine(restart: BridgeRestart): string {
  const parts: string[] = [];
  if (restart.area) parts.push(`while ${restart.area}`);
  if (restart.uptimeBeforeSeconds !== null) {
    parts.push(`after ${formatRestartDuration(restart.uptimeBeforeSeconds)} running`);
  }
  if (restart.consecutive !== null && restart.consecutive > 1) {
    parts.push(`${restart.consecutive} in a row`);
  }
  return parts.join(' · ');
}

/**
 * The Device card's "Last Restart" row. Only rendered after the bridge restarted on its own:
 * from the outside a crash looks like a random controller disconnect, so this is where the
 * app says what actually happened.
 */
export function LastRestartRow({ restart, firmwareVersion, appVersion }: {
  readonly restart: BridgeRestart;
  readonly firmwareVersion: string | null;
  readonly appVersion: string | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), COPIED_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const ago = restart.restartedAtUnixMs !== null
    ? ` · ${formatRestartDuration((now - restart.restartedAtUnixMs) / 1000)} ago`
    : '';
  const detail = detailLine(restart);

  const copy = () => {
    const text = formatRestartReport(restart, { firmwareVersion, appVersion });
    void navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false));
  };

  return (
    <div className="device-row device-restart-row">
      <span>Last Restart</span>
      <div className="device-restart-value">
        <strong className="health-label" title={restart.summary}>
          <span className="dot warn" />
          {`${HEADLINE[restart.kind]}${ago}`}
        </strong>
        {detail ? <small className="device-restart-detail">{detail}</small> : null}
        <button type="button" className="secondary-action device-restart-copy" onClick={copy}>
          {copied ? 'Copied' : 'Copy details'}
        </button>
      </div>
    </div>
  );
}
