import { Check, Circle, CircleDot, X } from "lucide-react";
import { useEffect, useState } from "react";

import { loadTodoState, subscribeTodoState } from "../../lib/agent/todos/storage";
import type { TodoState } from "../../lib/agent/todos/types";
import { useWorkspaceStore } from "../../store/workspace-store";

function ProgressRing({ completed, total, size = 16 }: { completed: number; size?: number; total: number }) {
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const progress = total > 0 ? completed / total : 0;

  return (
    <svg aria-hidden className="-rotate-90" height={size} viewBox="0 0 18 18" width={size}>
      <circle cx="9" cy="9" fill="none" r={radius} stroke="var(--color-border-strong)" strokeWidth="2" />
      <circle
        cx="9"
        cy="9"
        fill="none"
        r={radius}
        stroke="var(--color-brand-green)"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - progress)}
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}

export function SessionTodoOverlay() {
  const sessionId = useWorkspaceStore((state) => state.selectedSessionId);
  const isStreaming = useWorkspaceStore((state) =>
    Boolean(state.selectedSessionId && state.sendingSessionIds.includes(state.selectedSessionId)),
  );
  const [todo, setTodo] = useState<TodoState | null>(null);

  useEffect(() => {
    let active = true;
    setTodo(null);
    if (sessionId) {
      void loadTodoState(sessionId)
        .then((state) => {
          if (active) setTodo(state);
        })
        .catch(() => undefined);
    }
    const unsubscribe = subscribeTodoState((changedSessionId, state) => {
      if (active && changedSessionId === sessionId) setTodo(state);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [sessionId]);

  if (!isStreaming || !todo?.items.length) return null;

  const completed = todo.items.filter((item) => item.status === "completed" || item.status === "cancelled").length;
  return (
    <div className="group/todo relative shrink-0">
      <button
        aria-label={`Todo ${completed} of ${todo.items.length}`}
        className="flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-panel)_94%,transparent)] px-3 py-1.5 text-[12px] font-medium leading-none text-[var(--color-text)] shadow-[0_8px_20px_rgba(0,0,0,0.14)] backdrop-blur-xl transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-panel-hover)]"
        type="button"
      >
        <ProgressRing completed={completed} size={18} total={todo.items.length} />
        Todo {completed}/{todo.items.length}
      </button>

      <div className="pointer-events-none absolute bottom-full left-1/2 z-30 w-[320px] -translate-x-1/2 pb-2 opacity-0 transition duration-150 group-hover/todo:pointer-events-auto group-hover/todo:opacity-100 group-focus-within/todo:pointer-events-auto group-focus-within/todo:opacity-100">
        <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-panel)_97%,transparent)] p-3 shadow-[0_14px_36px_rgba(0,0,0,0.22)] backdrop-blur-xl">
          <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
            {todo.items.map((item) => {
              const Icon = item.status === "completed" ? Check : item.status === "cancelled" ? X : item.status === "in_progress" ? CircleDot : Circle;
              return (
                <div className="flex items-start gap-2 text-[12px] leading-4" key={item.id}>
                  <Icon className={[
                    "mt-0.5 h-3.5 w-3.5 shrink-0",
                    item.status === "completed" ? "text-[var(--color-brand-green)]" : item.status === "in_progress" ? "text-[var(--color-accent)]" : "text-[var(--color-text-tertiary)]",
                  ].join(" ")} />
                  <span className={item.status === "completed" || item.status === "cancelled" ? "text-[var(--color-text-tertiary)] line-through" : item.status === "in_progress" ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-secondary)]"}>
                    {item.title}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
