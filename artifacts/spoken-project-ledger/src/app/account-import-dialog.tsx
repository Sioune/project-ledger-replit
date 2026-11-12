import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, FileUp, LoaderCircle, LockKeyhole, ShieldCheck, X } from "lucide-react";

type Preview = {
  stage_id?: string;
  digest: string;
  counts: Record<string, number>;
  total_rows: number;
  attachment_count: number;
  attachment_bytes: number;
  attachments: Array<{ id: string; sha256: string; mime_type: string; byte_size: number; file_name: string | null }>;
  library_file_count: number;
  library_file_bytes: number;
  library_files: Array<{
    library_id: string;
    file_id: string;
    version: string | number;
    library_ref: string;
    version_id: string | null;
    file_name: string;
    mime_type: string;
    byte_size: number;
    sha256: string;
  }>;
  file_validation: {
    current_references: { total: number; covered: number };
    history_references: { total: number; covered: number };
    missing_references: Array<{ library_ref: string; version_id: string | null; document_id?: string; origin?: "current" | "history" }>;
    ambiguous_references: Array<{ library_ref: string; version_id: string | null; document_id?: string; origin?: "current" | "history" }>;
    missing_image_references: string[];
    missing_files: Array<{ file_name: string; library_ref?: string; version_id?: string }>;
    extra_uploads: string[];
    unreferenced_files: Array<{ file_name: string; library_ref: string; version_id: string | null }>;
    size_errors: Array<{ file_name: string; expected: number; actual: number }>;
    hash_errors: Array<{ file_name: string; expected: string; actual: string }>;
    type_errors: Array<{ file_name: string; mime_type: string }>;
    mapping_errors: string[];
    can_import: boolean;
  };
  source_account_masked: string;
  source_account_name?: string;
  target_binding: string;
  captured_at: string;
  snapshot_bytes: number;
  conflicts: string[];
  expires_in_seconds: number;
  data_preview?: {
    projects: string[];
    tasks: Array<{ title: string; status: string }>;
    recent_operations: Array<{ operation_id: string; created_at: string; state: string }>;
    truncated: boolean;
  };
};

type Props = {
  scope: string;
  accountLabel: string;
  onClose: () => void;
  onImported: (result: { import_id: string; counts: Record<string, number> }) => Promise<void>;
};

const TABLE_LABELS: Record<string, string> = {
  accounts: "账号",
  ledgers: "账本",
  operations: "操作历史",
  images: "图片原图",
  image_recognitions: "图片识别记录",
};

function errorMessage(payload: Record<string, unknown>, status: number) {
  return typeof payload.message === "string" ? payload.message : `请求未完成（${status}）`;
}

