"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, CircleAlert, Clock3, FolderClosed, RefreshCw } from "lucide-react";
import { isCalendarDate, toShanghaiDate, type CalendarData, type CalendarProject, type CalendarTask } from "@/lib/calendar";
import "./calendar.css";
import { getItemType, getEventDate, getEventStatus } from "@/lib/schedule";

export type CalendarViewProps = {
  data: CalendarData | null;
  loading: boolean;
  error: string;
  stale?: boolean;
  onRefresh: () => void;
  onTaskOpen: (id: string) => void;
  onProjectOpen: (id: string) => void;
  onEditProject: (id: string) => void;
};

type CalendarSelection = { mode: "registered" | "projects"; month: string; date: string; project: string };
type TaskNode = { task: CalendarTask; date: string | null; label: string; kind: "completed" | "planned" | "due" | "registered" | "unknown" };
const DAY = 86_400_000;
const STATUS: Record<CalendarTask["status"], string> = { todo: "待办", doing: "进行中", waiting: "等待反馈", blocked: "有前序依赖", done: "已完成", cancelled: "已取消" };
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00.000Z`);
const dateFromNumber = (value: number) => new Date(value).toISOString().slice(0, 10);
const moveDay = (date: string, step: number) => dateFromNumber(dayNumber(date) + step * DAY);
const todayInShanghai = () => toShanghaiDate(new Date().toISOString())!;
const monthIsValid = (value: string | null): value is string => !!value && /^\d{4}-\d{2}$/.test(value) && isCalendarDate(`${value}-01`);
const fullDate = (date: string) => `${Number(date.slice(0, 4))}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
const shortDate = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
const registrationDate = (item: CalendarTask | CalendarProject) => item.registration_source === "unknown" ? null : toShanghaiDate(item.registered_at);

function moveMonth(month: string, step: number) {
  const [year, number] = month.split("-").map(Number);
  const date = new Date(`${month}-01T00:00:00.000Z`);
  date.setUTCFullYear(year, number - 1 + step, 1);
  const result = date.toISOString().slice(0, 7);
  return monthIsValid(result) ? result : month;
}

function defaultSelection(): CalendarSelection {
  const date = todayInShanghai();
  return { mode: "registered", month: date.slice(0, 7), date, project: "all" };
}

function selectionFromURL(data: CalendarData | null): CalendarSelection {
  const fallback = defaultSelection();
  if (typeof window === "undefined") return fallback;
  const params = new URL(window.location.href).searchParams;
  const inputDate = params.get("cal_date"), inputMonth = params.get("cal_month");
  const month = monthIsValid(inputMonth) ? inputMonth : isCalendarDate(inputDate) ? inputDate.slice(0, 7) : fallback.month;
  const date = isCalendarDate(inputDate) && inputDate.startsWith(month) ? inputDate : fallback.date.startsWith(month) ? fallback.date : `${month}-01`;
  const inputProject = params.get("cal_project");
  return { mode: params.get("cal_mode") === "projects" ? "projects" : "registered", month, date, project: inputProject && data?.projects.some(project => project.id === inputProject) ? inputProject : "all" };
}

