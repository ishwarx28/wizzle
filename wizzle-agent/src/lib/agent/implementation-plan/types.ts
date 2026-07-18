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

export type ImplementationPlanApproachInput = {
  summary?: string;
  title?: string;
  tradeoffs?: string[];
};

export type ImplementationPlanAffectedFileInput = {
  path?: string;
  reason?: string;
};

export type ImplementationPlanStepInput = {
  details?: string;
  title?: string;
};

export type ImplementationPlanToolInput = {
  action?: "complete_step" | "create" | "resume" | "revise" | "start_step" | "status";
  affectedFiles?: ImplementationPlanAffectedFileInput[];
  approaches?: ImplementationPlanApproachInput[];
  approachId?: string;
  concerns?: string[];
  findings?: string[];
  gaps?: string[];
  goal?: string;
  implementationSteps?: ImplementationPlanStepInput[];
  intendedFix?: string;
  recommendedApproach?: number;
  rootCause?: string;
  stepId?: string;
  summary?: string;
  taskType?: ImplementationPlanTaskType;
  title?: string;
  verificationSteps?: ImplementationPlanStepInput[];
};

export type ImplementationPlanToolResult = ImplementationPlanState & {
  currentStep?: ImplementationPlanStep;
  note: string;
  ok: true;
  path: string;
  stopTurn: boolean;
};
