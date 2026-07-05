/**
 * 1XX1 Logical Time
 * FAZ 0.2 — Clock + Time Model
 *
 * Kural:
 *   logicalTime asla geri gitmez
 *   Remote time gelince max(local, remote) alinir
 *   Drift tolerance: ±250ms
 */

const DRIFT_TOLERANCE_MS = 250;

let _logicalTime = Date.now();

export function getLogicalTime(): number {
  return _logicalTime;
}

export function updateLogicalTime(remoteTime?: number): number {
  const now = Date.now();

  if (remoteTime !== undefined) {
    // Drift kontrolu: remote zaman cok ilerde ise kabul etme
    if (remoteTime > now + DRIFT_TOLERANCE_MS * 10) {
      // Supheceli - sadece now kullane
      _logicalTime = Math.max(_logicalTime, now);
    } else {
      _logicalTime = Math.max(_logicalTime, remoteTime, now);
    }
  } else {
    _logicalTime = Math.max(_logicalTime, now);
  }

  return _logicalTime;
}

/** Log entry icin standart zaman damgasi */
export function logTimestamp(nodeId: string): {
  ts: number;
  logicalTime: number;
  nodeId: string;
} {
  return {
    ts:          Date.now(),
    logicalTime: updateLogicalTime(),
    nodeId,
  };
}
