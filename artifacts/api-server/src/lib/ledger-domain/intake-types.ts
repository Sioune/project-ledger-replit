import type {TaskStatus,ItemType,EventStatus,Change} from './model';

export type IntakeClassification='new_task'|'task_progress'|'reserved_event'|'completion_evidence'|'reference'|'unclear';
export type IntakeAction='inspect'|'create'|'update'|'link_existing';
export type IntakeFields={
 title:string;classification:IntakeClassification;item_type:ItemType;status:TaskStatus;event_status:EventStatus;
 date:string;time:string;location:string;project_id:string;next_action:string;target_task_id:string;action:IntakeAction;
 /** Human must resolve each question or explicitly confirm that an unknown field remains unknown. */
 uncertainties_confirmed:boolean;
};
export type ExistingTaskRef={id:string;project_id:string;title:string;status:TaskStatus;next_action:string;planned_date?:string|null;due_at?:string|null;item_type?:ItemType;event_status?:EventStatus;event_date?:string|null;start_at?:string|null;location?:string|null;source_ref?:unknown;attachment_ids?:string[]};
export type IntakeCandidate={id:string;title:string;project_id:string;item_type:ItemType;reason:string;exact:boolean};
export type IntakeImage={id:string;sha256:string;mime_type:string;byte_size:number;uploaded_at:string};
export type IntakePreview={fields:IntakeFields;questions:string[];candidates:IntakeCandidate[];duplicate:boolean;changes:Change[];base_version:number;source_event_id:string;occurred_at:string;image:IntakeImage|null;summary:string};
export type IntakeCapabilities={vision:{configured:boolean;enabled:boolean;provider:string;model:string;pricing_text:string;retention_text:string;max_daily_requests:number};max_image_bytes:number;allowed_types:string[];storage_text:string;draft_scope:string};
export type RecognitionResult={fields:IntakeFields;questions:string[];classification:IntakeClassification;recognized:true;provider:string;model:string;cached?:boolean};
export const CLASSIFICATION_LABELS:Record<IntakeClassification,string>={new_task:'新增任务',task_progress:'已有任务进展',reserved_event:'已预约活动',completion_evidence:'完成凭证',reference:'参考资料',unclear:'意图待确认'};
export const EMPTY_INTAKE_FIELDS:IntakeFields={title:'',classification:'unclear',item_type:'task',status:'todo',event_status:'planned',date:'',time:'',location:'',project_id:'',next_action:'',target_task_id:'',action:'inspect',uncertainties_confirmed:false};
