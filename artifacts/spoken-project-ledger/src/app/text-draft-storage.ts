/** Text drafts belong to a server-derived account scope, never a display name. */
export type TextDraft = { text?: string; sourceId?: string; occurredAt?: string; pendingRequest?: { operation_id?: string } };
const PREFIX = 'spoken-projects:temporary-draft:v2:';
function key(scope: string): string {
  if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error('Invalid draft scope');
  return PREFIX + scope;
}
export function readTextDraft(storage: Pick<Storage, 'getItem'>, scope: string): TextDraft | null {
  const raw = storage.getItem(key(scope));
  if (!raw) return null;
  const draft: unknown = JSON.parse(raw);
  return draft && typeof draft === 'object' && !Array.isArray(draft) ? draft as TextDraft : null;
}
export function writeTextDraft(storage: Pick<Storage, 'setItem' | 'removeItem'>, scope: string, draft: TextDraft): void {
  const id = key(scope);
  if (draft.text || draft.pendingRequest) storage.setItem(id, JSON.stringify(draft));
  else storage.removeItem(id);
}
