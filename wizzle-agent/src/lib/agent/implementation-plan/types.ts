export type ImplementationPlanStatus = "awaiting_user" | "completed" | "in_progress";

export type ImplementationPlanStepStatus = "completed" | "in_progress" | "pending";

export type ImplementationPlanTaskType =
  | "bug_fix"
  | "debugging"
  | "implementation"
  | "new_project"
  | "review"
  | "other";

export type ImplementationPlanApproach = {
  id: string;
  summary: string;
  title: string;
  tradeoffs: string[];
};

export type ImplementationPlanAffectedFile = {
  path: string;
  reason: string;
};

export type ImplementationPlanStep = {
  details: string;
  id: string;
  kind: "implementation" | "verification";
  status: ImplementationPlanStepStatus;
  title: string;
};

export type ImplementationPlanState = {
  affectedFiles: ImplementationPlanAffectedFile[];
  approaches: ImplementationPlanApproach[];
  concerns: string[];
  createdAtMs: number;
  findings: string[];
  gaps: string[];
  goal: string;
  intendedFix?: string;
  markdown?: string;
  planPath: string;
  recommendedApproachId: string;
  rootCause?: string;
  selectedApproachId?: string;
  status: ImplementationPlanStatus;
  steps: ImplementationPlanStep[];
  summary: string;
  taskType: ImplementationPlanTaskType;
  title: string;
  updatedAtMs: number;
  version: 1;
};

export type ImplementationPlanToolInput = {
  action?: "advance" | "save";
  markdown?: string;
};

export type ImplementationPlanToolStep = Pick<
  ImplementationPlanStep,
  "kind" | "status" | "title"
>;

export type ImplementationPlanToolResult = {
  currentStep?: ImplementationPlanToolStep;
  note: string;
  ok: true;
  path: string;
  status: ImplementationPlanStatus;
  steps: ImplementationPlanToolStep[];
  stopTurn: boolean;
};
