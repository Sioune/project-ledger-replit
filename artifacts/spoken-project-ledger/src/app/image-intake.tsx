"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Check, ChevronRight, CircleAlert, FileImage, ImagePlus, LoaderCircle, RefreshCw, ShieldCheck, X } from "lucide-react";
import { CLASSIFICATION_LABELS, EMPTY_INTAKE_FIELDS, type ExistingTaskRef, type IntakeCapabilities, type IntakeFields, type IntakeImage, type IntakePreview, type RecognitionResult } from "@/lib/intake-types";
import type { Submit } from "@/lib/model";
import "./image-intake.css";

export type ImageIntakeProps = { accountScope: string; projects: { id: string; name: string }[]; tasks: ExistingTaskRef[]; revision: number; disabled: boolean; onSaved: (operationId: string) => Promise<boolean>; onPendingChange: (pending: boolean, scope: string) => void; onOpenTask: (id: string) => void };
type LocalImage = { blob: Blob; name: string; type: string; size: number; lastModified: number };
type StoredUpload = { objectPath: string; image: IntakeImage };
type IntakeDraft = { version: 1; sourceEventId: string; recognitionRequestId: string; recognitionModel: string | null; note: string; image: LocalImage | null; imageMeta: IntakeImage | null; upload: StoredUpload | null; fields: IntakeFields; mode: "image" | "manual"; recognitionQuestions: string[]; recognitionQuestionHistory: string[]; resolvedRecognitionQuestions: string[]; recognized: { provider: string; model: string } | null; preview: IntakePreview | null; pending: Submit | null; conflict: boolean; imageError: string; savedAt: string };
type Phase = "idle" | "running" | "error" | "done";
const MAX_BYTES = 1_500_000;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const STATUS = { todo: "待办", doing: "进行中", waiting: "等待反馈", blocked: "有前序依赖", done: "已完成", cancelled: "已取消" };
const EVENTS = { reserved: "已预约", planned: "计划参加", completed: "已发生", cancelled: "已取消" };
const FIELD_LABELS: Record<string, string> = { item_type: "记录类型", status: "任务状态", event_status: "活动状态", event_date: "活动日期", start_at: "开始时刻", location: "地点", planned_date: "计划日期", due_at: "截止时刻", fact_date: "事实发生日期", fact_at: "事实发生时刻", next_action: "下一步", project_id: "所属项目", attachment_ids: "关联原图", verification_state: "核实程度" };

const newDraft = (): IntakeDraft => ({ version: 1, sourceEventId: `image-source-${crypto.randomUUID()}`, recognitionRequestId: `image-recognition-${crypto.randomUUID()}`, recognitionModel: null, note: "", image: null, imageMeta: null, upload: null, fields: { ...EMPTY_INTAKE_FIELDS }, mode: "image", recognitionQuestions: [], recognitionQuestionHistory: [], resolvedRecognitionQuestions: [], recognized: null, preview: null, pending: null, conflict: false, imageError: "", savedAt: new Date().toISOString() });

function openDraftDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("spoken-projects:image-intake:v1", 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("drafts")) request.result.createObjectStore("drafts"); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开本机草稿空间"));
    request.onblocked = () => reject(new Error("本机草稿空间正被其他页面占用，请关闭旧页面后重试"));
  });
}

async function readDraft(scope: string): Promise<IntakeDraft | null> {
  const db = await openDraftDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("drafts", "readonly");
      const request = transaction.objectStore("drafts").get(scope);
      request.onsuccess = () => { const item = request.result as IntakeDraft | undefined; if (item === undefined) { resolve(null); return; } if (item?.version !== 1 || typeof item.sourceEventId !== "string" || typeof item.fields?.title !== "string" || (item.pending && typeof item.pending.operation_id !== "string")) { reject(new Error("本人图片草稿格式异常，请先核对原编号")); return; } resolve({ ...newDraft(), ...item, fields: { ...EMPTY_INTAKE_FIELDS, ...item.fields }, recognitionQuestionHistory: item.recognitionQuestionHistory || item.recognitionQuestions || [], resolvedRecognitionQuestions: item.resolvedRecognitionQuestions || [] }); };
      request.onerror = () => reject(request.error || new Error("本机草稿读取失败"));
    });
  } finally { db.close(); }
}

export async function hasPendingImageDraft(scope: string): Promise<boolean> { return !!(await readDraft(scope))?.pending; }

async function writeDraft(scope: string, draft: IntakeDraft): Promise<void> {
  const db = await openDraftDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("drafts", "readwrite");
      transaction.objectStore("drafts").put(draft, scope);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("本机草稿保存失败"));
      transaction.onabort = () => reject(transaction.error || new Error("本机草稿保存未完成"));
    });
  } finally { db.close(); }
}

