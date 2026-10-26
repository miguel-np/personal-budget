export interface TestedTransition {
  readonly from: string;
  readonly to: string;
  readonly status: 'verified';
  readonly evidence: string;
}

const IMAGE_PATTERN = /^actualbudget\/actual-server:(\d+)\.(\d+)\.(\d+)$/;

export function parseActualImage(image: string): { readonly image: string; readonly version: string } {
  const normalized = image.trim();
  const match = IMAGE_PATTERN.exec(normalized);
  if (!match) {
    throw new Error('Actual image must use the official repository and an exact semantic version tag; latest and floating tags are not allowed.');
  }
  return { image: normalized, version: match[1] + '.' + match[2] + '.' + match[3] };
}

export function assertSupportedTransition(
  currentImage: string,
  targetImage: string,
  transitions: readonly TestedTransition[],
): { readonly current: string; readonly target: string } {
  const current = parseActualImage(currentImage);
  const target = parseActualImage(targetImage);
  if (current.version === target.version) throw new Error('Target image is already configured; there is no update to apply.');
  const supported = transitions.some((transition) =>
    transition.status === 'verified' &&
    transition.from === current.version &&
    transition.to === target.version,
  );
  if (!supported) {
    throw new Error('The transition from Actual ' + current.version + ' to ' + target.version +
      ' is not in the tested compatibility matrix. No update was started.');
  }
  return { current: current.version, target: target.version };
}

export function recoveryMode(stage: 'before-pull' | 'after-pull' | 'after-start'): 'restart-previous' | 'stop-and-explicitly-restore' {
  return stage === 'after-start' ? 'stop-and-explicitly-restore' : 'restart-previous';
}
