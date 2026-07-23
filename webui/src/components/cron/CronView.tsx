import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CalendarClock,
  Clock,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { RefreshIconButton } from "@/components/ui/refresh-icon-button";
import { Textarea } from "@/components/ui/textarea";
import { ViewShell } from "@/components/ui/view-shell";
import {
  createCronJob,
  deleteCronJob,
  fetchCronJobs,
  toggleCronJob,
} from "@/lib/api";
import type {
  CronJobCreate,
  CronJobPayload,
  CronJobsPayload,
  CronScheduleKind,
} from "@/lib/types";
import { cn } from "@/lib/utils";

interface CronViewProps {
  onBack: () => void;
  token: string;
}

interface CreateForm {
  name: string;
  message: string;
  schedule: CronScheduleKind;
  everySeconds: string;
  cronExpr: string;
  tz: string;
  atMs: string;
  deliver: boolean;
  deleteAfterRun: boolean;
}

const EMPTY_FORM: CreateForm = {
  name: "",
  message: "",
  schedule: "every",
  everySeconds: "3600",
  cronExpr: "",
  tz: "system",
  atMs: "",
  deliver: false,
  deleteAfterRun: false,
};

function formatTimestamp(ms: number | null | undefined): string {
  if (!ms) return "—";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

type CronTFunc = (key: string, options?: Record<string, unknown>) => string;

function describeSchedule(job: CronJobPayload, t: CronTFunc): string {
  const s = job.schedule;
  if (s.kind === "every") {
    const seconds = (s.every_ms ?? 0) / 1000;
    if (seconds >= 3600 && seconds % 3600 === 0) {
      return t("cron.describeSchedule.everyHours", { count: seconds / 3600 });
    }
    if (seconds >= 60 && seconds % 60 === 0) {
      return t("cron.describeSchedule.everyMinutes", { count: seconds / 60 });
    }
    return t("cron.describeSchedule.everySeconds", { count: seconds });
  }
  if (s.kind === "cron") {
    const expr = s.expr ?? "?";
    if (s.tz && s.tz !== "system") {
      return t("cron.describeSchedule.cronWithTz", { expr, tz: s.tz });
    }
    return t("cron.describeSchedule.cron", { expr });
  }
  if (s.kind === "at") {
    return t("cron.describeSchedule.at", { timestamp: formatTimestamp(s.at_ms) });
  }
  return s.kind;
}

export function CronView({ onBack, token }: CronViewProps) {
  const { t } = useTranslation();
  const [payload, setPayload] = useState<CronJobsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchCronJobs(token);
      setPayload(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    if (saving) return;
    const name = form.name.trim();
    const message = form.message.trim();
    if (!name) {
      setFormError(t("cron.error.nameRequired"));
      return;
    }
    if (!message) {
      setFormError(t("cron.error.messageRequired"));
      return;
    }
    const create: CronJobCreate = {
      name,
      message,
      schedule: form.schedule,
      deliver: form.deliver,
      deleteAfterRun: form.deleteAfterRun,
    };
    if (form.schedule === "every") {
      const seconds = parseInt(form.everySeconds, 10);
      if (!Number.isFinite(seconds) || seconds < 60) {
        setFormError(t("cron.error.everySecondsInvalid"));
        return;
      }
      create.everySeconds = seconds;
    } else if (form.schedule === "cron") {
      if (!form.cronExpr.trim()) {
        setFormError(t("cron.error.cronExprRequired"));
        return;
      }
      create.cronExpr = form.cronExpr.trim();
      create.tz = form.tz.trim() || "system";
    } else if (form.schedule === "at") {
      const ms = parseInt(form.atMs, 10);
      if (!Number.isFinite(ms) || ms <= 0) {
        setFormError(t("cron.error.atMsInvalid"));
        return;
      }
      create.atMs = ms;
    }
    setSaving(true);
    setFormError(null);
    try {
      await createCronJob(token, create);
      setForm(EMPTY_FORM);
      setShowForm(false);
      await load();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (jobId: string) => {
    if (actingId) return;
    setActingId(jobId);
    try {
      await deleteCronJob(token, jobId);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActingId(null);
    }
  };

  const handleToggle = async (job: CronJobPayload) => {
    if (actingId) return;
    setActingId(job.id);
    try {
      await toggleCronJob(token, job.id, !job.enabled);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActingId(null);
    }
  };

  const jobs = payload?.jobs ?? [];
  const userJobs = jobs.filter((j) => !j.is_system);
  const systemJobs = jobs.filter((j) => j.is_system);

  return (
    <ViewShell
      onBack={onBack}
      icon={<CalendarClock className="h-4 w-4 text-foreground/80" />}
      title={t("cron.title")}
      actions={
        <>
          <RefreshIconButton onClick={load} loading={loading} />
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() => {
              setShowForm((v) => !v);
              setForm(EMPTY_FORM);
              setFormError(null);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("cron.create")}
          </Button>
        </>
      }
    >
      {loading && !payload ? (
        <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
          <LoadingSpinner />
          {t("cron.loading")}
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <p>{error}</p>
          <Button variant="outline" size="sm" onClick={load}>
            {t("cron.retry")}
          </Button>
        </div>
      ) : (
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {showForm ? (
            <CreateJobForm
              form={form}
              setForm={setForm}
              onSave={handleCreate}
              onCancel={() => {
                setShowForm(false);
                setForm(EMPTY_FORM);
                setFormError(null);
              }}
              saving={saving}
              error={formError}
            />
          ) : null}

          {userJobs.length === 0 && systemJobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <CalendarClock className="h-8 w-8 opacity-40" />
              <p>{t("cron.empty")}</p>
            </div>
          ) : null}

          {userJobs.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("cron.userJobs")}
              </h2>
              {userJobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  onToggle={() => handleToggle(job)}
                  onDelete={() => handleDelete(job.id)}
                  acting={actingId === job.id}
                />
              ))}
            </section>
          ) : null}

          {systemJobs.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("cron.systemJobs")}
              </h2>
              {systemJobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  onToggle={() => handleToggle(job)}
                  onDelete={() => handleDelete(job.id)}
                  acting={actingId === job.id}
                />
              ))}
            </section>
          ) : null}
        </div>
      )}
    </ViewShell>
  );
}

