/** Explicit test review between independent failure cases in one panel session. */
export async function reviewRecoveryFixture(registry: { dispatch(command: string, args: Record<string, unknown>): Promise<any> }): Promise<void> {
  const view = await registry.dispatch("operations.recovery.inspect", {});
  if (!view.recoveryRequired) return;
  await registry.dispatch("operations.recovery.acknowledge", {
    expectedRecoveryRevision: view.recoveryRevision,
    expectedIdentityRevision: view.identityRevision,
    operationIds: view.operations.map((operation: { id: string }) => operation.id),
    reviewed: true,
  });
}