class IntakeError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}

async function requestJSON<T>(url: string, scope: string, body?: FormData | Record<string, unknown>, timeout = 60000): Promise<T> {
  if (!/^[a-f0-9]{64}$/.test(scope)) throw new IntakeError("请先核验当前账号",409,"ACCOUNT_CHANGED");
  const controller = new AbortController(), timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    const isForm = body instanceof FormData;
    const headers: Record<string, string> = { "X-Ledger-Account-Scope": scope };
    if (body && !isForm) headers["Content-Type"] = "application/json";
    const response = await fetch(url, { method: body ? "POST" : "GET", body: !body ? undefined : isForm ? body : JSON.stringify(body), credentials: "include", cache: "no-store", headers, signal: controller.signal });
    const result: unknown = await response.json().catch(() => ({}));
    const detail = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
    if (!response.ok && detail.error === "ACCOUNT_CHANGED") window.dispatchEvent(new Event("ledger:account-changed"));
    if (!response.ok) throw new IntakeError(String(detail.message || detail.error || "请求暂未完成"), response.status, String(detail.error || "REQUEST"));
    return result as T;
  } finally { window.clearTimeout(timer); }
}

async function sha256Hex(value: ArrayBuffer | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map(part => part.toString(16).padStart(2, "0"))
    .join("");
}

async function createImageMeta(scope: string, image: LocalImage): Promise<IntakeImage> {
  const bytes = await image.blob.arrayBuffer();
  const sha256 = await sha256Hex(bytes);
  const id = await sha256Hex(`${scope}:${sha256}`);
  return {
    id: `img_${id}`,
    sha256,
    mime_type: image.type,
    byte_size: image.size,
    uploaded_at: new Date().toISOString(),
  };
}

async function uploadImage(scope: string, image: LocalImage, imageMeta: IntakeImage): Promise<StoredUpload> {
  const target = await requestJSON<{ uploadURL: string; objectPath: string }>(
    "/api/storage/uploads/request-url",
    scope,
    { name: image.name, size: image.size, contentType: image.type },
  );
  if (!target.uploadURL.startsWith("https://") || !target.objectPath.startsWith("/objects/")) {
    throw new IntakeError("私有图片上传地址无效", 502, "UPLOAD_URL");
  }
  const response = await fetch(target.uploadURL, {
    method: "PUT",
    headers: { "Content-Type": image.type },
    body: new Blob([image.blob], { type: image.type }),
    credentials: "omit",
  });
  if (!response.ok) throw new IntakeError(`私有图片上传未完成（${response.status}）`, response.status, "UPLOAD_FAILED");
  return {
    objectPath: target.objectPath,
    image: { ...imageMeta, uploaded_at: new Date().toISOString() },
  };
}

function withImage(form: FormData, image: LocalImage | null) {
  if (image) form.append("image", new File([image.blob], image.name, { type: image.type, lastModified: image.lastModified }));
  return form;
}

function displayChange(key: string, value: unknown, projects: { id: string; name: string }[]) {
  if (key === "attachment_ids" && Array.isArray(value)) return value.length ? `将关联 ${value.length} 张本人私有原图` : "无";
  if (key === "status" && typeof value === "string" && value in STATUS) return STATUS[value as keyof typeof STATUS];
  if (key === "event_status" && typeof value === "string" && value in EVENTS) return EVENTS[value as keyof typeof EVENTS];
  if (key === "item_type") return value === "event" ? "活动" : value === "reference" ? "参考资料" : "任务";
  if (key === "project_id") return projects.find(project => project.id === value)?.name || "项目待核";
  if (key === "verification_state") return value === "confirmed" ? "已核实" : value === "unverified" ? "待核实" : "用户陈述";
  return Array.isArray(value) ? value.join("、") || "无" : value === null || value === "" ? "未提供" : String(value);
}