interface CreateJobFormProps {
  form: CreateForm;
  setForm: (updater: (prev: CreateForm) => CreateForm) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}

function CreateJobForm({
  form,
  setForm,
  onSave,
  onCancel,
  saving,
  error,
}: CreateJobFormProps) {
  const { t } = useTranslation();
  const scheduleOptions: Array<{ value: CronScheduleKind; label: string }> = [
    { value: "every", label: t("cron.schedule.every") },
    { value: "cron", label: t("cron.schedule.cron") },
    { value: "at", label: t("cron.schedule.at") },
  ];

  return (
    <div className="rounded-lg border bg-card p-4">
      <h2 className="mb-3 text-sm font-semibold">{t("cron.newJob")}</h2>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            {t("cron.field.name")}
          </label>
          <Input
            value={form.name}
            onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            placeholder={t("cron.field.namePlaceholder")}
            className="h-8"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            {t("cron.field.message")}
          </label>
          <Textarea
            value={form.message}
            onChange={(e) => setForm((p) => ({ ...p, message: e.target.value }))}
            placeholder={t("cron.field.messagePlaceholder")}
            rows={3}
            className="resize-none"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            {t("cron.field.schedule")}
          </label>
          <div className="flex flex-wrap gap-1.5">
            {scheduleOptions.map((opt) => (
              <Button
                key={opt.value}
                type="button"
                variant={form.schedule === opt.value ? "default" : "outline"}
                size="sm"
                className="h-7"
                onClick={() => setForm((p) => ({ ...p, schedule: opt.value }))}
              >
                {opt.label}
              </Button>
            ))}
          </div>
          {form.schedule === "every" ? (
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={60}
                value={form.everySeconds}
                onChange={(e) =>
                  setForm((p) => ({ ...p, everySeconds: e.target.value }))
                }
                className="h-8 w-32"
              />
              <span className="text-xs text-muted-foreground">
                {t("cron.field.everySecondsHint")}
              </span>
            </div>
          ) : null}
          {form.schedule === "cron" ? (
            <div className="flex flex-col gap-1.5">
              <Input
                value={form.cronExpr}
                onChange={(e) =>
                  setForm((p) => ({ ...p, cronExpr: e.target.value }))
                }
                placeholder={t("cron.field.cronExprPlaceholder")}
                className="h-8"
              />
              <Input
                value={form.tz}
                onChange={(e) => setForm((p) => ({ ...p, tz: e.target.value }))}
                placeholder={t("cron.field.tzPlaceholder")}
                className="h-8"
              />
            </div>
          ) : null}
          {form.schedule === "at" ? (
            <div className="flex items-center gap-2">
              <Input
                type="datetime-local"
                onChange={(e) => {
                  const v = e.target.value;
                  const ms = v ? new Date(v).getTime() : NaN;
                  setForm((p) => ({
                    ...p,
                    atMs: Number.isFinite(ms) ? String(ms) : "",
                  }));
                }}
                className="h-8 w-48"
              />
              <span className="text-xs text-muted-foreground">
                {t("cron.field.atHint")}
              </span>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={form.deliver}
              onChange={(e) =>
                setForm((p) => ({ ...p, deliver: e.target.checked }))
              }
              className="h-3.5 w-3.5"
            />
            {t("cron.field.deliver")}
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={form.deleteAfterRun}
              onChange={(e) =>
                setForm((p) => ({ ...p, deleteAfterRun: e.target.checked }))
              }
              className="h-3.5 w-3.5"
            />
            {t("cron.field.deleteAfterRun")}
          </label>
        </div>

        {error ? (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5" />
            {error}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
            {t("cron.cancel")}
          </Button>
          <Button size="sm" onClick={onSave} disabled={saving}>
            {saving ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : null}
            {t("cron.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface JobCardProps {
  job: CronJobPayload;
  onToggle: () => void;
  onDelete: () => void;
  acting: boolean;
}

function JobCard({ job, onToggle, onDelete, acting }: JobCardProps) {
  const { t } = useTranslation();
  const scheduleText = describeSchedule(job, t);
  const nextRun = formatTimestamp(job.state.next_run_at_ms);
  const lastRun = formatTimestamp(job.state.last_run_at_ms);

  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-3 transition-colors",
        !job.enabled && "opacity-60",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{job.name}</span>
            {job.is_system ? (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("cron.badge.system")}
              </span>
            ) : null}
            {!job.enabled ? (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("cron.badge.disabled")}
              </span>
            ) : null}
          </div>
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {job.payload.message}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {scheduleText}
            </span>
            <span>
              {t("cron.nextRun")}: {nextRun}
            </span>
            {job.state.last_run_at_ms ? (
              <span>
                {t("cron.lastRun")}: {lastRun}
                {job.state.last_status ? ` (${job.state.last_status})` : ""}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onToggle}
            disabled={acting}
          >
            {job.enabled ? t("cron.disable") : t("cron.enable")}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            disabled={acting || job.is_system}
            title={job.is_system ? t("cron.protectedHint") : t("cron.delete")}
          >
            {acting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
