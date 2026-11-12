import type {TaskStatus,ItemType,EventStatus} from './model';

export const CALENDAR_TIMEZONE='Asia/Shanghai' as const;
export type RegistrationSource='recorded'|'history'|'unknown';
export type CalendarRegistration={registered_at:string|null;registration_source:RegistrationSource};
export type CalendarTask=CalendarRegistration&{
 id:string;project_id:string;title:string;status:TaskStatus;next_action:string;dependencies:string[];
 planned_date:string|null;due_at:string|null;completed_at:string|null;
 item_type?:ItemType;event_status?:EventStatus;event_date?:string|null;start_at?:string|null;location?:string|null;fact_date?:string|null;fact_at?:string|null;attachment_ids?:string[];
};
export type CalendarProject=CalendarRegistration&{
 id:string;name:string;status:string;start_date:string|null;target_end_date:string|null;completed_date:string|null;
};
export type CalendarData={
 revision:number;timezone:typeof CALENDAR_TIMEZONE;generated_at:string;
 /** Whether the required history lookup finished without interruption; unknown dates remain explicit. */
 history_complete:boolean;warnings:string[];tasks:CalendarTask[];projects:CalendarProject[];
};

export function isCalendarDate(value:unknown):value is string{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value.startsWith('0000'))return false;
 const instant=new Date(`${value}T00:00:00.000Z`);
 return Number.isFinite(instant.getTime())&&instant.toISOString().slice(0,10)===value;
}

/** Date-only values stay date-only. Instants are grouped by their Shanghai calendar day. */
export function toShanghaiDate(value:string|null|undefined):string|null{
 if(!value)return null;if(isCalendarDate(value))return value;
 if(!/(Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))return null;
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:CALENDAR_TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
 return `${parts.find(p=>p.type==='year')!.value}-${parts.find(p=>p.type==='month')!.value}-${parts.find(p=>p.type==='day')!.value}`;
}