export default function ImageIntake({ accountScope, projects, tasks, revision, disabled, onSaved, onPendingChange, onOpenTask }: ImageIntakeProps) {
  const [draft, setDraft] = useState<IntakeDraft>(newDraft);
  const [capabilities, setCapabilities] = useState<IntakeCapabilities | null>(null);
  const [scope, setScope] = useState<string | null>(null);
  const [ready, setReady] = useState(false), [capabilityLoading, setCapabilityLoading] = useState(true), [capabilityAttempt, setCapabilityAttempt] = useState(0);
  const [imageURL, setImageURL] = useState("");
  const [storageState, setStorageState] = useState<"saving" | "saved" | "error">("saving"), [storageError, setStorageError] = useState("");
  const [recognition, setRecognition] = useState<Phase>("idle"), [previewPhase, setPreviewPhase] = useState<Phase>("idle"), [savePhase, setSavePhase] = useState<"idle" | "saving" | "verifying" | "pending" | "verified">("idle");
  const [consent, setConsent] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null), accessEpoch = useRef(0);
  const persistenceQueue = useRef<Promise<void>>(Promise.resolve());
  const busy = recognition === "running" || previewPhase === "running" || savePhase === "saving" || savePhase === "verifying";
  const locked = disabled || !ready || !scope || busy || !!draft.pending;
  const visionAvailable = !!capabilities?.vision.configured && !!capabilities.vision.enabled;
  useEffect(() => { if (ready) onPendingChange(!!draft.pending, accountScope); }, [ready, draft.pending, accountScope, onPendingChange]);

  function lockAccount() {
    accessEpoch.current++; setScope(null); setCapabilities(null); setReady(false); setDraft(newDraft()); setConsent(false);
    setError("当前身份无法读取图片草稿。请从本人工作空间重新连接；没有读取其他账号的本机草稿。");
  }

  function reportError(cause: unknown, fallback: string) {
    if (cause instanceof IntakeError && (cause.status === 401 || cause.status === 403 || cause.code === "ACCOUNT_CHANGED")) { lockAccount(); return; }
    setError(cause instanceof Error && cause.name !== "AbortError" ? `${fallback}：${cause.message}` : `${fallback}：连接超时或中断。图片、文字与原编号仍保留。`);
  }

  useEffect(() => {
    let cancelled = false;
    const epoch = ++accessEpoch.current;
    setCapabilityLoading(true); setReady(false); setConsent(false);
    void (async () => {
      try {
        const next = await requestJSON<IntakeCapabilities>("/api/intake/capabilities",accountScope);
        if (cancelled || epoch !== accessEpoch.current) return;
        if (!next.draft_scope || next.draft_scope !== accountScope) throw new Error("尚未取得本人草稿空间，未读取本机图片");
        setCapabilities(next); setScope(next.draft_scope);
        await persistenceQueue.current.catch(() => {});
        const restored = await readDraft(next.draft_scope);
        if (cancelled || epoch !== accessEpoch.current) return;
        setDraft(restored || newDraft()); setReady(true); setStorageState("saved"); setStorageError("");
        if (restored?.pending) { setSavePhase("pending"); setMessage("已恢复上次未核验提交。请先按原编号查询保存结果，不要重新新增。"); }
        else if (restored && (restored.image || restored.note || restored.fields.title)) setMessage("已恢复本人本机草稿；图片尚未因此成为正式记录。");
      } catch (cause) {
        if (cancelled || epoch !== accessEpoch.current) return;
        if (cause instanceof IntakeError && (cause.status === 401 || cause.status === 403)) lockAccount();
        else { setError(cause instanceof Error ? cause.message : "图片能力与本机草稿暂时不可读取"); setStorageState("error"); setStorageError("草稿恢复尚未完成，请重新连接后再填写。"); }
      } finally { if (!cancelled) setCapabilityLoading(false); }
    })();
    return () => { cancelled = true; if (epoch === accessEpoch.current) accessEpoch.current++; };
  }, [accountScope, capabilityAttempt]);

  useEffect(() => {
    if (!draft.image) { setImageURL(""); return; }
    const url = URL.createObjectURL(draft.image.blob); setImageURL(url);
    return () => URL.revokeObjectURL(url);
  }, [draft.image]);

  useEffect(() => {
    if (!scope || !ready) return;
    const currentScope = scope, epoch = accessEpoch.current;
    setStorageState("saving");
    persistenceQueue.current = persistenceQueue.current.catch(() => {}).then(() => writeDraft(currentScope, draft));
    void persistenceQueue.current.then(() => { if (epoch === accessEpoch.current) { setStorageState("saved"); setStorageError(""); } }).catch(() => { if (epoch === accessEpoch.current) { setStorageState("error"); setStorageError("本机草稿尚未保存到浏览器空间。当前页面内容仍在，请腾出空间后重试，暂不提交正式记录。"); } });
  }, [draft, scope, ready]);

  async function persistNow(next: IntakeDraft) {
    if (!scope || !ready) throw new Error("本人草稿空间尚未准备好");
    setStorageState("saving");
    persistenceQueue.current = persistenceQueue.current.catch(() => {}).then(() => writeDraft(scope, next));
    try { await persistenceQueue.current; setStorageState("saved"); setStorageError(""); }
    catch { setStorageState("error"); setStorageError("本机恢复信息写入失败，未发起新的正式提交。图片和说明仍留在当前页面。"); throw new Error("请先恢复本机草稿保存能力"); }
  }

  function editDraft(patch: Partial<IntakeDraft>) {
    if (locked) return;
    setDraft(current => ({ ...current, ...patch, preview: null, savedAt: new Date().toISOString() }));
    setPreviewPhase("idle"); setError(""); setMessage("");
  }

  function editField<K extends keyof IntakeFields>(key: K, value: IntakeFields[K]) {
    editDraft({ fields: { ...draft.fields, [key]: value, ...(key === "uncertainties_confirmed" ? {} : { uncertainties_confirmed: false }) } });
  }

  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file || locked) return;
    const maximum = Math.min(MAX_BYTES, capabilities?.max_image_bytes || MAX_BYTES);
    const allowed = capabilities?.allowed_types || IMAGE_TYPES;
    if (!IMAGE_TYPES.includes(file.type) || !allowed.includes(file.type)) { setDraft(current => ({ ...current, imageError: "仅支持 PNG、JPEG、WEBP 图片，原有图片和说明仍保留。" })); return; }
    if (!file.size || file.size > maximum) { setDraft(current => ({ ...current, imageError: `图片需为 1 至 ${maximum.toLocaleString("zh-CN")} 字节。请另选图片，原有说明仍保留。` })); return; }
    setConsent(false); setRecognition("idle");
    editDraft({ image: { blob: file, name: file.name, type: file.type, size: file.size, lastModified: file.lastModified }, imageMeta: null, upload: null, preview: null, recognitionRequestId: `image-recognition-${crypto.randomUUID()}`, recognitionModel: null, recognized: null, recognitionQuestions: [], recognitionQuestionHistory: [], resolvedRecognitionQuestions: [], imageError: "" });
  }

  async function recognize() {
    if (locked || !visionAvailable || !consent || !draft.image) return;
    const epoch = accessEpoch.current;
    setRecognition("running"); setError(""); setMessage("正在发送原图与补充说明以识别候选字段，尚未保存事项。");
    try {
      await persistNow(draft);
      const form = withImage(new FormData(), draft.image); form.set("note", draft.note); form.set("request_id", draft.recognitionRequestId); form.set("consent", "true");
      const result = await requestJSON<RecognitionResult>("/api/intake/recognize", accountScope, form);
      if (epoch !== accessEpoch.current) return;
      setDraft(current => ({ ...current, fields: result.fields, mode: "manual", recognized: { provider: result.provider, model: result.model }, recognitionQuestions: result.questions || [], recognitionQuestionHistory: result.questions || [], resolvedRecognitionQuestions: [], preview: null, savedAt: new Date().toISOString() }));
      setRecognition("done"); setMessage("已取得识别候选，尚未保存。请逐项修订字段，再生成核对预览。");
    } catch (cause) { if (epoch === accessEpoch.current) { setRecognition("error"); reportError(cause, "图片识别未完成，草稿仍保留"); } }
    finally { setConsent(false); }
  }

  async function preparePreview() {
    if (locked) return;
    const epoch = accessEpoch.current;
    setPreviewPhase("running"); setError(""); setMessage("正在核对字段、已有事项与图片，尚未正式保存。");
    try {
      const imageMeta = draft.image ? draft.imageMeta || await createImageMeta(accountScope, draft.image) : null;
      const currentDraft = { ...draft, imageMeta };
      await persistNow(currentDraft);
      const result = await requestJSON<IntakePreview>("/api/intake/preview", accountScope, {
        draft_json: JSON.stringify({ fields: draft.fields, note: draft.note, questions: draft.recognitionQuestions, source_event_id: draft.sourceEventId }),
        image_meta_json: imageMeta ? JSON.stringify(imageMeta) : "",
      });
      if (epoch !== accessEpoch.current) return;
      setDraft(current => ({ ...current, imageMeta, fields: result.fields, preview: result, savedAt: new Date().toISOString() }));
      setPreviewPhase("done"); setMessage(result.changes.length ? "核对预览已生成；确认后才会正式保存。" : "本次只预览，没有可直接保存的变更。");
    } catch (cause) { if (epoch === accessEpoch.current) { setPreviewPhase("error"); reportError(cause, "核对预览未完成，图片和字段仍保留"); } }
  }

  async function finishVerification(operationId: string) {
    const epoch = accessEpoch.current;
    const verified = await onSaved(operationId);
    if (epoch !== accessEpoch.current) return false;
    if (verified) {
      const clean = newDraft(); await persistNow(clean); setDraft(clean); setSavePhase("verified"); setRecognition("idle"); setPreviewPhase("idle"); setConsent(false); setError(""); setMessage("图片与事项已保存，并已独立读回验证。");
      return true;
    }
    setSavePhase("pending"); setMessage("本次保存仍待独立核验。图片、原请求和编号均保留，请查询保存结果。"); return false;
  }

  async function commit(existing?: Submit) {
    if (disabled || !ready || busy || !scope) return;
    if (!existing && (!draft.preview || !draft.preview.changes.length || revision > draft.preview.base_version)) return;
    const epoch = accessEpoch.current;
    const payload: Submit = existing || { operation_id: `image-op-${crypto.randomUUID()}`, idempotency_key: `image-key-${crypto.randomUUID()}`, source_event_id: draft.preview!.source_event_id, base_version: draft.preview!.base_version, occurred_at: draft.preview!.occurred_at, raw_text: draft.note || `图片与事项核对：${draft.fields.title}`, changes: draft.preview!.changes, confirmed: true };
    onPendingChange(true, accountScope); setSavePhase("saving"); setError(""); setMessage("正在提交图片和事项；尚未确认保存成功。");
    try {
      const imageMeta = draft.image ? draft.imageMeta || await createImageMeta(accountScope, draft.image) : null;
      const upload = draft.image && imageMeta
        ? draft.upload || await uploadImage(accountScope, draft.image, imageMeta)
        : null;
      if (epoch !== accessEpoch.current) return;
      const pending = { ...draft, imageMeta, upload, pending: payload, conflict: false, savedAt: new Date().toISOString() };
      await persistNow(pending); setDraft(pending);
      const response = await requestJSON<{ operation_id: string }>("/api/intake/commit", accountScope, {
        payload_json: JSON.stringify(payload),
        upload_json: JSON.stringify(upload),
      });
      if (response.operation_id !== payload.operation_id) throw new Error("回执编号与原请求不同，请继续按原编号核对，未清理草稿");
      if (epoch !== accessEpoch.current) return;
      setSavePhase("verifying"); await finishVerification(payload.operation_id);
    } catch (cause) {
      if (epoch !== accessEpoch.current) return;
      setSavePhase("pending");
      if (!draft.pending) onPendingChange(false, accountScope);
      const needsCorrection = cause instanceof IntakeError && [400, 409, 413, 415].includes(cause.status);
      if (needsCorrection) setDraft(current => ({ ...current, pending: payload, conflict: true }));
      reportError(cause, needsCorrection ? "保存需要重新核对，请保留草稿并先查询原请求" : "本次提交尚未核验，不能认为保存成功");
    }
  }

  async function queryPending() {
    if (!draft.pending || busy || disabled) return;
    setSavePhase("verifying"); setError("");
    try { await finishVerification(draft.pending.operation_id); }
    catch (cause) { setSavePhase("pending"); reportError(cause, "保存结果仍未核验，原编号继续保留"); }
  }

  async function repreviewAfterConflict() {
    if (!draft.pending || !draft.conflict || busy || disabled) return;
    const epoch = accessEpoch.current;
    setSavePhase("verifying"); setError("");
    try { await requestJSON(`/api/operations/${encodeURIComponent(draft.pending.operation_id)}`,accountScope); if (epoch === accessEpoch.current) await finishVerification(draft.pending.operation_id); }
    catch (cause) {
      if (epoch !== accessEpoch.current) return;
      if (cause instanceof IntakeError && cause.status === 404) { setDraft(current => ({ ...current, pending: null, preview: null, conflict: false })); setSavePhase("idle"); setMessage("已核对原编号尚未保存。草稿和图片保留，请读取最新状态后重新生成预览；不会自动新增。"); }
      else { setSavePhase("pending"); reportError(cause, "尚不能确认原请求未保存，请继续按原编号核对"); }
    }
  }

  const fields = draft.fields;
  const fact = fields.classification === "task_progress" || fields.classification === "completion_evidence";
  const reference = fields.item_type === "reference" || fields.classification === "reference";
  const dateLabel = fields.item_type === "event" ? "活动日期（未知可留空）" : fact ? "事实发生日期（未知可留空）" : reference ? "资料所载日期（可留空）" : "计划日期（可留空）";
  const timeLabel = fields.item_type === "event" ? "开始时间（北京时间，可留空）" : fact ? "事实发生时间（北京时间，可留空）" : reference ? "资料所载时刻（可留空）" : "时刻待核（不会自动设为截止）";
  const stalePreview = !!draft.preview && revision > draft.preview.base_version;
  const preview = draft.preview;

  return <section className="image-intake" aria-label="图片与事项" aria-busy={busy || capabilityLoading}>
    <div className="intake-heading"><div><h3><ImagePlus size={20} aria-hidden="true" />图片与事项</h3><p>选图或手动填写，先核对已有记录，再决定保存。</p></div><span className="intake-local-tag">本人本机草稿</span></div>
    {capabilityLoading && <p className="intake-info" role="status">正在核对本人身份与草稿空间…</p>}
    {!ready && !capabilityLoading && <button type="button" className="intake-button" onClick={() => setCapabilityAttempt(value => value + 1)}><RefreshCw size={16} />重新连接图片草稿</button>}
    {error && <div className="intake-alert" role="alert"><CircleAlert size={18} aria-hidden="true" /><p>{error}</p></div>}
    {message && <p className="intake-message" role="status">{message}</p>}
    {storageError && <div className="intake-alert" role="alert"><p>{storageError}</p>{ready && <button type="button" className="intake-link" disabled={busy} onClick={() => { void persistNow(draft).catch(() => {}); }}>重试保存本机草稿</button>}</div>}
    {ready && <>
      <div className="intake-source-tools"><input ref={fileInput} className="intake-file-input" type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择事项图片" onChange={selectFile} disabled={locked} /><button type="button" className="intake-button" onClick={() => fileInput.current?.click()} disabled={locked}><FileImage size={18} aria-hidden="true" />{draft.image ? "更换图片" : "选择图片"}</button><button type="button" className="intake-button" aria-pressed={draft.mode === "manual"} disabled={locked} onClick={() => editDraft({ mode: "manual" })}>手动填写</button><span>PNG / JPEG / WEBP，最多 1,500,000 字节</span></div>
      {draft.imageError && <p className="intake-file-error" role="alert">{draft.imageError}</p>}
      {draft.image && <div className="intake-image-card">{imageURL && <img src={imageURL} alt={`本机待核对图片：${draft.image.name}`} />}<div><strong>{draft.image.name}</strong><span>{draft.image.size.toLocaleString("zh-CN")} 字节 · 原图未压缩</span><p>当前仅保存在本机草稿；确认保存时会上传到你的私有存储。</p><button type="button" className="intake-link" disabled={locked} onClick={() => { setConsent(false); editDraft({ image: null, imageMeta: null, upload: null, preview: null, recognitionRequestId: `image-recognition-${crypto.randomUUID()}`, recognitionModel: null, recognized: null, recognitionQuestions: [], imageError: "" }); }}>移除图片</button></div></div>}
      <label className="intake-label">补充说明<textarea aria-label="图片补充说明" rows={3} value={draft.note} maxLength={2000} disabled={locked} onChange={event => { setConsent(false); editDraft({ note: event.target.value, recognitionRequestId: `image-recognition-${crypto.randomUUID()}`, recognitionModel: null }); }} placeholder="写下这张图和已有事项的关系；未知时间、地点可以留空。" /></label>
      <div className="intake-vision-box"><strong>当前为手动核对模式</strong><p>当前部署未连接自动识图服务，图片不会发送给 AI。你可以手动填写字段并预览；确认保存时，原图会直接上传到你的私有存储。</p></div>
      {visionAvailable && <div className="intake-vision-box"><strong>可选独立 API 图片识别</strong>{visionAvailable ? <><p>本次识别会将原图和补充说明发送给 {capabilities!.vision.provider}（{capabilities!.vision.model}），按 token 计费；每天最多 {capabilities!.vision.max_daily_requests} 次。</p><p>{capabilities!.vision.pricing_text}</p><p>{capabilities!.vision.retention_text}</p><label className="intake-check"><input type="checkbox" checked={consent} disabled={locked || !draft.image} onChange={event => setConsent(event.target.checked)} /><span>我同意本次发送原图与补充说明给 OpenAI，并按 token 计费。</span></label></> : <p>{capabilities?.vision.configured ? "图片识别尚未启用。可以手动填写并核对，不会调用视觉服务。" : "尚未配置图片识别。可以选图保留草稿并手动填写；当前没有识别图片内容。"}</p>}<button type="button" className="intake-button" disabled={locked || !visionAvailable || !consent || !draft.image} onClick={() => { void recognize(); }}>{recognition === "running" ? <LoaderCircle className="spin" size={17} /> : <ImagePlus size={17} />}识别预览{visionAvailable ? "（可能收费）" : ""}</button>{visionAvailable && draft.image && (draft.recognized || recognition === "error") && <button type="button" className="intake-link" disabled={locked} onClick={() => { setConsent(false); editDraft({ recognitionRequestId: `image-recognition-${crypto.randomUUID()}`, recognitionModel: null }); setMessage("已准备一次新的识别。再次勾选费用同意后才发送，可能再次计费；原图片与字段仍保留。"); }}>准备重新识别（可能再次收费）</button>}</div>}

      {draft.mode === "manual" && <div className="intake-fields" aria-label="可编辑事项字段"><div className="intake-subheading"><h4>{draft.recognized ? "修订识别候选" : "手动核对事项"}</h4><span>尚未保存</span></div>
        <label className="intake-label">事项标题<input aria-label="事项标题" value={fields.title} maxLength={300} disabled={locked} onChange={event => editField("title", event.target.value)} /></label>
        <div className="intake-two-columns"><label className="intake-label">内容分类<select aria-label="内容分类" value={fields.classification} disabled={locked} onChange={event => editField("classification", event.target.value as IntakeFields["classification"])}>{Object.entries(CLASSIFICATION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="intake-label">记录类型<select aria-label="记录类型" value={fields.item_type} disabled={locked} onChange={event => editField("item_type", event.target.value as IntakeFields["item_type"])}><option value="task">要推进的任务</option><option value="event">按时参加的活动</option><option value="reference">仅作参考资料</option></select></label></div>
        <div className="intake-two-columns"><label className="intake-label">所属项目<select aria-label="事项所属项目" value={fields.project_id} disabled={locked} onChange={event => editField("project_id", event.target.value)}><option value="">请选择项目</option>{projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>{fields.item_type === "event" ? <label className="intake-label">活动状态<select aria-label="活动状态" value={fields.event_status} disabled={locked} onChange={event => editField("event_status", event.target.value as IntakeFields["event_status"])}>{Object.entries(EVENTS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label> : <label className="intake-label">任务状态<select aria-label="事项任务状态" value={fields.status} disabled={locked || fields.item_type === "reference"} onChange={event => editField("status", event.target.value as IntakeFields["status"])}>{Object.entries(STATUS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>}</div>
        <div className="intake-two-columns"><label className="intake-label">{dateLabel}<input aria-label={dateLabel} type="date" value={fields.date} disabled={locked} onChange={event => editField("date", event.target.value)} /></label>{(fields.item_type === "event" || fact || reference || fields.time) && <label className="intake-label">{timeLabel}<input aria-label={timeLabel} type="time" value={fields.time} disabled={locked} onChange={event => editField("time", event.target.value)} /></label>}</div>
        <label className="intake-label">地点（可留空）<input aria-label="事项地点" value={fields.location} maxLength={500} disabled={locked} onChange={event => editField("location", event.target.value)} /></label><label className="intake-label">下一步<textarea aria-label="事项下一步" rows={2} value={fields.next_action} maxLength={1000} disabled={locked} onChange={event => editField("next_action", event.target.value)} /></label>
        <div className="intake-two-columns"><label className="intake-label">本次操作<select aria-label="本次事项操作" value={fields.action} disabled={locked} onChange={event => editField("action", event.target.value as IntakeFields["action"])}><option value="inspect">仅预览，不保存</option><option value="create">明确新建事项</option><option value="update">更新选中的已有事项</option><option value="link_existing">关联到已有事项</option></select></label><label className="intake-label">目标已有事项<select aria-label="目标已有事项" value={fields.target_task_id} disabled={locked} onChange={event => editField("target_task_id", event.target.value)}><option value="">未选择</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label></div>
        {draft.recognitionQuestions.length > 0 && <div className="intake-questions"><strong>识别时仍待核对</strong><p>修改字段不会自动清除问题。请修订并逐条核对，确认后再移除对应问题。</p><ul>{draft.recognitionQuestions.map((question, index) => <li key={`${index}-${question}`}><span>{question}</span><button type="button" className="intake-link" disabled={locked} onClick={() => editDraft({ recognitionQuestions: draft.recognitionQuestions.filter((_, position) => position !== index), resolvedRecognitionQuestions: [...draft.resolvedRecognitionQuestions, question], fields: { ...fields, uncertainties_confirmed: false } })}>已核对并修正此问题</button></li>)}</ul></div>}
        {draft.resolvedRecognitionQuestions.length > 0 && <details className="intake-resolved-questions"><summary>已逐条核对的问题（{draft.resolvedRecognitionQuestions.length}）</summary><ul>{draft.resolvedRecognitionQuestions.map((question, index) => <li key={index}>{question}</li>)}</ul></details>}
        <label className="intake-check"><input type="checkbox" checked={fields.uncertainties_confirmed} disabled={locked} onChange={event => editField("uncertainties_confirmed", event.target.checked)} /><span>我已逐项核对；未提供的字段明确保留未知，不推测日期、时间或地点。此项不代表现实事实已经验真。</span></label>
        <div className="intake-preview-actions"><p>生成核对预览不使用付费视觉服务；图片此时仍不是正式附件。</p><button type="button" className="intake-button intake-primary" disabled={locked || !fields.title.trim()} onClick={() => { void preparePreview(); }}>{previewPhase === "running" ? <LoaderCircle size={17} className="spin" /> : <ShieldCheck size={17} />}生成核对预览</button></div>
      </div>}

      {preview && <section className="intake-preview" aria-label="图片事项核对预览"><div className="intake-subheading"><h4>核对本次图片与事项</h4><span>基于版本 v{preview.base_version}</span></div><p>{preview.summary}</p>{preview.image && <div className="intake-upload-record"><p>图片已参与预览核对，尚未正式保存：{preview.image.byte_size.toLocaleString("zh-CN")} 字节</p><dl><dt>本次图片校验时间（非活动时间）</dt><dd><time dateTime={preview.image.uploaded_at}>{Number.isFinite(Date.parse(preview.image.uploaded_at)) ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(preview.image.uploaded_at)) : "时间待核"}</time> · Asia/Shanghai</dd></dl></div>}{preview.candidates.length > 0 && <div className="intake-candidates"><strong>{preview.duplicate ? "发现已有事项，本次默认仅查看" : "可能相关的已有事项"}</strong>{preview.candidates.map(candidate => <div key={candidate.id}><span><strong>{candidate.title}</strong><small>{candidate.reason}</small></span><div><button type="button" className="intake-link" onClick={() => onOpenTask(candidate.id)}>查看已有事项<ChevronRight size={15} /></button><button type="button" className="intake-button" disabled={locked} onClick={() => editDraft({ fields: { ...fields, action: "link_existing", target_task_id: candidate.id, item_type: candidate.item_type, uncertainties_confirmed: false }, mode: "manual" })}>关联到已有事项</button></div></div>)}</div>}{preview.questions.length > 0 && <div className="intake-questions"><strong>保存前还需核对</strong><ul>{preview.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></div>}<div className="intake-changes">{preview.changes.length ? preview.changes.map((change, index) => <div key={index}><span>{change.type === "create" ? "新建事项" : change.type === "update" ? "更新已有事项" : "记录待确认内容"}</span><strong>{String(change.values.title || tasks.find(task => task.id === change.id)?.title || change.id || fields.title)}</strong><dl>{Object.entries(change.values).filter(([key]) => !["title", "source_ref"].includes(key)).map(([key, value]) => <div key={key}><dt>{FIELD_LABELS[key] || key}</dt><dd>{displayChange(key, value, projects)}</dd></div>)}</dl></div>) : <p>没有可直接保存的变更。可查看已有事项，或修订字段后重新预览。</p>}</div>{stalePreview && <p className="intake-file-error" role="alert">正式版本已变化，请重新生成预览后保存。</p>}<button type="button" className="intake-button intake-primary" disabled={locked || !preview.changes.length || stalePreview || storageState === "error"} onClick={() => { void commit(); }}><Check size={17} />确认保存图片与事项</button></section>}

      {draft.pending && <div className="intake-pending" role="status"><strong>本次提交仍待核验</strong><p>原操作编号 <code>{draft.pending.operation_id}</code></p><p>保留图片和原请求，不会换一个编号重复新增。</p><div><button type="button" className="intake-button intake-primary" disabled={busy || disabled} onClick={() => { void queryPending(); }}>查询保存结果</button><button type="button" className="intake-button" disabled={busy || disabled} onClick={() => { void commit(draft.pending!); }}>重试原请求（同一编号）</button>{draft.conflict && <button type="button" className="intake-button" disabled={busy || disabled} onClick={() => { void repreviewAfterConflict(); }}>核对原请求后重新编辑</button>}</div></div>}
      <div className="intake-stage-summary" aria-label="图片事项处理状态"><span>图片：{!draft.image ? "未选择" : busy ? "处理中，未确认保存" : "本机草稿已选图"}</span><span>识别：{recognition === "running" ? "进行中" : draft.recognized ? "候选已返回，需核对" : "尚未识别，可手动填写"}</span><span>保存：{savePhase === "verified" ? "已读回验证" : draft.pending ? "待核验" : "未保存"}</span></div>
      <div className="intake-draft-footer"><span>{storageState === "saving" ? "正在保存本人本机草稿…" : storageState === "error" ? "本机草稿尚未落盘" : "本人本机草稿已保存"}</span>{!draft.pending && <button type="button" className="intake-link" disabled={locked} onClick={() => { setDraft(newDraft()); setRecognition("idle"); setPreviewPhase("idle"); setConsent(false); setError(""); setMessage("已清空这份本机录入草稿，未改正式记录。"); }}><X size={14} />清空本机草稿</button>}</div><p className="intake-storage-note">{capabilities?.storage_text || "图片和字段先保留在本人浏览器草稿；只有确认提交并独立读回后才视为正式保存。"}</p>
    </>}
  </section>;
}
