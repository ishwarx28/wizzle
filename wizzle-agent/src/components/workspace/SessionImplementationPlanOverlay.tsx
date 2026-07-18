import { FileText } from "lucide-react";
import { useEffect, useState } from "react";

import {
  loadImplementationPlanState,
  subscribeImplementationPlanState,
} from "../../lib/agent/implementation-plan/storage";
import type { ImplementationPlanState } from "../../lib/agent/implementation-plan/types";
import { useWorkspaceStore } from "../../store/workspace-store";

export function SessionImplementationPlanOverlay() {
  const sessionId = useWorkspaceStore((state) => state.selectedSessionId);
  const openFileFromPath = useWorkspaceStore((state) => state.openFileFromPath);
  const [plan, setPlan] = useState<ImplementationPlanState | null>(null);

  useEffect(() => {
    let active = true;
    setPlan(null);
    if (sessionId) {
      void loadImplementationPlanState(sessionId)
        .then((state) => {
          if (active) setPlan(state);
        })
        .catch(() => undefined);
    }
    const unsubscribe = subscribeImplementationPlanState((changedSessionId, state) => {
      if (active && changedSessionId === sessionId) setPlan(state);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [sessionId]);

  if (!plan) return null;

  return (
    <button
      aria-label="Read implementation plan"
      className="flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-panel)_94%,transparent)] px-3 py-1.5 text-[12px] font-medium leading-none text-[var(--color-text)] shadow-[0_8px_20px_rgba(0,0,0,0.14)] backdrop-blur-xl transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-panel-hover)]"
      onClick={() => {
        void openFileFromPath(plan.planPath, "Implementation plan ready for review");
      }}
      type="button"
    >
      <FileText className="h-3.5 w-3.5 text-[var(--color-text-secondary)]" />
      Read plan
    </button>
  );
}
