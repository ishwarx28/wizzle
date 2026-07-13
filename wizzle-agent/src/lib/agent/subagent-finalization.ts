export function shouldDeferFinalForSubagentResponse(options: {
  candidateWasBuffered: boolean;
  injectedResponseCount: number;
  requiredJoinPending?: boolean;
}) {
  return (
    options.candidateWasBuffered &&
    (options.injectedResponseCount > 0 || options.requiredJoinPending === true)
  );
}
