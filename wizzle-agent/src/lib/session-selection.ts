/**
 * Resolve which session should be selected after workspace hydrate (#74).
 * Avoids half-null selection (project set, session null) when sessions exist.
 */

export type SessionSelectionCandidate = {
  id: string;
  updatedAtMs?: number;
};

export function pickLatestSessionId(
  sessions: readonly SessionSelectionCandidate[],
): string | null {
  if (sessions.length === 0) {
    return null;
  }

  let best = sessions[0]!;
  for (let index = 1; index < sessions.length; index += 1) {
    const candidate = sessions[index]!;
    if ((candidate.updatedAtMs ?? 0) > (best.updatedAtMs ?? 0)) {
      best = candidate;
    }
  }

  return best.id;
}

/**
 * Prefer a valid stored session id; otherwise a draft for the project;
 * otherwise the project's most recently updated session.
 */
export function resolveHydratedSessionSelection(options: {
  draftSessionId?: string | null;
  projectSessions: readonly SessionSelectionCandidate[];
  selectedSessionId: string | null | undefined;
}): string | null {
  const requested = options.selectedSessionId?.trim() || null;
  if (requested && options.projectSessions.some((session) => session.id === requested)) {
    return requested;
  }

  const draftId = options.draftSessionId?.trim() || null;
  if (draftId) {
    return draftId;
  }

  return pickLatestSessionId(options.projectSessions);
}
