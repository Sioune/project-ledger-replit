function isCalendarDate(value:unknown):value is string{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value.startsWith('0000'))return false;const instant=new Date(`${value}T00:00:00.000Z`);return Number.isFinite(instant.getTime())&&instant.toISOString().slice(0,10)===value;}
export type TaskStatus = 'todo'|'doing'|'waiting'|'blocked'|'done'|'cancelled';
export type ItemType='task'|'event'|'reference';
export type EventStatus='reserved'|'planned'|'completed'|'cancelled';
export type Task = {id:string;project_id:string;parent_id?:string|null;title:string;status:TaskStatus;next_action:string;dependencies:string[];version:number;updated_at:string;created_at?:string;completed_at?:string|null;planned_date?:string|null;due_at?:string|null;waiting_for?:string|null;expected_result?:string|null;review_at?:string|null;verification_state:string;source_ref:string;item_type?:ItemType;event_status?:EventStatus;event_date?:string|null;start_at?:string|null;fact_date?:string|null;fact_at?:string|null;location?:string|null;attachment_ids?:string[]};
export type Project = {id:string;name:string;goal:string;status:string;completion_rule:string;external_links:string[];version:number;created_at?:string;start_date?:string|null;target_end_date?:string|null;completed_date?:string|null};
export type Doc = {id:string;project_id:string;task_id?:string;filename:string;versions:{id:string;library_ref:string;summary:string;created_at:string;checksum?:string}[];current_version:string;accepted_version?:string|null};
export type Ledger = {projects:Project[];tasks:Task[];documents:Doc[];pending:{id:string;question:string;status:string;context:string;answer?:string;resolved_at?:string}[];settings:{timezone:string;intervalHours:number;workStart:string;workEnd:string;enabled:boolean};reminderLog:unknown[]};
export type Change = {type:'create'|'update'|'project'|'settings'|'document'|'pending'|'restore';id?:string;values:Record<string,unknown>};
export type Submit = {operation_id:string;idempotency_key:string;source_event_id:string;base_version:number;occurred_at:string;raw_text:string;changes:Change[];confirmed?:boolean;undo_of?:string};
export class AppError extends Error {constructor(public status:number,public code:string,message:string,public details:Record<string,unknown>={}){super(message)}}
export const normalize = (s:string) => s.normalize('NFKC').toLowerCase().replace(/[\s，。！？、,.!?：:;；“”"'‘’]/g,'');
const uid = () => crypto.randomUUID();
const clone = <T>(v:T):T => structuredClone(v);
const str=(v:unknown,max=1000) => {if(typeof v!=='string'||v.length>max)throw new AppError(400,'INVALID','文本字段无效或过长');return v.trim()};
const intakeFields=['item_type','event_status','event_date','start_at','fact_date','fact_at','location','attachment_ids'];
const validInstant=(value:unknown):value is string=>typeof value==='string'&&isCalendarDate(value.slice(0,10))&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&/(Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
const shanghaiDate=(value:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
function intakeValues(values:Record<string,unknown>){
 const parsed:Record<string,unknown>={};
 for(const key of intakeFields){if(values[key]===undefined)continue;const value=values[key];
  if(key==='item_type'||key==='event_status'){if(typeof value!=='string'||!(key==='item_type'?['task','event','reference']:['reserved','planned','completed','cancelled']).includes(value))throw new AppError(400,'FIELD','事项类型或活动状态无效');parsed[key]=value;}
  else if(key==='attachment_ids'){if(!Array.isArray(value)||value.length>20||value.some(id=>typeof id!=='string'||!/^img_[a-f0-9]{64}$/.test(id))||new Set(value).size!==value.length)throw new AppError(400,'ATTACHMENT','原图引用须为不重复的本人图片编号');parsed[key]=[...value];}
  else if(value===null||value==='')parsed[key]=null;
  else if(key==='location')parsed[key]=str(value,2000);
  else{if(!(key==='event_date'||key==='fact_date'?isCalendarDate(value):validInstant(value)))throw new AppError(400,'DATE','活动/事实日期和时间须为真实日期及含时区的ISO时间');parsed[key]=value;}
 }
 return parsed;
}
function eventStateValues(values:Record<string,unknown>,current?:Task):{status?:TaskStatus;event_status?:EventStatus}{
 if((values.item_type??current?.item_type)!=='event')return {};
 const hasStatus=values.status!==undefined,hasEventStatus=values.event_status!==undefined;
 const status=(values.status??current?.status??'todo') as TaskStatus,eventStatus=values.event_status as EventStatus;
 if(hasStatus&&hasEventStatus){
  const compatible=eventStatus==='completed'?status==='done':eventStatus==='cancelled'?status==='cancelled':status!=='done'&&status!=='cancelled';
  if(!compatible)throw new AppError(400,'EVENT_STATUS_CONFLICT','活动状态与业务状态矛盾：活动完成对应done，活动取消对应cancelled，预约或安排中不能同时为已完成或已取消');
  return {};
 }
 if(hasEventStatus)return {status:eventStatus==='completed'?'done':eventStatus==='cancelled'?'cancelled':'todo'};
 if(!current||current.item_type!=='event'||hasStatus&&status!==current.status)return {event_status:status==='done'?'completed':status==='cancelled'?'cancelled':'planned'};
 return {};
}
function eventIdentity(task:Task){
 const legacy=!task.item_type&&task.title.startsWith('已预约活动｜')&&(isCalendarDate(task.planned_date)||validInstant(task.due_at));
 if(task.item_type!=='event'&&!legacy||task.status==='cancelled'||task.event_status==='cancelled')return null;
 const start=validInstant(task.start_at)?task.start_at:legacy&&validInstant(task.due_at)?task.due_at:null;
 const date=start?shanghaiDate(start):task.event_date??(legacy?task.planned_date:null),location=task.location?normalize(task.location):'';
 return date?{date,start:start?Date.parse(start):null,location}:null;
}
function validate(data:Ledger){
 if(!data||!Array.isArray(data.projects)||!Array.isArray(data.tasks)||!Array.isArray(data.documents)||!Array.isArray(data.pending)||data.tasks.length>10000||data.projects.length>1000)throw new AppError(400,'DATA','状态库格式无效');
 for(const p of data.projects){for(const value of [p.id,p.name,p.goal,p.status])if(typeof value!=='string')throw new AppError(400,'PROJECT','项目字段无效');if(!p.id||!p.name.trim()||!Array.isArray(p.external_links))throw new AppError(400,'PROJECT','项目字段无效');
  for(const key of ['start_date','target_end_date','completed_date'] as const)if(p[key]!==undefined&&p[key]!==null&&!isCalendarDate(p[key]))throw new AppError(400,'DATE','项目日期须为真实的YYYY-MM-DD日期');
  if(p.start_date&&((p.target_end_date&&p.target_end_date<p.start_date)||(p.completed_date&&p.completed_date<p.start_date)))throw new AppError(400,'DATE_ORDER','项目计划结束日和实际完成日不能早于进场日');
 }
 const ids=new Set(data.tasks.map(t=>t.id)); if(ids.size!==data.tasks.length)throw new AppError(400,'DUPLICATE_ID','任务ID重复');
 for(const t of data.tasks){
  intakeValues(t as unknown as Record<string,unknown>);
  if(t.event_date&&t.start_at&&shanghaiDate(t.start_at)!==t.event_date||t.fact_date&&t.fact_at&&shanghaiDate(t.fact_at)!==t.fact_date)throw new AppError(400,'DATE_CONFLICT','日期与时间须属于同一个上海自然日');
  for(const value of [t.id,t.project_id,t.title,t.next_action,t.verification_state])if(typeof value!=='string'||!value.trim())throw new AppError(400,'TASK_FIELD','任务必填字段不能为空');if(!Array.isArray(t.dependencies)||t.dependencies.some(x=>typeof x!=='string')||!Number.isInteger(t.version)||!Number.isFinite(Date.parse(t.updated_at)))throw new AppError(400,'TASK_FIELD','任务依赖或版本无效');
   for(const key of ['due_at','review_at'] as const)if(t[key]&&(!/(Z|[+-]\d\d:\d\d)$/.test(t[key])||!Number.isFinite(Date.parse(t[key]))))throw new AppError(400,'DATE','时间需包含时区');if(t.planned_date&&!isCalendarDate(t.planned_date))throw new AppError(400,'DATE','计划日须为真实的YYYY-MM-DD日期');if(!['user_reported','unverified','confirmed'].includes(t.verification_state))throw new AppError(400,'VERIFICATION','核实状态无效');
  if(!data.projects.some(p=>p.id===t.project_id))throw new AppError(400,'PROJECT','项目不存在');
  if(!['todo','doing','waiting','blocked','done','cancelled'].includes(t.status))throw new AppError(400,'STATUS','状态无效');
  for(const d of t.dependencies)if(!ids.has(d))throw new AppError(400,'DEPENDENCY','前序任务不存在');
  if(t.parent_id&&!ids.has(t.parent_id))throw new AppError(400,'PARENT','父任务不存在');
  const walk=(id:string,path:Set<string>)=>{if(path.has(id))throw new AppError(400,'CYCLE','依赖或子任务不能成环');const p=new Set(path).add(id);const n=data.tasks.find(x=>x.id===id)!;for(const dep of [...n.dependencies,...(n.parent_id?[n.parent_id]:[])])walk(dep,p)}; walk(t.id,new Set());
  if(['done','doing','waiting'].includes(t.status)&&t.dependencies.some(id=>data.tasks.find(d=>d.id===id)?.status!=='done'))throw new AppError(409,'BLOCKED','前序任务尚未完成，不能开始、等待或完成此任务',{task_id:t.id});
  if(t.status==='waiting'&&!t.waiting_for)throw new AppError(400,'WAITING','请填写等待对象');
 }
 for(const d of data.documents){if(!data.projects.some(p=>p.id===d.project_id)|| (d.task_id&&(!ids.has(d.task_id)||data.tasks.find(t=>t.id===d.task_id)?.project_id!==d.project_id)))throw new AppError(400,'DOCUMENT','文件项目或任务不存在，或任务不属于此项目');if(!d.versions.some(v=>v.id===d.current_version)||d.accepted_version&&!d.versions.some(v=>v.id===d.accepted_version))throw new AppError(400,'DOCUMENT','文件版本不存在');}
}
export function applyChanges(current:Ledger,changes:Change[],now:string,occurredAt:string):{data:Ledger;effective:Change[]}{
 if(!Array.isArray(changes)||changes.length>100)throw new AppError(400,'CHANGES','每组最多100项变更');
 const data=clone(current),effective:Change[]=[],activeUpdates=new Set<string>();
  for(const c of changes){if(!c||typeof c.values!=='object'||!c.values||Array.isArray(c.values))throw new AppError(400,'CHANGE','变更格式不正确');const v=c.values;
   if(Object.prototype.hasOwnProperty.call(v,'created_at'))throw new AppError(400,'FIELD','登记时间由服务端记录，不能由客户端设置或修改');
  if(c.type==='create'){
   const title=str(v.title,300);if(!title)throw new AppError(400,'TITLE','请输入任务名称');
   const metadata=intakeValues(v),eventState=eventStateValues({...v,...metadata});
   const proposed={title,status:(v.status??'todo'),planned_date:v.planned_date,due_at:v.due_at,...metadata,...eventState} as Task,proposedEvent=eventIdentity(proposed);
   if(proposedEvent?.location){const candidate=data.tasks.find(task=>{const key=eventIdentity(task);return key&&key.date===proposedEvent.date&&key.location===proposedEvent.location&&(key.start===null||proposedEvent.start===null||key.start===proposedEvent.start);});if(candidate)throw new AppError(409,'DUPLICATE_EVENT','已有相同日期、时间和地点的预约，请核对现有事项',{candidate});}
   const separateEvent=(other:Task)=>{const key=eventIdentity(other);return !!(proposedEvent&&key&&(proposedEvent.date!==key.date||proposedEvent.start!==null&&key.start!==null&&proposedEvent.start!==key.start||proposedEvent.location&&key.location&&proposedEvent.location!==key.location));};
   const project_id=str(v.project_id??'p-inbox',100);const exact=data.tasks.find(t=>t.project_id===project_id&&normalize(t.title)===normalize(title)&&t.status!=='cancelled'&&!separateEvent(t));if(exact)continue;
   const candidate=data.tasks.find(t=>t.project_id===project_id&&t.status!=='cancelled'&&!separateEvent(t)&&Math.min(normalize(t.title).length,normalize(title).length)>3&&(normalize(t.title).includes(normalize(title))||normalize(title).includes(normalize(t.title))));
   if(candidate)throw new AppError(409,'POSSIBLE_DUPLICATE','发现相近待办，请核实是已有任务还是新任务',{candidate});
   const id=c.id?str(c.id,100):uid();if(data.tasks.some(t=>t.id===id))throw new AppError(409,'DUPLICATE_ID','任务ID已存在');
    const t:Task={id,project_id,title,status:(v.status?str(v.status,30):'todo') as TaskStatus,next_action:typeof v.next_action==='string'&&v.next_action.trim()?str(v.next_action):title,parent_id:typeof v.parent_id==='string'&&v.parent_id?v.parent_id:null,dependencies:Array.isArray(v.dependencies)?v.dependencies.map(x=>str(x,100)):[],version:1,updated_at:now,created_at:now,completed_at:null,verification_state:v.verification_state?str(v.verification_state,100):'user_reported',source_ref:typeof v.source_ref==='string'?str(v.source_ref):'用户自述'};
   Object.assign(t,metadata,eventState);for(const k of ['planned_date','due_at','review_at','waiting_for','expected_result'] as const){const value=v[k];t[k]=value===undefined||value===null||value===''?null:str(value,2000)}if(t.status==='done')t.completed_at=occurredAt;data.tasks.push(t);effective.push({...c,id,values:t});
  }else if(c.type==='update'){
   const t=data.tasks.find(t=>t.id===c.id);if(!t)throw new AppError(404,'TASK','任务不存在');
   if(new Date(occurredAt).getTime()<new Date(t.updated_at).getTime()-1000)throw new AppError(409,'STALE_EVENT','这条输入早于当前事实，请读取最新状态再确认',{task:t});
   const allowed=['title','project_id','status','next_action','planned_date','due_at','waiting_for','expected_result','review_at','dependencies','verification_state','source_ref','parent_id',...intakeFields];const delta:Record<string,unknown>={};
   for(const [k,original]of Object.entries(v)){
    const val=original===''&&!['title','project_id','status','next_action','verification_state','source_ref'].includes(k)?null:original;
    if(!allowed.includes(k))throw new AppError(400,'FIELD','不允许修改字段：'+k);
    if(['title','project_id','status','next_action','verification_state','source_ref'].includes(k)&&(val===null||typeof val!=='string'||!val.trim()))throw new AppError(400,'FIELD','此字段不能为空：'+k);
    if(intakeFields.includes(k))Object.assign(delta,intakeValues({[k]:val}));
    else if(k==='dependencies'){if(!Array.isArray(val))throw new AppError(400,'DEPENDENCY','依赖必须为数组');delta[k]=val.map(x=>str(x,100));}
    else{delta[k]=val===null?null:str(val,k==='title'?300:2000);if(['due_at','review_at'].includes(k)&&val!==null&&(!String(val).match(/(Z|[+-]\d\d:\d\d)$/)||!Number.isFinite(Date.parse(String(val)))))throw new AppError(400,'DATE','时间需包含时区');if(k==='planned_date'&&val!==null&&!isCalendarDate(val))throw new AppError(400,'DATE','计划日须为真实的YYYY-MM-DD日期');}
   }
   const eventDelta=eventStateValues(delta,t);Object.assign(delta,eventDelta);
   if(typeof delta.status==='string'&&['doing','waiting','done'].includes(delta.status))activeUpdates.add(t.id);
   if(Object.entries(delta).every(([k,val])=>JSON.stringify(t[k as keyof Task])===JSON.stringify(val)))continue;
   const oldStatus=t.status,oldCompletedAt=t.completed_at;Object.assign(t,delta,{version:t.version+1,updated_at:now});t.completed_at=t.status==='done'?(oldStatus==='done'?oldCompletedAt:occurredAt):null;effective.push({...c,values:{...v,...eventDelta}});
  }else if(c.type==='project'){
   let p=data.projects.find(p=>p.id===c.id);if(!p){p={id:c.id??uid(),name:str(v.name,300),goal:str(v.goal??'',2000),status:'active',completion_rule:'用户确认关键后续完成后归档',external_links:[],version:1,created_at:now};data.projects.push(p)}else p.version++;
   for(const [k,val] of Object.entries(v)){if(k==='external_links'){if(!Array.isArray(val))throw new AppError(400,'LINK','入口必须为数组');p.external_links=val.map(x=>{const link=str(x,1000);if(!/^(https:\/\/|codex:\/\/threads\/)/.test(link))throw new AppError(400,'LINK','仅接受已核实的HTTPS或Codex任务入口');return link})}else if(['start_date','target_end_date','completed_date'].includes(k)){if(val!==null&&val!==''&&!isCalendarDate(val))throw new AppError(400,'DATE','项目日期须为真实的YYYY-MM-DD日期');(p as unknown as Record<string,unknown>)[k]=val===''?null:val;}else if(['name','goal','status','completion_rule'].includes(k)){(p as unknown as Record<string,unknown>)[k]=str(val,2000)}else throw new AppError(400,'FIELD','项目字段无效')}
   if(!['active','paused','archived'].includes(p.status))throw new AppError(400,'STATUS','项目状态无效');if(p.status==='archived'&&data.tasks.some(t=>t.project_id===p.id&&!['done','cancelled'].includes(t.status)))throw new AppError(409,'FOLLOW_UP','仍有未完成后续，请先处理或取消后确认归档');effective.push({...c,id:p.id});
  }else if(c.type==='settings'){
   const settings={...data.settings};for(const [k,val] of Object.entries(v)){if(k==='timezone'){if(val!=='Asia/Shanghai')throw new AppError(400,'TIMEZONE','此版本提醒时区固定为Asia/Shanghai');settings.timezone=val}else if(k==='intervalHours'){if(val!==2)throw new AppError(400,'INTERVAL','此版本支持每2小时整点');settings.intervalHours=2}else if(k==='enabled'){if(typeof val!=='boolean')throw new AppError(400,'SETTING','开关无效');settings.enabled=val}else if(k==='workStart'||k==='workEnd'){if(typeof val!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(val))throw new AppError(400,'SETTING','工作时段无效');settings[k]=val}else throw new AppError(400,'SETTING','设置字段无效')};if(settings.workStart>=settings.workEnd)throw new AppError(400,'SETTING','结束需晚于开始');data.settings=settings;effective.push(c);
  }else if(c.type==='document'){
   let d=data.documents.find(d=>d.id===c.id);
   if(v.accepted_version){if(!d)throw new AppError(404,'DOCUMENT','文件不存在');const accepted=str(v.accepted_version,100);if(!d.versions.some(x=>x.id===accepted))throw new AppError(400,'DOCUMENT','版本不存在');d.accepted_version=accepted;effective.push(c);continue;}
   const library_ref=str(v.library_ref,250);if(!/^libfile_[A-Za-z0-9]+$/.test(library_ref))throw new AppError(400,'LIBRARY_REF','请提供现有Library文件ID（libfile_…），不接受公开URL或本地路径');
   const version={id:uid(),library_ref,summary:str(v.summary??'',2000),created_at:now};
   if(!d){d={id:c.id??uid(),project_id:str(v.project_id,100),task_id:v.task_id?str(v.task_id,100):undefined,filename:str(v.filename,300),versions:[],current_version:version.id,accepted_version:null};data.documents.push(d)}
   if(d.versions.some(x=>x.library_ref===library_ref))continue;d.versions.push(version);d.current_version=version.id;effective.push({...c,id:d.id,values:{...v,version_id:version.id}});
  }else if(c.type==='pending'){
   const q=data.pending.find(q=>q.id===c.id);if(q){q.status=v.status==='resolved'?'resolved':'open';if(v.answer){q.answer=str(v.answer,4000);q.resolved_at=now}effective.push(c)}else{const id=c.id??uid();data.pending.push({id,question:str(v.question,1000),context:str(v.context??'',2000),status:'open'});effective.push({...c,id})}
  }else if(c.type==='restore'){
   const restored=v.data as Ledger;if(!restored||!Array.isArray(restored.tasks)||!Array.isArray(restored.projects)||!Array.isArray(restored.documents)||!Array.isArray(restored.pending)||!restored.settings)throw new AppError(400,'RESTORE','备份格式无效');
   const copy=clone(restored);
   for(const p of copy.projects){const prior=current.projects.find(x=>x.id===p.id);if(prior?.created_at)p.created_at=prior.created_at;else delete p.created_at;}
   for(const t of copy.tasks){const prior=current.tasks.find(x=>x.id===t.id);if(prior?.created_at)t.created_at=prior.created_at;else delete t.created_at;const compare=(x:Task)=>JSON.stringify({...x,version:0,updated_at:''});if(prior&&compare(t)!==compare(prior)){t.version=Math.max(t.version,prior.version)+1;t.updated_at=now}else if(prior){t.version=prior.version;t.updated_at=prior.updated_at}}validate(copy);Object.assign(data,copy,{reminderLog:[]});effective.push(c);
  }else throw new AppError(400,'CHANGE','变更类型不支持');
 }
 // A status update cannot erase its original unfinished prerequisites in the same group.
 // Check final outcomes so either ordering of a legitimate atomic completion remains valid.
 for(const id of activeUpdates){
  const before=current.tasks.find(t=>t.id===id),after=data.tasks.find(t=>t.id===id);
  if(!before||!after||!['doing','waiting','done'].includes(after.status))continue;
  const blockers=before.dependencies.filter(dep=>current.tasks.find(t=>t.id===dep)?.status!=='done'&&data.tasks.find(t=>t.id===dep)?.status!=='done');
  if(blockers.length)throw new AppError(409,'BLOCKED','原前序任务尚未完成，不能通过修改依赖跳过',{task_id:id,blocking_dependency_ids:blockers});
 }
 // A released prerequisite makes the next action available; it never completes it.
 for(const t of data.tasks){if(t.status==='blocked'&&t.dependencies.length&&t.dependencies.every(id=>data.tasks.find(d=>d.id===id)?.status==='done')){t.status=t.waiting_for?'waiting':'todo';t.version++;t.updated_at=now;effective.push({type:'update',id:t.id,values:{status:t.status}})}else if(t.status==='todo'&&t.dependencies.some(id=>data.tasks.find(d=>d.id===id)?.status!=='done')){t.status='blocked';t.version++;t.updated_at=now;effective.push({type:'update',id:t.id,values:{status:'blocked'}})}}
 validate(data);
 for(const task of data.tasks){const identity=eventIdentity(task);if(!identity?.location)continue;const previous=current.tasks.find(t=>t.id===task.id);if(previous&&JSON.stringify(eventIdentity(previous))===JSON.stringify(identity))continue;const candidate=data.tasks.find(other=>{if(other.id===task.id)return false;const key=eventIdentity(other);return key&&key.date===identity.date&&key.location===identity.location&&(key.start===null||identity.start===null||key.start===identity.start);});if(candidate)throw new AppError(409,'DUPLICATE_EVENT','已有相同日期、时间和地点的预约，请核对现有事项',{candidate});}
 return {data,effective};
}
// A spoken status must resolve against the current ledger, never seed IDs or old source text.
function teaserPreview(text:string,data:Ledger,negative:boolean){
 const ask=(question:string)=>({changes:[] as Change[],questions:[question],summary:'尚未保存；请先核对本次对应的任务与轮次。'});
 if(negative||/是否|如果|假如|失败|出错|报错|异常|退回|撤回|(?:收到.*反馈|完成.*修订)后|^(?:新增|新建|添加|记下|帮我记)/.test(text))return ask('这条包含计划、否定、疑问、新增或异常情况。请在任务详情核对具体任务与本次事实，暂不改变已有状态。');
 const mentioned=data.projects.filter(p=>normalize(p.name).length>1&&normalize(text).includes(normalize(p.name)));
 const projects=data.projects.filter(p=>/teaser/i.test(p.name)||data.tasks.some(t=>t.project_id===p.id&&/teaser/i.test(t.title)));
 const selected=mentioned.length?projects.filter(p=>mentioned.some(m=>m.id===p.id)):projects;
 if(selected.length!==1||mentioned.some(p=>p.id!==selected[0]?.id))return ask('请明确这次 teaser 属于哪个项目；混合项目的内容暂不合并更新。');
 const project=selected[0],tasks=data.tasks.filter(t=>t.project_id===project.id&&t.status!=='cancelled');
 const remaining=new Set(tasks.map(t=>t.id)),groups:Task[][]=[];
 while(remaining.size){
  const group:Task[]=[],queue=[remaining.values().next().value!];
  while(queue.length){const id=queue.pop()!;if(!remaining.delete(id))continue;const task=tasks.find(t=>t.id===id)!;group.push(task);for(const other of tasks)if(remaining.has(other.id)&&(task.dependencies.includes(other.id)||other.dependencies.includes(id)||task.parent_id===other.id||other.parent_id===id))queue.push(other.id);}
  if(/teaser/i.test(project.name)||group.some(t=>/teaser/i.test(t.title)))groups.push(group);
 }
 if(!groups.length)return ask('实时库中没有找到可定位的 teaser 任务，请先选择或新建具体任务。');
 const dates=(value:string)=>{
  const found:{year:string;month:number;day:number}[]=[];
  for(const match of value.matchAll(/(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})日?/g))found.push({year:match[1]??'',month:Number(match[2]),day:Number(match[3])});
  for(const match of value.matchAll(/(20\d{2})-(\d{2})-(\d{2})/g))found.push({year:match[1],month:Number(match[2]),day:Number(match[3])});
  return found;
 };
 const roundNumber=(value:string)=>{
  if(/^\d+$/.test(value))return String(Number(value));
  const digits:Record<string,number>={'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
  if(value==='十')return '10';if(value.includes('十')){const [tens,ones]=value.split('十');return String((digits[tens]??1)*10+(digits[ones]??0));}return String(digits[value]??value);
 };
 const rounds=(value:string)=>Array.from(value.matchAll(/第([一二三四五六七八九十\d]+)轮/g),m=>roundNumber(m[1]));
 const inputDates=dates(text),inputRounds=rounds(text);
 if(new Set(inputDates.map(d=>`${d.month}-${d.day}`)).size>1||new Set(inputRounds).size>1||/(?:上一轮|上轮|前一轮).*(?:新一轮|本轮|这轮)|(?:新一轮|本轮|这轮).*(?:上一轮|上轮|前一轮)/.test(text))return ask('这条提到了多个日期或轮次，请分开说明每一轮对应的任务和事实。');
 let candidates=groups;
 const namedById=(task:Task)=>new RegExp(`(?<![A-Za-z0-9_-])${task.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![A-Za-z0-9_-])`).test(text);
 const quotedTitle=(task:Task)=>[['“','”'],['"','"'],["'","'"],['「','」'],['《','》']].some(([left,right])=>text.includes(`${left}${task.title}${right}`));
 const explicit=tasks.filter(t=>namedById(t)||quotedTitle(t)||((dates(t.title).length||rounds(t.title).length)&&normalize(text).includes(normalize(t.title))));
 if(explicit.length)candidates=candidates.filter(g=>explicit.some(t=>g.includes(t)));
 if(inputDates.length)candidates=candidates.filter(g=>g.some(t=>dates(`${t.title} ${t.planned_date??''}`).some(d=>inputDates.every(i=>i.month===d.month&&i.day===d.day&&(!i.year||!d.year||i.year===d.year)))));
 if(inputRounds.length)candidates=candidates.filter(g=>g.some(t=>rounds(t.title).some(r=>inputRounds.includes(r))));
 if(candidates.length!==1)return ask('实时库中存在多个或尚未匹配的 teaser 轮次。请提供具体任务、任务编号或该轮标题中的日期，暂不改变前轮记录。');
 const group=candidates[0];
 if(explicit.some(t=>!group.includes(t)))return ask('这条同时指向不同轮次，请分开核对，暂不改变任何一轮。');
 if(/新一轮|上一轮|上轮|前一轮/.test(text)&&!inputDates.length&&!inputRounds.length&&!group.some(t=>/新一轮|上一轮|上轮|前一轮/.test(t.title)))return ask('不能仅凭“新一轮”或“上一轮”推定已有任务，请明确任务编号、标题或日期。');
 let factText=text;
 for(const task of explicit)for(const [left,right] of [['“','”'],['"','"'],["'","'"],['「','」'],['《','》']])factText=factText.replaceAll(`${left}${task.title}${right}`,'');
 const titleContacts=(task:Task)=>Array.from(task.title.matchAll(/(?:发给|发送给|给|同步)\s*([\p{L}\p{N}·._-]{1,30})$/gu),m=>m[1]);
 const waitingContacts=group.filter(t=>t.verification_state!=='unverified'&&t.waiting_for&&!/待核|待确认|未知|不明|[\/／]/.test(t.waiting_for)).map(t=>t.waiting_for!.trim());
 const contacts=new Set(waitingContacts.length?waitingContacts:group.flatMap(titleContacts));
 const contactName=(value:string)=>value.replace(/^(?:今天|现在)?(?:已(?:经)?)?收到/,'').replace(/^(?:今天|现在)/,'').replace(/的$/,'');
 const receivers=Array.from(factText.matchAll(/(?:发给|发送给|同步(?:给)?|(?:发送|发了|已发)[^，。；,;！？?]{0,40}?给)\s*([^\s，。；,;！？?]{1,50})/g),m=>m[1].split(/了|并|后|现在|等待/)[0]);
 const speakers=Array.from(factText.matchAll(/(?:^|[\s，,；;。])([\p{Script=Han}A-Za-z·]{2,12})(?:说|的反馈)/gu),m=>contactName(m[1]));
 const feedbackNames=Array.from(factText.matchAll(/([\p{Script=Han}·]{2,12})反馈(?:已经|已|收)/gu),m=>contactName(m[1])).filter(c=>!['现在','这次','本次','本轮','这轮','上一轮','新一轮','已经','所有','全部'].includes(c));
 const receivedFrom=Array.from(factText.matchAll(/收到\s*([^，。；,;\s]*?)反馈/gu),m=>m[1].replace(/teaser/gi,'').replace(/的$/,'')).filter(c=>c&&!/^(?:了|一条|新的|最新|这轮|本轮|该轮|对方|他|她|他们)$/.test(c));
 const waitingOn=Array.from(factText.matchAll(/等(?:待)?\s*([^，。；,;\s]*?)反馈/gu),m=>m[1].replace(/teaser/gi,'').replace(/的$/,'')).filter(c=>c&&!/^(?:对方|他|她|他们)$/.test(c));
 const otherKnown=data.tasks.flatMap(t=>t.waiting_for?[t.waiting_for.trim()]:[]).filter(c=>c&&!contacts.has(c)&&factText.includes(c));
 if([...receivers,...speakers,...feedbackNames,...receivedFrom,...waitingOn,...otherKnown].some(c=>!contacts.has(c)))return ask('本次提到的对象与该轮实时等待对象尚未匹配，请先确认联系人，暂不改名或改变状态。');
 const edit=/(?:已(?:经)?(?:更新|修订|修改|制作)|(?:更新|修订|修改|制作)(?:完成|完了|好了|好|完|了)|改好|做好)/.test(factText);
 const send=/(?:已(?:经)?(?:发出|发给|发送|同步)|(?:发出|发给|发送|同步)[^，,；;。！？?!]{0,50}(?:了|完成))/.test(factText);
 const feedback=/(?:收到[^，,；;。！？?!]*反馈|反馈[^，,；;。！？?!]*(?:收到|已到|到了))/.test(factText);
 const waiting=/等(?:待)?[^，,；;。！？?!]*反馈/.test(factText);
 if(feedback&&waiting)return ask('同一条同时表示收到反馈与继续等待反馈，请明确是哪一轮、哪一步。');
 const intents=[...(edit?['edit']:[]),...(send?['send']:[]),...(feedback||waiting?['feedback']:[])];
 if(!intents.length)return ask('未识别到明确完成事实。请在任务详情选择具体步骤，计划与否定不会写成完成。');
 const roles=(task:Task)=>[...(/更新|修订|修改|制作|剪辑/.test(task.title)?['edit']:[]),...(/发送|发给|发出|同步/.test(task.title)?['send']:[]),...(/反馈/.test(task.title)?['feedback']:[])];
 const changes:Change[]=[];
 for(const intent of intents){
  const matches=group.filter(t=>roles(t).includes(intent));
  if(matches.length!==1||roles(matches[0]).length!==1)return ask('该轮步骤尚不能唯一拆分为制作、发送或反馈。请在任务详情核对完成范围，暂不把整轮或前轮标为完成。');
  const task=matches[0];
  if(intent==='feedback'&&waiting&&(!task.waiting_for||task.status==='done'))return ask('该反馈任务缺少明确等待对象，或已完成。请先核对，暂不重新打开或改写它。');
  changes.push({type:'update',id:task.id,values:{status:intent==='feedback'&&waiting?'waiting':'done'}});
 }
 if(changes.some(c=>tasks.find(t=>t.id===c.id)!.dependencies.some(id=>data.tasks.find(t=>t.id===id)?.status!=='done'&&!changes.some(other=>other.id===id&&other.values.status==='done'))))return ask('该步骤的前序任务尚未完成。请先核对实际完成范围，不能跳过依赖。');
 if(/周|明天|后天|下次|提醒/.test(text))return ask('请分别确认本次事实与复查的具体日期时间（Asia/Shanghai），暂不混合写入未确认事项。');
 return {changes,questions:[] as string[],summary:'已按实时任务和依赖匹配制作、发送与反馈；请核对本轮目标后保存。'};
}
export function preview(text:string,data:Ledger,base_version:number,source_event_id:string,occurred_at:string){
 text=str(text,10000);const questions:string[]=[],changes:Change[]=[];let summary='请检查变更后保存。';
 if(!text)throw new AppError(400,'EMPTY','请输入口述文字');
 const negation=/(准备|打算|应该|可能|预计|计划|未|没|不|并非|否|无需|[？?吗])/;
 const negative=negation.test(text);
 if(/teaser/i.test(text)&&/(发|更新|修订|修改|制作|同步|改好|完成|反馈)/.test(text)){
  const parsed=teaserPreview(text,data,negative);changes.push(...parsed.changes);questions.push(...parsed.questions);summary=parsed.summary;
 }else if(/都做完|全部完成|全部关闭|上线|注册完成|已提交/.test(text)){
  questions.push('请选定任务并核对完成范围及证据，避免关闭尚有后续的步骤。');summary='重大状态变更需要明确任务范围。';
 }else{
  const title=text.replace(/^(新增|新建|添加|记下|帮我记)(一个)?(任务|待办)?[：:，,\s]*/,'').trim();
  const matches=data.tasks.filter(t=>normalize(t.title)===normalize(title));
  if(matches.length){summary='已有相同任务，无需重复新增。'}
  else {const project=data.projects.filter(p=>text.includes(p.name));const near=data.tasks.filter(t=>normalize(t.title).length>3&&(normalize(title).includes(normalize(t.title))||normalize(t.title).includes(normalize(title))));
   if(near.length){questions.push('可能是已有任务：'+near.map(t=>t.title).join('、')+'。请在任务详情更新，或改写为明确的新任务。');summary='找到相近记录，尚未新增。'}
   else if(negative){questions.push('这是一条计划还是对已有任务的更新？请明确动作。');summary='未把不确定陈述转为已完成。'}
   else {const target=project.length===1?project[0].id:data.projects.find(p=>p.id==='p-inbox')?.id;if(!target){questions.push('请先创建项目，并明确这条待办属于哪个项目。');summary='尚未确定所属项目，不会新建任务。'}else{changes.push({type:'create',id:uid(),values:{title,project_id:target,source_ref:'文本模拟转写 / 用户自述'}});summary='新增本人待办；未编造截止日。'}}
  }
 }
 return {changes,questions,summary,base_version,source_event_id,occurred_at};
}