export default function AccountImportDialog({ scope, accountLabel, onClose, onImported }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<string | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<File>();
  const [manifest, setManifest] = useState<File>();
  const [attachments, setAttachments] = useState<File[]>([]);
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialogRef.current;
    element?.showModal();
    return () => {
      element?.close();
      const stageId = stageRef.current;
      if (stageId) {
        void fetch("/api/account-import/cancel", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-Ledger-Account-Scope": scope },
          body: JSON.stringify({ stage_id: stageId }),
          keepalive: true,
        }).catch(() => undefined);
      }
    };
  }, [scope]);

  function invalidatePreview() {
    const stageId = stageRef.current;
    stageRef.current = undefined;
    if (stageId) {
      void fetch("/api/account-import/cancel", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Ledger-Account-Scope": scope },
        body: JSON.stringify({ stage_id: stageId }),
      }).catch(() => undefined);
    }
    setPreview(undefined);
    setConfirmed(false);
    setError("");
  }

  async function previewBackup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot) {
      setError("请选择完整账号快照 JSON。");
      return;
    }
    setBusy("preview");
    setError("");
    invalidatePreview();
    const form = new FormData();
    form.append("snapshot", snapshot, snapshot.name);
    if (manifest) form.append("manifest", manifest, manifest.name);
    for (const file of attachments) form.append("attachments", file, file.name);
    try {
      const response = await fetch("/api/account-import/preview", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "X-Ledger-Account-Scope": scope },
        body: form,
      });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(errorMessage(payload, response.status));
      const parsed = payload as unknown as Preview;
      setPreview(parsed);
      stageRef.current = parsed.stage_id;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "无法核验这份备份。");
    } finally {
      setBusy(null);
    }
  }

  async function commitBackup() {
    if (!preview?.stage_id || !confirmed || preview.conflicts.length) return;
    setBusy("commit");
    setError("");
    try {
      const response = await fetch("/api/account-import/commit", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "X-Ledger-Account-Scope": scope },
        body: JSON.stringify({ stage_id: preview.stage_id, digest: preview.digest, confirm: true }),
      });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(errorMessage(payload, response.status));
      if (payload.verified !== true || typeof payload.import_id !== "string" || !payload.counts) throw new Error("服务端未返回完整核验回执，请重新读取账号状态。");
      stageRef.current = undefined;
      await onImported({ import_id: payload.import_id, counts: payload.counts as Record<string, number> });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "迁入未完成，请勿重复选择不同版本。");
      setBusy(null);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-label="迁入本人完整账号备份"
      className="modal modal-wide"
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
    >
      <div className="modal-inner">
        <div className="modal-head">
          <div>
            <h2>迁入本人完整账号备份</h2>
            <p>先在内存中核验并预览；只有你确认后才写入账本、历史和本人私有附件。</p>
          </div>
          <button className="icon-button" onClick={onClose} disabled={!!busy} aria-label="关闭"><X /></button>
        </div>
        <div className="inline-note">
          <LockKeyhole size={16} />
          上传只供本次登录会话核验，预览最长保留 10 分钟；未确认不会写入业务记录。原文件不会进入 Git 或公开静态目录。
        </div>
        <form className="editor-form" onSubmit={(event) => { void previewBackup(event); }}>
          <label className="form-label">
            完整账号快照 JSON
            <input type="file" accept=".json,application/json" onChange={(event) => { setSnapshot(event.target.files?.[0]); invalidatePreview(); }} required />
            <small className="form-help">支持完整格式 d1-account-snapshot-v1；快照文件上限 40 MB，解码后的表格数据上限 12,000,000 字节。若来自完整 ZIP，请先解压。</small>
          </label>
          <label className="form-label">
            附件哈希清单 · 有 Library 文件时必选
            <input type="file" accept=".json,application/json" onChange={(event) => { setManifest(event.target.files?.[0]); invalidatePreview(); }} />
            <small className="form-help">支持 project-ledger-complete-file-manifest-v1；也兼容旧图片清单。</small>
          </label>
          <label className="form-label">
            随附原文件 · 可选
            <input type="file" accept=".docx,.pdf,.html,.htm,.md,.markdown,.txt,.jpg,.jpeg,.png,.webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/html,text/markdown,text/plain,image/jpeg,image/png,image/webp" multiple onChange={(event) => { setAttachments(Array.from(event.target.files ?? [])); invalidatePreview(); }} />
            <small className="form-help">支持 DOCX、PDF、HTML、Markdown、TXT、JPEG、PNG、WebP。每个附件都须与清单的原标识、版本、文件名、大小及 SHA-256 对应。</small>
          </label>
          <div className="inline-note"><FileUp size={15} />总接收上限 128 MB，单个文件 64 MB。HTML 等主动内容只会以附件下载，不会在本站执行。</div>
          <div className="form-actions">
            <span>目标账号：{accountLabel}</span>
            <button className="button button-primary" type="submit" disabled={!!busy || !snapshot}>
              {busy === "preview" ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}
              {busy === "preview" ? "正在核验" : "核验并预览"}
            </button>
          </div>
        </form>

        {error && <div className="notice notice-error" role="alert"><strong>迁移未完成</strong><p>{error}</p></div>}
        {preview && (
          <section className="preview-panel" aria-live="polite">
            <div className="section-title"><h3>备份与账号绑定预览</h3><span className="muted">摘要 {preview.digest.slice(0, 16)}…</span></div>
            <div className="restore-counts">
              {Object.entries(preview.counts).map(([key, count]) => <span key={key}><strong>{count}</strong>{TABLE_LABELS[key] || key}</span>)}
            </div>
            <div className="data-setting-row"><div><strong>来源账号</strong><p>{preview.source_account_masked}</p></div><span>来源编号仅作核对，不用于认证</span></div>
            {preview.source_account_name && <div className="data-setting-row"><div><strong>备份中的账号名称</strong><p>{preview.source_account_name}</p></div><span>导入后映射至当前账号</span></div>}
            <div className="data-setting-row"><div><strong>迁入目标</strong><p>{preview.target_binding}</p></div><span>{accountLabel}</span></div>
            <div className="data-setting-row"><div><strong>附件原图</strong><p>{preview.attachment_count} 张 · {(preview.attachment_bytes / 1024 / 1024).toFixed(2)} MB</p></div><span>{preview.attachments.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)) ? "SHA-256 已校验" : "哈希缺失"}</span></div>
            <div className="data-setting-row"><div><strong>Library 独立文件</strong><p>{preview.library_file_count} 个 · {(preview.library_file_bytes / 1024 / 1024).toFixed(2)} MB</p></div><span>按版本保留原引用</span></div>
            <div className="data-setting-row"><div><strong>当前文件引用</strong><p>{preview.file_validation.current_references.covered} / {preview.file_validation.current_references.total} 已覆盖</p></div><span>{preview.file_validation.history_references.covered} / {preview.file_validation.history_references.total} 条历史引用已覆盖</span></div>
            <div className="data-setting-row"><div><strong>快照生成时间</strong><p>{new Date(preview.captured_at).toLocaleString("zh-CN")}</p></div><span>{preview.total_rows} 条数据行</span></div>
            {preview.data_preview && <details className="source-details"><summary>预览项目、任务与最近回执</summary><div className="import-data-preview"><div><strong>项目</strong>{preview.data_preview.projects.length ? <ul>{preview.data_preview.projects.map((name, index) => <li key={`${name}-${index}`}>{name || "未命名项目"}</li>)}</ul> : <p>无项目记录</p>}</div><div><strong>任务</strong>{preview.data_preview.tasks.length ? <ul>{preview.data_preview.tasks.map((task, index) => <li key={`${task.title}-${index}`}>{task.title || "未命名任务"}{task.status && <small> · {task.status}</small>}</li>)}</ul> : <p>无任务记录</p>}</div><div><strong>最近操作回执</strong>{preview.data_preview.recent_operations.length ? <ul>{preview.data_preview.recent_operations.map((operation) => <li key={operation.operation_id}><code>{operation.operation_id}</code><small> · {new Date(operation.created_at).toLocaleString("zh-CN")} · {operation.state}</small></li>)}</ul> : <p>无操作历史</p>}</div>{preview.data_preview.truncated && <small>此处只显示部分条目，实际导入数量以表格计数为准。</small>}</div></details>}
            {!!preview.attachments.length && <details className="source-details"><summary>查看附件核验清单</summary><ul className="import-attachment-list">{preview.attachments.map((file) => <li key={file.id}><span>{file.file_name || file.id}</span><code>{file.sha256.slice(0, 16)}…</code><small>{file.byte_size} 字节 · {file.mime_type}</small></li>)}</ul></details>}
            <details className="source-details" open={!preview.file_validation.can_import}>
              <summary>Library 与历史文件核验</summary>
              {preview.file_validation.can_import && <p className="form-help">当前及历史引用均已匹配；所有上传文件的大小、哈希和类型通过校验。</p>}
              {!!preview.file_validation.missing_references.length && <div className="notice notice-error"><strong>缺少文件引用</strong><ul>{preview.file_validation.missing_references.map((ref, index) => <li key={`${ref.library_ref}-${ref.version_id ?? "no-ledger-version"}-${index}`}>{ref.origin === "history" ? "历史" : "当前"}：{ref.library_ref} · {ref.version_id ?? "裸引用（无账本版本）"}</li>)}</ul></div>}
              {!!preview.file_validation.ambiguous_references.length && <div className="notice notice-error"><strong>引用对应多个文件版本</strong><ul>{preview.file_validation.ambiguous_references.map((ref, index) => <li key={`${ref.library_ref}-${ref.version_id ?? "no-ledger-version"}-${index}`}>{ref.library_ref} · {ref.version_id ?? "裸引用（无账本版本）"}</li>)}</ul></div>}
              {!!preview.file_validation.missing_image_references.length && <div className="notice notice-error"><strong>缺少图片原件</strong><p>{preview.file_validation.missing_image_references.join("、")}</p></div>}
              {!!preview.file_validation.missing_files.length && <div className="notice notice-error"><strong>缺少随附文件</strong><ul>{preview.file_validation.missing_files.map((file, index) => <li key={`${file.file_name}-${index}`}>{file.file_name}</li>)}</ul></div>}
              {!!preview.file_validation.extra_uploads.length && <div className="notice notice-error"><strong>有未列入清单的上传文件</strong><ul>{preview.file_validation.extra_uploads.map((name, index) => <li key={`${name}-${index}`}>{name}</li>)}</ul></div>}
              {!!preview.file_validation.size_errors.length && <div className="notice notice-error"><strong>文件大小不匹配</strong><ul>{preview.file_validation.size_errors.map((item, index) => <li key={`${item.file_name}-${index}`}>{item.file_name}：清单 {item.expected}，实际 {item.actual} 字节</li>)}</ul></div>}
              {!!preview.file_validation.hash_errors.length && <div className="notice notice-error"><strong>SHA-256 不匹配</strong><ul>{preview.file_validation.hash_errors.map((item, index) => <li key={`${item.file_name}-${index}`}>{item.file_name}：期望 {item.expected.slice(0, 16)}…，实际 {item.actual.slice(0, 16)}…</li>)}</ul></div>}
              {!!preview.file_validation.type_errors.length && <div className="notice notice-error"><strong>文件类型或内容不匹配</strong><ul>{preview.file_validation.type_errors.map((item, index) => <li key={`${item.file_name}-${index}`}>{item.file_name} · {item.mime_type}</li>)}</ul></div>}
              {!!preview.file_validation.mapping_errors.length && <div className="notice notice-error"><strong>清单映射错误</strong><ul>{preview.file_validation.mapping_errors.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></div>}
              {!!preview.file_validation.unreferenced_files.length && <div className="inline-note"><strong>未被当前或历史账本引用的清单文件</strong><ul>{preview.file_validation.unreferenced_files.map((item) => <li key={`${item.library_ref}-${item.version_id ?? "unversioned"}`}>{item.file_name} · {item.library_ref} · {item.version_id ?? "无账本版本"}</li>)}</ul></div>}
            </details>
            {!!preview.library_files.length && <details className="source-details"><summary>逐文件查看 Library 来源标识与哈希（{preview.library_files.length} 个文件版本）</summary><ul className="import-attachment-list">{preview.library_files.map((file) => <li key={`${file.library_ref}-${file.version_id ?? "unversioned"}`}><span><strong>{file.file_name}</strong><small>{file.mime_type} · {file.byte_size} 字节</small></span><code>Library {file.library_id} · 文件 {file.file_id} · Library 版本 {String(file.version)}<br />{file.library_ref} · 账本版本 {file.version_id ?? "无"}<br />SHA-256 {file.sha256}</code></li>)}</ul></details>}
            {preview.conflicts.length > 0 ? (
              <div className="notice notice-error" role="alert"><strong>目标账号已有数据，不能覆盖</strong><p>冲突项：{preview.conflicts.map((item) => TABLE_LABELS[item] || item).join("、")}。请先使用空账号；此预览不会改动现有记录。</p></div>
            ) : !preview.file_validation.can_import ? (
              <div className="notice notice-error" role="alert"><strong>文件校验未通过，不能导入</strong><p>请补齐缺失或冲突的附件并重新预览。系统不会跳过任何未通过校验的文件。</p></div>
            ) : (
              <>
                <div className="inline-note"><ShieldCheck size={16} />确认后保留原账本与操作回执原文、版本及历史引用；文件映射到当前账号的私有存储。导入后会核对记录数、文件字节、SHA-256 和所有权。</div>
                <label className="switch-row"><div><strong>我确认将完整备份迁入当前账号</strong><p>此操作不可覆盖现有数据；导入成功后再次迁入会被拒绝。</p></div><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /></label>
                <div className="form-actions"><span>预览将在 {Math.ceil(preview.expires_in_seconds / 60)} 分钟后过期</span><button className="button button-primary" onClick={() => { void commitBackup(); }} disabled={!confirmed || !!busy || !preview.stage_id}>{busy === "commit" ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{busy === "commit" ? "正在迁入并核验" : "确认并迁入"}</button></div>
              </>
            )}
          </section>
        )}
      </div>
    </dialog>
  );
}
