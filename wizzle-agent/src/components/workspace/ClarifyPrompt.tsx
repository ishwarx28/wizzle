import { CircleHelp, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { useWorkspaceStore } from "../../store/workspace-store";

export function ClarifyPrompt() {
  const request = useWorkspaceStore((state) => state.pendingWorkflowQuestion);
  const resolve = useWorkspaceStore((state) => state.resolveWorkflowQuestions);
  const [answer, setAnswer] = useState("");
  const [customAnswer, setCustomAnswer] = useState("");

  useEffect(() => {
    setAnswer("");
    setCustomAnswer("");
  }, [request?.toolCallId]);

  if (!request) return null;

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--color-brand-green)_28%,var(--color-border))] bg-[var(--color-panel)] shadow-[0_10px_28px_rgba(0,0,0,0.16)]">
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--color-brand-green)_12%,transparent)] text-[var(--color-brand-green)]">
          <CircleHelp className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-[var(--color-text)]">
            {request.kind === "approach" ? "Choose an approach" : "Clarification needed"}
          </div>
          <p className="mt-1.5 text-[12px] leading-4 text-[var(--color-text-secondary)]">{request.prompt}</p>
          {request.choices?.length ? (
            <div className="mt-2 space-y-1">
              {request.choices.map((choice, index) => (
                <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--color-panel-hover)]" key={choice}>
                  <input checked={answer === choice} className="accent-[var(--color-brand-green)]" name="clarify-choice" onChange={() => setAnswer(choice)} type="radio" />
                  <span className="text-[12px] text-[var(--color-text)]">{choice}</span>
                  {request.recommended === index ? <span className="ml-auto inline-flex items-center gap-0.5 text-[11px] text-[var(--color-brand-green)]"><Sparkles className="h-3 w-3" /> Recommended</span> : null}
                </label>
              ))}
            </div>
          ) : null}
          {!request.choices?.length || request.allowCustomAnswer !== false ? (
            <input
              className="mt-2 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel-subtle)] px-2 py-1.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-brand-green)]"
              onChange={(event) => {
                setCustomAnswer(event.currentTarget.value);
                setAnswer(event.currentTarget.value);
              }}
              placeholder="Type your answer"
              value={customAnswer}
            />
          ) : null}
        </div>
        <button className="shrink-0 rounded-lg bg-[var(--color-brand-green)] px-3 py-1.5 text-[12px] font-medium text-black disabled:opacity-40" disabled={!answer.trim()} onClick={() => resolve(answer.trim(), request.toolCallId)} type="button">
          Continue
        </button>
      </div>
    </div>
  );
}
