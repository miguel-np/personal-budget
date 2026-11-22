export function evaluateNegativeProbe(probe, observedSources) {
  const sources = Array.isArray(observedSources) ? observedSources : [];
  const validSources = sources.filter((source) => typeof source?.host === 'string' && source.host.length > 0);
  const forbiddenHosts = Array.isArray(probe?.forbiddenHosts)
    ? probe.forbiddenHosts.filter((host) => typeof host === 'string' && host.length > 0)
    : [];
  const forbiddenHostsObserved = forbiddenHosts.filter((forbidden) =>
    validSources.some((source) => source.host === forbidden || source.host.endsWith('.' + forbidden)));

  if (forbiddenHostsObserved.length > 0) {
    return { status: 'rejected', forbiddenHostsObserved };
  }

  if (typeof probe?.expectedExternalHost === 'string' && probe.expectedExternalHost.length > 0) {
    const matchingSources = validSources.filter((source) => source.host === probe.expectedExternalHost);
    if (matchingSources.length === 0) {
      return { status: 'not_observed', forbiddenHostsObserved };
    }

    const correctlyClassified = matchingSources.every((source) =>
      source.sourceAuthority === 'external' && source.documentRetrieved === false);
    return { status: correctlyClassified ? 'accepted' : 'rejected', forbiddenHostsObserved };
  }

  const requiredHosts = Array.isArray(probe?.requiredHosts)
    ? probe.requiredHosts.filter((host) => typeof host === 'string' && host.length > 0)
    : [];
  const requiredHostObserved = requiredHosts.some((required) =>
    validSources.some((source) => source.host === required));

  return {
    status: requiredHostObserved ? 'accepted' : 'not_observed',
    forbiddenHostsObserved,
  };
}