function writeSelection(selection: CalendarSelection, data: CalendarData) {
  const url = new URL(window.location.href);
  url.searchParams.set("cal_mode", selection.mode);
  url.searchParams.set("cal_month", selection.month);
  url.searchParams.set("cal_date", selection.date);
  url.searchParams.set("cal_project", selection.project === "all" || data.projects.some(project => project.id === selection.project) ? selection.project : "all");
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function nodeFor(task: CalendarTask): TaskNode {
  if (getItemType(task) === "event") { const date = getEventDate(task); if (date) return { task, date, label: "活动日期 · 开始时间独立于登记日", kind: "planned" }; }
  const completed = task.status === "done" ? toShanghaiDate(task.completed_at) : null;
  if (completed) return { task, date: completed, label: "口述完成记录", kind: "completed" };
  if (isCalendarDate(task.planned_date)) return { task, date: task.planned_date, label: task.status === "done" ? "计划任务日 · 完成时刻未知" : "计划任务日", kind: "planned" };
  const due = toShanghaiDate(task.due_at);
  if (due) return { task, date: due, label: task.status === "done" ? "截止日 · 完成时刻未知" : "截止日", kind: "due" };
  const registered = registrationDate(task);
  if (registered) return { task, date: registered, label: "首次登记 · 进展日期待补", kind: "registered" };
  return { task, date: null, label: task.status === "done" ? "已完成 · 完成时间未知" : "节点日期待补", kind: "unknown" };
}

function DateValue({ value }: { value: string | null }) {
  return value && isCalendarDate(value) ? <time dateTime={value}>{fullDate(value)}</time> : <span className="calendar-missing">未记录</span>;
}

function Status({ task }: { task: CalendarTask }) {
  if (getItemType(task) === "event") return <span className="calendar-task-status">{{ reserved: "已预约", planned: "已安排", completed: "活动已完成", cancelled: "活动已取消" }[getEventStatus(task)]}</span>;
  if (getItemType(task) === "reference") return <span className="calendar-task-status">参考资料</span>;
  return <span className={`calendar-task-status calendar-task-status-${task.status}`}>{STATUS[task.status]}</span>;
}

function RegistrationTask({ task, project, onOpen }: { task: CalendarTask; project?: CalendarProject; onOpen: (id: string) => void }) {
  return <li className="calendar-registration-item"><button type="button" aria-label={`查看日历任务：${task.title}`} onClick={() => onOpen(task.id)}>
    <span className="calendar-task-top"><span>{project?.name || "项目待核"}</span><Status task={task} /></span>
    <strong>{task.title}</strong><span className="calendar-task-next">{task.next_action || "打开任务，补充下一步。"}</span>
    <span className="calendar-provenance">{task.registration_source === "history" ? "首次登记日来自历史操作" : task.registration_source === "recorded" ? "首次登记时间已记录" : "首次登记日未知"}<ChevronRight size={17} aria-hidden="true" /></span>
  </button></li>;
}

export default function CalendarView({ data, loading, error, stale = false, onRefresh, onTaskOpen, onProjectOpen, onEditProject }: CalendarViewProps) {
  const [selection, setSelection] = useState<CalendarSelection>(defaultSelection);
  const gridRef = useRef<HTMLDivElement>(null);
  const today = todayInShanghai();

  useEffect(() => {
    const read = () => { const next = selectionFromURL(data); setSelection(next); if (data) writeSelection(next, data); };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, [data]);

  function update(patch: Partial<CalendarSelection>) {
    const next = { ...selection, ...patch };
    if (!monthIsValid(next.month) || !isCalendarDate(next.date)) return;
    if (next.project !== "all" && !data?.projects.some(project => project.id === next.project)) next.project = "all";
    setSelection(next);
    if (data) writeSelection(next, data);
  }

  function chooseDate(date: string, focus = false) {
    if (!isCalendarDate(date)) return;
    update({ date, month: date.slice(0, 7) });
    if (focus) requestAnimationFrame(() => gridRef.current?.querySelector<HTMLButtonElement>(`button[data-calendar-date="${date}"]`)?.focus());
  }

  function navigateDate(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday };
    if (event.key in steps) { event.preventDefault(); chooseDate(moveDay(date, steps[event.key]), true); }
    else if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      const month = moveMonth(date.slice(0, 7), event.key === "PageUp" ? -1 : 1);
      let day = Number(date.slice(8, 10));
      while (!isCalendarDate(`${month}-${String(day).padStart(2, "0")}`)) day--;
      chooseDate(`${month}-${String(day).padStart(2, "0")}`, true);
    }
  }

  const filteredTasks = useMemo(() => (data?.tasks || []).filter(task => selection.project === "all" || task.project_id === selection.project), [data, selection.project]);
  const filteredProjects = useMemo(() => (data?.projects || []).filter(project => selection.project === "all" || project.id === selection.project), [data, selection.project]);
  const registrations = useMemo(() => {
    const days = new Map<string, CalendarTask[]>();
    for (const task of filteredTasks) { const date = registrationDate(task); if (date) days.set(date, [...(days.get(date) || []), task]); }
    return days;
  }, [filteredTasks]);
  const unknownRegistrations = filteredTasks.filter(task => !registrationDate(task));
  const selectedTasks = registrations.get(selection.date) || [];
  const registeredThisMonth = filteredTasks.filter(task => registrationDate(task)?.startsWith(selection.month)).length;
  const firstWeekday = (new Date(`${selection.month}-01T00:00:00Z`).getUTCDay() + 6) % 7;
  const firstGridDate = moveDay(`${selection.month}-01`, -firstWeekday);
  const calendarDays = Array.from({ length: 42 }, (_, index) => moveDay(firstGridDate, index));
  const nodesByProject = new Map(filteredProjects.map(project => [project.id, filteredTasks.filter(task => task.project_id === project.id).map(nodeFor).sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999") || a.task.title.localeCompare(b.task.title))]));
  const dates = filteredProjects.flatMap(project => [isCalendarDate(project.start_date) ? project.start_date : registrationDate(project), project.target_end_date, project.completed_date, ...(nodesByProject.get(project.id) || []).map(node => node.date)]).filter((date): date is string => !!date && isCalendarDate(date));
  const extent = dates.length ? [Math.min(...dates.map(dayNumber)), Math.max(...dates.map(dayNumber))] : null;
  const minimum = extent ? Math.max(dayNumber("0001-01-01"), extent[0] - (extent[0] === extent[1] ? 7 : 1) * DAY) : 0;
  const maximum = extent ? Math.min(dayNumber("9999-12-31"), extent[1] + (extent[0] === extent[1] ? 7 : 1) * DAY) : 0;
  const position = (date: string) => Math.max(1, Math.min(99, 1 + 98 * (dayNumber(date) - minimum) / (maximum - minimum)));
  const trackStyle = (date: string) => ({ "--calendar-node-x": `${position(date)}%` } as CSSProperties);
  const ticks = extent ? Array.from(new Set(Array.from({ length: 5 }, (_, index) => dateFromNumber(Math.round((minimum + (maximum - minimum) * index / 4) / DAY) * DAY)))) : [];
  const axisCrossesYear = !!extent && dateFromNumber(minimum).slice(0, 4) !== dateFromNumber(maximum).slice(0, 4);
  const projectFor = (task: CalendarTask) => data?.projects.find(project => project.id === task.project_id);

  return <section className="calendar-view" aria-label="项目日历" aria-busy={loading}>
    <header className="calendar-page-header"><div><span className="calendar-eyebrow"><CalendarDays size={17} aria-hidden="true" />登记与周期</span><h1>项目日历</h1><p>按日看首次登记，按项目看每一步的时间。</p></div><button type="button" className="calendar-button calendar-refresh" onClick={onRefresh} disabled={loading}><RefreshCw size={17} className={loading ? "spin" : ""} aria-hidden="true" />{loading ? "正在刷新" : "刷新日历"}</button></header>
    <div className="calendar-controls"><div className="calendar-mode" aria-label="日历视角"><button type="button" aria-pressed={selection.mode === "registered"} onClick={() => update({ mode: "registered" })}>每日登记</button><button type="button" aria-pressed={selection.mode === "projects"} onClick={() => update({ mode: "projects" })}>项目周期</button></div><label className="calendar-project-filter">筛选日历项目<select aria-label="筛选日历项目" value={selection.project} disabled={!data} onChange={event => update({ project: event.target.value })}><option value="all">全部项目</option>{data?.projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label></div>

    {data && <div className="calendar-source"><span>Asia/Shanghai · 读回版本 v{data.revision}</span><span>更新于 <time dateTime={data.generated_at}>{Number.isFinite(Date.parse(data.generated_at)) ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(data.generated_at)) : "时间待核"}</time></span></div>}
    {stale && data && <div className="calendar-message calendar-message-warning" role="status"><Clock3 size={19} aria-hidden="true" /><div><strong>正在显示上次读回的日历</strong><p>当前内容可能已变更，请刷新后再核对任务。</p></div></div>}
    {error && <div className="calendar-message calendar-message-error" role="alert"><CircleAlert size={20} aria-hidden="true" /><div><strong>日历尚未刷新成功</strong><p>{error}</p><button type="button" className="calendar-text-button" disabled={loading} onClick={onRefresh}>重试读取日历</button></div></div>}
    {loading && !data && <div className="calendar-empty calendar-loading" role="status"><RefreshCw size={25} className="spin" aria-hidden="true" /><h2>正在读取项目日历</h2><p>登记日期与项目节点会在读回后展示。</p></div>}
    {!data && !loading && !error && <div className="calendar-empty"><CalendarDays size={28} aria-hidden="true" /><h2>还没有可展示的日历</h2><p>先刷新读取项目与任务记录。</p><button type="button" className="calendar-button" onClick={onRefresh}>读取日历</button></div>}
    {data && (!data.history_complete || data.warnings.length > 0) && <details className="calendar-history-warning"><summary>{data.history_complete ? "登记日期的来源说明" : "部分登记历史未完整读回"}</summary><p>缺少可靠首次登记记录的任务会单独列出，不会用编辑时间或完成记录代替。</p>{data.warnings.length > 0 && <ul>{data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}</details>}

    {data && selection.mode === "registered" && <div className="calendar-registration-view">
      <div className="calendar-month-layout"><div className="calendar-month-board" ref={gridRef}>
        <div className="calendar-month-toolbar"><h2>{Number(selection.month.slice(0, 4))}年{Number(selection.month.slice(5, 7))}月</h2><div><button type="button" className="calendar-icon-button" aria-label="上个月" onClick={() => update({ month: moveMonth(selection.month, -1), date: `${moveMonth(selection.month, -1)}-01` })}><ChevronLeft size={21} aria-hidden="true" /></button><button type="button" className="calendar-today" onClick={() => chooseDate(today)}>回到今天</button><button type="button" className="calendar-icon-button" aria-label="下个月" onClick={() => update({ month: moveMonth(selection.month, 1), date: `${moveMonth(selection.month, 1)}-01` })}><ChevronRight size={21} aria-hidden="true" /></button></div></div>
        <p className="calendar-month-caption">本月首次登记 <strong>{registeredThisMonth}</strong> 项<span>编辑已有任务不会重复计入</span></p>
        <table className="calendar-month-table" role="grid" aria-label={`${selection.month} 首次登记日历`}><thead><tr>{WEEKDAYS.map(day => <th scope="col" key={day}>周{day}</th>)}</tr></thead><tbody>{Array.from({ length: 6 }, (_, week) => <tr key={week}>{calendarDays.slice(week * 7, week * 7 + 7).map((date, index) => {
          if (!isCalendarDate(date)) return <td aria-hidden="true" key={`outside-${index}`}><span className="calendar-day" /></td>;
          const count = registrations.get(date)?.length || 0;
          return <td key={date}><button type="button" data-calendar-date={date} className={`calendar-day${date.startsWith(selection.month) ? "" : " calendar-day-outside"}${date === selection.date ? " calendar-day-selected" : ""}${date === today ? " calendar-day-today" : ""}`} aria-label={`${fullDate(date)}，首次登记${count}项${date === today ? "，今天" : ""}`} aria-pressed={date === selection.date} aria-current={date === today ? "date" : undefined} tabIndex={date === selection.date ? 0 : -1} onClick={() => chooseDate(date)} onKeyDown={event => navigateDate(event, date)}><span>{Number(date.slice(8, 10))}</span><span className="calendar-day-count" aria-hidden="true">{count ? `${count}项` : ""}</span></button></td>;
        })}</tr>)}</tbody></table>
        <p className="calendar-keyboard-hint">可用方向键选择日期，Page Up / Down 切换月份。</p>
      </div><section className="calendar-day-details" aria-labelledby="calendar-selected-day"><div className="calendar-section-heading"><div><span className="calendar-eyebrow">首次登记</span><h2 id="calendar-selected-day"><time dateTime={selection.date}>{fullDate(selection.date)}</time></h2></div><span>{selectedTasks.length} 项</span></div>{selectedTasks.length ? <ul className="calendar-registration-list">{selectedTasks.map(task => <RegistrationTask key={task.id} task={task} project={projectFor(task)} onOpen={onTaskOpen} />)}</ul> : <div className="calendar-empty calendar-empty-day"><CalendarDays size={25} aria-hidden="true" /><h3>这一天没有首次登记的任务</h3><p>可以换一天查看。已有任务的后续编辑不会移到今天。</p></div>}</section></div>
      <section className="calendar-unknown-registrations" aria-label="登记日未知的任务"><div className="calendar-section-heading"><div><h2>登记日未知</h2><p>未用编辑时间、计划日或完成记录推定首次登记。</p></div><span>{unknownRegistrations.length} 项</span></div>{unknownRegistrations.length ? <ul className="calendar-registration-list calendar-unknown-list">{unknownRegistrations.map(task => <RegistrationTask key={task.id} task={task} project={projectFor(task)} onOpen={onTaskOpen} />)}</ul> : <p className="calendar-quiet-empty">当前筛选的任务都有可靠的首次登记日。</p>}</section>
    </div>}

    {data && selection.mode === "projects" && <div className="calendar-project-view"><div className="calendar-cycle-intro"><h2>每个项目，都有自己的进程</h2><p>自动展示全部任务。口述完成记录表示报告被记录的日期，不代表核实的实际完成时间。缺少进展日期时，先按首次登记定位并明确标注。</p><div className="calendar-legend"><span><i className="calendar-legend-actual" />明确的项目周期</span><span><i className="calendar-legend-planned" />计划 / 登记观察范围</span><span><i className="calendar-legend-recorded" />口述完成记录</span><span><i className="calendar-legend-registration" />首次登记定位</span></div></div>
      {!filteredProjects.length && <div className="calendar-empty"><FolderClosed size={28} aria-hidden="true" /><h3>还没有可展示的项目周期</h3><p>项目和任务读回后会出现在这里。</p></div>}
      {filteredProjects.map(project => {
        const nodes = nodesByProject.get(project.id) || [], dated = nodes.filter(node => node.date), undated = nodes.filter(node => !node.date);
        const actualStart = isCalendarDate(project.start_date) ? project.start_date : null;
        const observedStart = actualStart ? null : registrationDate(project);
        const start = actualStart || observedStart;
        const plannedEnd = isCalendarDate(project.target_end_date) ? project.target_end_date : null;
        const actualEnd = isCalendarDate(project.completed_date) ? project.completed_date : null;
        const spanStyle = (end: string) => ({ left: `${Math.min(position(start!), position(end))}%`, width: `${Math.abs(position(end) - position(start!))}%` });
        return <article className="calendar-cycle-card" aria-label={`项目周期：${project.name}`} key={project.id}>
          <div className="calendar-cycle-heading"><div><span className="calendar-eyebrow">{project.status === "archived" ? "已归档项目" : project.status === "paused" ? "暂停中的项目" : "项目周期"}</span><button type="button" className="calendar-project-name" aria-label={`查看日历项目：${project.name}`} onClick={() => onProjectOpen(project.id)}>{project.name}<ChevronRight size={20} aria-hidden="true" /></button><p>{nodes.length} 个任务节点 · {undated.length} 项节点日期待补</p></div><button type="button" className="calendar-button" aria-label={`补充项目周期：${project.name}`} onClick={() => onEditProject(project.id)}>补充周期</button></div>
          <dl className="calendar-project-dates"><div><dt>实际进场</dt><dd><DateValue value={actualStart} /></dd></div><div><dt>计划结束</dt><dd><DateValue value={plannedEnd} /></dd></div><div><dt>实际完成</dt><dd><DateValue value={actualEnd} /></dd></div>{observedStart && <div className="calendar-observed-start"><dt>登记观察起点</dt><dd><DateValue value={observedStart} /><small>首次登记观察，不是实际进场</small></dd></div>}</dl>
          {extent && (start || plannedEnd || actualEnd || dated.length > 0) && <div className="calendar-cycle-chart" aria-label={`${project.name}的日期节点`}>
            <div className="calendar-cycle-axis" aria-hidden="true"><span>项目与任务节点</span><div>{ticks.map((date, index) => <span style={{ left: `${index * 100 / (ticks.length - 1 || 1)}%` }} key={date}>{axisCrossesYear ? `${Number(date.slice(0, 4))}/${Number(date.slice(5, 7))}` : shortDate(date)}</span>)}</div></div>
            <div className="calendar-cycle-span"><span>{actualStart ? "实际进场" : observedStart ? "登记观察起点" : "起点待补"}<small>{start ? fullDate(start) : "尚无可靠起点"}</small></span><div className="calendar-project-track" aria-hidden="true">{start && plannedEnd && <i className="calendar-period calendar-period-planned" style={spanStyle(plannedEnd)} />}{start && actualEnd && <i className={`calendar-period${observedStart ? " calendar-period-observed" : ""}`} style={spanStyle(actualEnd)} />}{start && <i className="calendar-project-cap" style={{ left: `${position(start)}%` }} />}{plannedEnd && <i className="calendar-project-cap calendar-cap-planned" style={{ left: `${position(plannedEnd)}%` }} />}{actualEnd && <i className="calendar-project-cap calendar-cap-completed" style={{ left: `${position(actualEnd)}%` }} />}</div></div>
            {dated.length > 0 && <ol className="calendar-cycle-nodes">{dated.map(node => <li key={node.task.id}><button type="button" className={`calendar-cycle-node calendar-node-${node.kind}`} aria-label={`查看日历任务：${node.task.title}`} onClick={() => onTaskOpen(node.task.id)}><span className="calendar-node-copy"><span className="calendar-node-top"><span>{node.label}</span><Status task={node.task} /></span><strong>{node.task.title}</strong><span className="calendar-node-date"><time dateTime={node.date!}>{fullDate(node.date!)}</time>{node.task.dependencies.length > 0 && <span>前序 {node.task.dependencies.length} 项</span>}</span><span className="calendar-node-registration">首次登记：{registrationDate(node.task) ? <time dateTime={registrationDate(node.task)!}>{fullDate(registrationDate(node.task)!)}</time> : "未知"}{node.task.status === "done" && !toShanghaiDate(node.task.completed_at) ? " · 完成时刻未知" : ""}</span></span><span className="calendar-node-track" style={trackStyle(node.date!)} aria-hidden="true"><i /></span></button></li>)}</ol>}
          </div>}
          {!start && !plannedEnd && !actualEnd && !dated.length && <p className="calendar-quiet-empty">还没有可绘制的周期日期。打开任务核对日期，或补充项目周期。</p>}
          <section className="calendar-undated-nodes" aria-label={`${project.name}的节点日期待补`}><h3>节点日期待补 <span>{undated.length}</span></h3>{undated.length > 0 ? <ul>{undated.map(node => <li key={node.task.id}><button type="button" aria-label={`查看日历任务：${node.task.title}`} onClick={() => onTaskOpen(node.task.id)}><span><strong>{node.task.title}</strong><span>{node.label}{registrationDate(node.task) ? ` · 首次登记 ${fullDate(registrationDate(node.task)!)}` : " · 首次登记日也未知"}</span></span><Status task={node.task} /><ChevronRight size={18} aria-hidden="true" /></button></li>)}</ul> : <p>全部任务已在时间轴列出，登记节点的进展日期仍可补充。</p>}</section>
        </article>;
      })}
    </div>}
  </section>;
}
