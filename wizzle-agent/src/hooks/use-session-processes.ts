import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  filterProcessesForSession,
  selectActiveSessionProcesses,
  upsertProcessList,
} from "../lib/session-processes";
import { listAgentProcesses, stopAgentProcess } from "../lib/local-workspace";
import type { WorkspaceProcess } from "../types/workspace";

const AGENT_PROCESS_EVENT = "agent-process-updated";

export function useSessionProcesses(sessionId: string | null) {
  const [processes, setProcesses] = useState<WorkspaceProcess[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [stoppingIds, setStoppingIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setProcesses([]);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const next = await listAgentProcesses(sessionId);
      setProcesses(next);
    } catch (loadError) {
      setError(
        loadError instanceof Error && loadError.message.trim()
          ? loadError.message
          : "Could not load background processes.",
      );
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<WorkspaceProcess>(AGENT_PROCESS_EVENT, (event) => {
      if (disposed || !sessionId || event.payload.sessionId !== sessionId) {
        return;
      }

      setProcesses((current) => upsertProcessList(current, event.payload));
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }

      unlisten = dispose;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [sessionId]);

  const stopProcess = useCallback(
    async (processId: string) => {
      if (!sessionId) {
        return;
      }

      setStoppingIds((current) =>
        current.includes(processId) ? current : [...current, processId],
      );
      setError(null);

      try {
        const stopped = await stopAgentProcess(sessionId, processId);
        setProcesses((current) => upsertProcessList(current, stopped));
      } catch (stopError) {
        setError(
          stopError instanceof Error && stopError.message.trim()
            ? stopError.message
            : "Could not stop the process.",
        );
      } finally {
        setStoppingIds((current) => current.filter((id) => id !== processId));
      }
    },
    [sessionId],
  );

  const sessionProcesses = useMemo(
    () => filterProcessesForSession(processes, sessionId),
    [processes, sessionId],
  );
  const activeProcesses = useMemo(
    () => selectActiveSessionProcesses(sessionProcesses),
    [sessionProcesses],
  );

  return {
    activeProcesses,
    error,
    isLoading,
    refresh,
    sessionProcesses,
    stopProcess,
    stoppingIds,
  };
}
