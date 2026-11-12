/** The current account's tasks are the entire graph visible to the editor. */
export type DependencyTask = { id: string; dependencies: string[]; parent_id?: string | null };

/** Adding task -> predecessor must not make either dependencies or parent links cyclic. */
export function wouldCreateDependencyCycle(tasks: DependencyTask[], taskId: string | undefined, predecessorId: string): boolean {
  if (!taskId) return false;
  const byId = new Map(tasks.map(task => [task.id, task]));
  const seen = new Set<string>();
  const stack = [predecessorId];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === taskId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const task = byId.get(id);
    if (task) stack.push(...task.dependencies, ...(task.parent_id ? [task.parent_id] : []));
  }
  return false;
}
