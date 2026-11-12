import type {Task,ItemType,EventStatus} from './model';
import {isCalendarDate,toShanghaiDate} from './calendar';

export type Schedulable=Pick<Task,'title'|'planned_date'|'due_at'>&Partial<Pick<Task,'status'|'item_type'|'event_status'|'event_date'|'start_at'>>;
const instant=(value:unknown):value is string=>typeof value==='string'&&isCalendarDate(value.slice(0,10))&&/(Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
const legacy=(item:Schedulable)=>!item.item_type&&item.title.startsWith('已预约活动｜')&&(isCalendarDate(item.planned_date)||instant(item.due_at));
export function getItemType(item:Schedulable):ItemType{return item.item_type??(legacy(item)?'event':'task');}
export function getEventStart(item:Schedulable):string|null{if(getItemType(item)!=='event')return null;return instant(item.start_at)?item.start_at:legacy(item)&&instant(item.due_at)?item.due_at:null;}
export function getEventDate(item:Schedulable):string|null{if(getItemType(item)!=='event')return null;const start=getEventStart(item);return start?toShanghaiDate(start):isCalendarDate(item.event_date)?item.event_date:legacy(item)&&isCalendarDate(item.planned_date)?item.planned_date:null;}
export function getEventStatus(item:Schedulable):EventStatus{return item.event_status??(item.status==='done'?'completed':item.status==='cancelled'?'cancelled':legacy(item)?'reserved':'planned');}
export function getTaskDay(item:Schedulable):string|null{return isCalendarDate(item.planned_date)?item.planned_date:instant(item.due_at)?toShanghaiDate(item.due_at):null;}
export function shanghaiDay(date:Date|string=new Date()):string|null{return toShanghaiDate(date instanceof Date?(Number.isFinite(date.getTime())?date.toISOString():null):date);}
export function shiftDay(date:string,days:number):string|null{if(!isCalendarDate(date)||!Number.isInteger(days))return null;const next=new Date(Date.parse(`${date}T00:00:00Z`)+days*86400000);if(!Number.isFinite(next.getTime()))return null;const result=next.toISOString().slice(0,10);return isCalendarDate(result)?result:null;}
export function isVisibleOnDay(item:Schedulable,date:string):boolean{if(!isCalendarDate(date)||getItemType(item)==='reference')return false;const day=getItemType(item)==='event'?getEventDate(item):getTaskDay(item);return day?day===date:getItemType(item)==='task'&&date===shanghaiDay();}
