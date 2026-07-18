import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  Activity,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Cpu,
  Database,
  Eye,
  EyeOff,
  FileText,
  Gem,
  Globe2,
  Grid3X3,
  HardDrive,
  Hexagon,
  Layers,
  Loader2,
  LogOut,
  Moon,
  Plus,
  Orbit,
  Palette,
  Pencil,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Triangle,
  Trash2,
  Waves,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  createModelConfiguration,
  deleteModelConfiguration,
  deleteProviderSettings,
  fetchProviderModels,
  fetchSettings,
  loginProviderOAuth,
  logoutProviderOAuth,
  readBootstrapFile,
  saveBootstrapFile,
  updateModelConfiguration,
  updateNetworkSafetySettings,
  updateProviderSettings,
  updateRuntimeSettings,
  updateSettings,
} from "@/lib/api";
import { getHostApi } from "@/lib/runtime";
import {
  providerBrand,
  providerDisplayLabel,
} from "@/lib/provider-brand";
import { cn } from "@/lib/utils";
import { STORAGE_KEYS } from "@/lib/storage";
import { useClient } from "@/providers/ClientProvider";
import type { ThemeMode } from "@/hooks/useTheme";
import type {
  NetworkSafetySettingsUpdate,
  RuntimeSettingsUpdate,
  SettingsPayload,
  WebuiDefaultAccessMode,
} from "@/lib/types";

export type SettingsSectionKey =
  | "overview"
  | "appearance"
  | "models"
  | "browser"
  | "advanced";

type LocalDensity = "comfortable" | "compact";
type LocalActivityMode = "auto" | "expanded";
interface LocalPreferences {
  density: LocalDensity;
  activityMode: LocalActivityMode;
  codeWrap: boolean;
  brandLogos: boolean;
}

interface AgentSettingsDraft {
  model: string;
  provider: string;
  modelPreset: string;
  presetLabel: string;
  toolHintMaxLength: number;
}

interface ModelConfigurationDraft {
  label: string;
  provider: string;
  model: string;
}

type PendingRestartSection = "runtime" | "browser";
type PendingRestartSections = Record<PendingRestartSection, boolean>;
type RestartAwarePayload = {
  requires_restart?: boolean;
  surface?: SettingsPayload["surface"];
  runtime_surface?: SettingsPayload["runtime_surface"];
  runtime_capabilities?: SettingsPayload["runtime_capabilities"];
};
type ProviderApiType = "auto" | "chat_completions" | "responses";
type ProviderForm = { apiKey: string; apiBase: string; apiType: ProviderApiType; model: string };

const LOCAL_PREFS_STORAGE_KEY = STORAGE_KEYS.settingsPreferences;

const DEFAULT_LOCAL_PREFS: LocalPreferences = {
  density: "comfortable",
  activityMode: "auto",
  codeWrap: true,
  brandLogos: true,
};
const OPENAI_API_TYPE_OPTIONS: Array<{ value: ProviderApiType; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "chat_completions", label: "Chat Completions" },
  { value: "responses", label: "Responses" },
];

const LOCAL_UNCONFIGURED_PROVIDER_ORDER = new Map(
  ["vllm", "ollama", "lm_studio", "atomic_chat", "ovms"].map((name, index) => [
    name,
    index,
  ]),
);
const EMPTY_PENDING_RESTART_SECTIONS: PendingRestartSections = {
  runtime: false,
  browser: false,
};

interface SettingsViewProps {
  themeMode: ThemeMode;
  initialSection?: SettingsSectionKey;
  showSidebar?: boolean;
  onSetThemeMode: (mode: ThemeMode) => void;
  onBackToChat: () => void;
  onModelNameChange: (modelName: string | null) => void;
  onSettingsChange?: (payload: SettingsPayload) => void;
  onLogout?: () => void;
  onRestart?: () => void;
  isRestarting?: boolean;
  hostChromeInset?: boolean;
}

function readLocalPreferences(): LocalPreferences {
  try {
    const raw = window.localStorage.getItem(LOCAL_PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_LOCAL_PREFS;
    const parsed = JSON.parse(raw) as Partial<LocalPreferences>;
    return {
      density: parsed.density === "compact" ? "compact" : "comfortable",
      activityMode: parsed.activityMode === "expanded" ? "expanded" : "auto",
      codeWrap: parsed.codeWrap !== false,
      brandLogos: parsed.brandLogos !== false,
    };
  } catch {
    return DEFAULT_LOCAL_PREFS;
  }
}

function modelPresetValue(payload: SettingsPayload): string {
  return payload.agent.model_preset || "default";
}

function defaultPreset(payload: SettingsPayload): SettingsPayload["model_presets"][number] | null {
  return payload.model_presets.find((preset) => preset.is_default) ?? null;
}

function editableDefaultProvider(payload: SettingsPayload): string {
  const base = defaultPreset(payload);
  return base?.provider ?? payload.agent.provider ?? payload.agent.resolved_provider ?? "";
}

export function SettingsView({
  themeMode,
  initialSection = "overview",
  showSidebar = true,
  onSetThemeMode,
  onBackToChat,
  onModelNameChange,
  onSettingsChange,
  onLogout,
  onRestart,
  isRestarting = false,
  hostChromeInset = false,
}: SettingsViewProps) {
  const { t } = useTranslation();
  const { token } = useClient();
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [contextWindowLearning, setContextWindowLearning] = useState(false);
  // 记录正在学习上下文窗口的 provider 名称(用于 provider 卡片显示"查询中")
  const [learningProvider, setLearningProvider] = useState<string | null>(null);
  // 记录学习超时的 provider 名称(用于 provider 卡片显示"查询超时")
  const [timeoutProvider, setTimeoutProvider] = useState<string | null>(null);
  // 轮询超时标志,提示用户手动输入上下文窗口大小
  const [contextWindowLearnTimeout, setContextWindowLearnTimeout] = useState(false);
  // 取消上一次上下文窗口学习轮询的标志
  const learningPollCancelRef = useRef<boolean>(false);
  const [modelConfigurationOpen, setModelConfigurationOpen] = useState(false);
  const [modelConfigurationSaving, setModelConfigurationSaving] = useState(false);
  const [modelConfigurationForm, setModelConfigurationForm] = useState<ModelConfigurationDraft>({
    label: "",
    provider: "",
    model: "",
  });
  const [providerSaving, setProviderSaving] = useState<string | null>(null);
  const [providerSaved, setProviderSaved] = useState<Record<string, boolean>>({});
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  const [providerModelsLoading, setProviderModelsLoading] = useState<string | null>(null);
  // 删除 provider 配置的确认对话框 + 进行中状态
  const [providerToDelete, setProviderToDelete] = useState<string | null>(null);
  const [providerDeleting, setProviderDeleting] = useState(false);
  // custom provider 新配置的 label(每个 custom 配置是一个独立 model_preset)
  const [customPresetLabel, setCustomPresetLabel] = useState("");
  const [networkSafetySaving, setNetworkSafetySaving] = useState(false);
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [runtimeForm, setRuntimeForm] = useState<RuntimeSettingsUpdate>({
    heartbeatIntervalS: 1800,
    dreamIntervalH: 2,
  });
  const [hostEngineApplying, setHostEngineApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSectionKey>(initialSection);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [providerForms, setProviderForms] = useState<Record<string, ProviderForm>>({});
  const [visibleProviderKeys, setVisibleProviderKeys] = useState<Record<string, boolean>>({});
  const [editingProviderKeys, setEditingProviderKeys] = useState<Record<string, boolean>>({});
  const [pendingRestartSections, setPendingRestartSections] = useState<PendingRestartSections>(
    EMPTY_PENDING_RESTART_SECTIONS,
  );
  const [localPrefs, setLocalPrefs] = useState<LocalPreferences>(() => readLocalPreferences());
  const [networkSafetyForm, setNetworkSafetyForm] = useState<NetworkSafetySettingsUpdate>({
    webuiAllowLocalServiceAccess: true,
    webuiDefaultAccessMode: "default",
  });

  useEffect(() => {
    setActiveSection(initialSection);
  }, [initialSection]);
  const [form, setForm] = useState<AgentSettingsDraft>({
    model: "",
    provider: "",
    modelPreset: "default",
    presetLabel: "Default",
    toolHintMaxLength: 40,
  });

  const text = useCallback(
    (key: string, fallback: string, options?: Record<string, unknown>) =>
      t(key, { defaultValue: fallback, ...(options ?? {}) }),
    [t],
  );

  const applyPayload = useCallback((payload: SettingsPayload) => {
    const fallbackDefault = defaultPreset(payload);
    const activePresetName = modelPresetValue(payload);
    const activePreset =
      payload.model_presets.find((preset) => preset.name === activePresetName) ?? fallbackDefault;
    setSettings(payload);
    setForm({
      model: activePreset?.model ?? payload.agent.model,
      provider: activePreset?.is_default
        ? editableDefaultProvider(payload)
        : activePreset?.provider ?? editableDefaultProvider(payload),
      modelPreset: activePresetName,
      presetLabel: activePreset?.label ?? activePresetName,
      toolHintMaxLength: payload.agent.tool_hint_max_length,
    });
    setNetworkSafetyForm({
      webuiAllowLocalServiceAccess: payload.advanced.webui_allow_local_service_access ?? payload.advanced.allow_local_preview_access ?? true,
      webuiDefaultAccessMode: visibleWebuiDefaultAccessMode(payload.advanced.webui_default_access_mode),
    });
    setRuntimeForm({
      heartbeatIntervalS: payload.runtime.heartbeat.interval_s,
      dreamIntervalH: parseDreamIntervalHours(payload.runtime.dream.schedule),
    });
    if (payload.restart_required_sections) {
      setPendingRestartSections({
        runtime: payload.restart_required_sections.includes("runtime"),
      browser: payload.restart_required_sections.includes("browser"),
    });
    }
    onSettingsChange?.(payload);
  }, [onSettingsChange]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSettings(token)
      .then((payload) => {
        if (!cancelled) {
          applyPayload(payload);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyPayload, token]);

  useEffect(() => {
    try {
      window.localStorage.setItem(LOCAL_PREFS_STORAGE_KEY, JSON.stringify(localPrefs));
    } catch {
      // Browser-only preferences should never block settings.
    }
  }, [localPrefs]);

  const settingsProviders = settings?.providers;
  const settingsModelPresets = settings?.model_presets;
  const settingsAgent = settings?.agent;
  const settingsAdvanced = settings?.advanced;
  const settingsRuntime = settings?.runtime;

  useEffect(() => {
    if (!settingsProviders || !settingsModelPresets || !settingsAgent) return;
    setProviderForms((prev) => {
      const next = { ...prev };
      for (const provider of settingsProviders) {
        if (provider.preset_name) {
          // preset 卡片(已配置区域):用 preset 的 model/api_base 初始化。
          // 适用于所有 preset(无论 is_custom_preset 与否),让卡片表单跟随 preset。
          const preset = settingsModelPresets.find((p) => p.name === provider.preset_name);
          const existing = next[provider.name];
          next[provider.name] = {
            apiKey: existing?.apiKey ?? "",
            apiBase: existing?.apiBase || preset?.api_base || provider.api_base || "",
            apiType: "auto",
            // 当 existing.model 为空字符串(被清空过)时,回退到 preset 的 model
            model: existing?.model || preset?.model || provider.model || "",
          };
          continue;
        }
        // Find the model associated with this provider: check active preset first,
        // then any preset using this provider, then the agent default model.
        const activePreset = settingsModelPresets.find((p) => p.active);
        const matchingPreset =
          activePreset && (activePreset.provider === provider.name || (activePreset.is_default && settingsAgent.provider === provider.name))
            ? activePreset
            : settingsModelPresets.find((p) => !p.is_default && p.provider === provider.name);
        const inferredModel =
          prev[provider.name]?.model ??
          (matchingPreset ? matchingPreset.model : "") ??
          (settingsAgent.provider === provider.name ? settingsAgent.model : "") ??
          "";
        next[provider.name] = {
          apiKey: next[provider.name]?.apiKey ?? "",
          // custom 单例是添加入口,不预填旧值(每次都是新配置)
          apiBase: next[provider.name]?.apiBase ??
            (provider.name === "custom" ? "" : (provider.api_base ?? provider.default_api_base ?? "")),
          apiType: next[provider.name]?.apiType ?? provider.api_type ?? "auto",
          model: provider.name === "custom" ? (next[provider.name]?.model ?? "") : inferredModel,
        };
      }
      return next;
    });
    // Mark already-configured providers as saved on initial load / refresh.
    setProviderSaved((prev) => {
      const next = { ...prev };
      for (const provider of settingsProviders) {
        if (next[provider.name] === undefined) {
          next[provider.name] = provider.configured;
        }
      }
      return next;
    });
  }, [settingsProviders, settingsModelPresets, settingsAgent]);

  useEffect(() => {
    try {
      localStorage.removeItem(STORAGE_KEYS.providerModels);
    } catch {
      // ignore
    }
  }, []);

  const modelDirty = useMemo(() => {
    if (!settings) return false;
    // model/provider 都跟随 preset,只需比较 preset name
    return form.modelPreset !== modelPresetValue(settings);
  }, [form, settings]);

  const networkSafetyDirty = useMemo(() => {
    if (!settingsAdvanced) return false;
    const currentLocalServiceAccess =
      settingsAdvanced.webui_allow_local_service_access ?? settingsAdvanced.allow_local_preview_access ?? true;
    const currentDefaultAccess = visibleWebuiDefaultAccessMode(settingsAdvanced.webui_default_access_mode);
    return (
      networkSafetyForm.webuiAllowLocalServiceAccess !== currentLocalServiceAccess ||
      networkSafetyForm.webuiDefaultAccessMode !== currentDefaultAccess
    );
  }, [networkSafetyForm, settingsAdvanced]);

  const runtimeDirty = useMemo(() => {
    if (!settingsRuntime) return false;
    return (
      runtimeForm.heartbeatIntervalS !== settingsRuntime.heartbeat.interval_s ||
      runtimeForm.dreamIntervalH !== parseDreamIntervalHours(settingsRuntime.dream.schedule)
    );
  }, [runtimeForm, settingsRuntime]);

  const configuredModelProviderOptions = useMemo(
    () =>
      settingsProviders
        ?.filter((provider) => provider.configured)
        .map((provider) => ({ name: provider.name, label: provider.label })) ?? [],
    [settingsProviders],
  );

  const hasPendingRestart = useMemo(
    () =>
      !!settings?.requires_restart ||
      pendingRestartSections.runtime ||
      pendingRestartSections.browser,
    [pendingRestartSections, settings?.requires_restart],
  );

  const restartViaSettingsSurface = useCallback(async () => {
    const isNativeHost = (settings?.surface ?? settings?.runtime_surface) === "native";
    const hostApi = getHostApi();
    if (isNativeHost && settings?.runtime_capabilities?.can_restart_engine && hostApi) {
      setHostEngineApplying(true);
      try {
        await hostApi.restartEngine();
        const payload = await fetchSettings(token);
        applyPayload(payload);
        setPendingRestartSections(EMPTY_PENDING_RESTART_SECTIONS);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setHostEngineApplying(false);
      }
      return;
    }
    onRestart?.();
  }, [applyPayload, onRestart, settings, token]);

  const maybeRestartHostEngine = useCallback(
    async (payload: RestartAwarePayload) => {
      const surface = payload.surface ?? payload.runtime_surface ?? settings?.surface ?? settings?.runtime_surface;
      const capabilities = payload.runtime_capabilities ?? settings?.runtime_capabilities;
      const isNativeHost = surface === "native";
      const hostApi = getHostApi();
      if (!payload.requires_restart || !isNativeHost || !capabilities?.can_restart_engine || !hostApi) {
        return;
      }
      setHostEngineApplying(true);
      try {
        await hostApi.restartEngine();
        const refreshed = await fetchSettings(token);
        applyPayload(refreshed);
        setPendingRestartSections(EMPTY_PENDING_RESTART_SECTIONS);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setHostEngineApplying(false);
      }
    },
    [applyPayload, settings, token],
  );

  // 轮询 settings,直到目标模型的上下文窗口学习完成(status 变为 learned/configured)
  // 或超过最大轮询次数(超时后强制刷新一次并清除"查询中"状态,设置超时提示)
  // providerName 用于在 provider 卡片显示超时提示(模型保存路径传 null)
  const pollContextWindowLearning = useCallback(
    async (modelName: string, providerName: string | null = null) => {
      learningPollCancelRef.current = false;
      // 60 秒超时(40 次 * 1.5 秒),覆盖 HF/ModelScope 查询延迟
      const maxAttempts = 40;
      const intervalMs = 1500;
      for (let i = 0; i < maxAttempts; i++) {
        if (learningPollCancelRef.current) return;
        await new Promise((r) => setTimeout(r, intervalMs));
        if (learningPollCancelRef.current) return;
        try {
          const fresh = await fetchSettings(token);
          if (learningPollCancelRef.current) return;
          // 优先看 active model(agent),因为保存后新模型就是 active model;
          // 否则回退到 model_presets 中同名 preset
          let status: string = "unknown";
          if (fresh.agent.model === modelName) {
            status = fresh.agent.resolved_context_window_status ?? "unknown";
          } else {
            const preset = fresh.model_presets.find((p) => p.model === modelName);
            status = preset?.resolved_context_window_status ?? "unknown";
          }
          // 学习成功或用户已手动配置 → 完成
          if (status === "learned" || status === "configured") {
            applyPayload(fresh);
            setContextWindowLearning(false);
            setLearningProvider(null);
            setTimeoutProvider(null);
            return;
          }
          // 期间持续刷新,让 UI 反映最新状态
          applyPayload(fresh);
        } catch {
          // 轮询期间的错误忽略,继续重试
        }
      }
      // 超时:最后刷新一次并清除"查询中"状态,设置超时标志提示用户手动输入
      try {
        const fresh = await fetchSettings(token);
        if (!learningPollCancelRef.current) applyPayload(fresh);
      } catch {
        // 忽略
      }
      if (!learningPollCancelRef.current) {
        setContextWindowLearning(false);
        setLearningProvider(null);
        setContextWindowLearnTimeout(true);
        setTimeoutProvider(providerName);
      }
    },
    [applyPayload, token],
  );

  const saveModelSettings = async () => {
    if (!settings || !modelDirty || saving) return;
    // 后端在模型变更时会调用 _trigger_model_learning 触发上下文窗口学习
    // 仅当目标模型尚未学习成功时,后端才实际查询 HF(已学习的从缓存返回)
    const modelChanged = form.model !== settings.agent.model;
    const matchingPreset = settings.model_presets.find((p) => p.model === form.model);
    const targetStatus = matchingPreset?.resolved_context_window_status ?? "unknown";
    const willQueryContext = modelChanged && targetStatus === "unknown";
    // 取消上一次可能仍在进行的轮询
    learningPollCancelRef.current = true;
    setSaving(true);
    setContextWindowLearning(willQueryContext);
    if (willQueryContext) {
      setContextWindowLearnTimeout(false);
      setTimeoutProvider(null);
      setLearningProvider(null);
    }
    try {
      // 切换 preset 即可激活对应配置(model/provider/凭证都绑定在 preset 上)
      const payload: SettingsPayload = await updateSettings(token, {
        modelPreset: form.modelPreset,
      });
      applyPayload(payload);
      onModelNameChange(payload.agent.model || null);
      setError(null);
      // 后端 _trigger_model_learning 是 fire-and-forget,HTTP 立即返回。
      // 若触发了学习,启动轮询持续显示"查询中",直到后端学习完成。
      if (willQueryContext) {
        pollContextWindowLearning(form.model);
      } else {
        setContextWindowLearning(false);
      }
    } catch (err) {
      setError((err as Error).message);
      setContextWindowLearning(false);
    } finally {
      setSaving(false);
    }
  };

  // 单独保存上下文窗口大小,用于在 HF 查询失败时让用户手动设置
  const saveContextWindow = useCallback(
    async (value: number) => {
      if (!settings) return;
      const selectedPreset = settings.model_presets.find((preset) => preset.name === form.modelPreset);
      let payload: SettingsPayload;
      if (selectedPreset && !selectedPreset.is_default) {
        payload = await updateModelConfiguration(token, {
          name: selectedPreset.name,
          contextWindowTokens: value,
        });
      } else {
        payload = await updateSettings(token, {
          modelPreset: form.modelPreset,
          contextWindowTokens: value,
        });
      }
      applyPayload(payload);
      setError(null);
    },
    [applyPayload, settings, token, form.modelPreset],
  );

  const openModelConfigurationDialog = () => {
    if (!settings) return;
    const currentProvider = settings.agent.provider;
    const provider =
      configuredModelProviderOptions.find((option) => option.name === currentProvider)?.name ??
      configuredModelProviderOptions[0]?.name ??
      "";
    setModelConfigurationForm({
      label: "",
      provider,
      model: "",
    });
    setModelConfigurationOpen(true);
  };

  const handleCreateModelConfiguration = async () => {
    if (modelConfigurationSaving) return;
    const label = modelConfigurationForm.label.trim();
    const provider = modelConfigurationForm.provider.trim();
    const model = modelConfigurationForm.model.trim();
    if (!label || !provider || !model) return;
    setModelConfigurationSaving(true);
    try {
      const payload = await createModelConfiguration(token, {
        label,
        provider,
        model,
      });
      applyPayload(payload);
      onModelNameChange(payload.agent.model || null);
      setModelConfigurationOpen(false);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setModelConfigurationSaving(false);
    }
  };

  const saveNetworkSafetySettings = async () => {
    if (!settings || !networkSafetyDirty || networkSafetySaving) return;
    setNetworkSafetySaving(true);
    try {
      const payload = await updateNetworkSafetySettings(token, networkSafetyForm);
      applyPayload(payload);
      if (payload.requires_restart) {
        setPendingRestartSections((prev) => ({ ...prev, runtime: true }));
      }
      await maybeRestartHostEngine(payload);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setNetworkSafetySaving(false);
    }
  };

  const saveRuntimeSettings = async () => {
    if (!settings || !runtimeDirty || runtimeSaving) return;
    setRuntimeSaving(true);
    try {
      const payload = await updateRuntimeSettings(token, runtimeForm);
      applyPayload(payload);
      if (payload.requires_restart) {
        setPendingRestartSections((prev) => ({ ...prev, runtime: true }));
      }
      await maybeRestartHostEngine(payload);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRuntimeSaving(false);
    }
  };

  const saveProvider = async (providerName: string) => {
    if (providerSaving) return;
    const provider = settings?.providers.find((item) => item.name === providerName);
    if (!provider) return;
    if (provider.auth_type === "oauth") return;
    const providerForm = providerForms[providerName] ?? { apiKey: "", apiBase: "", apiType: "auto", model: "" };
    const apiKey = providerForm.apiKey.trim();
    const apiKeyRequired = provider.api_key_required ?? true;
    if (!provider.configured && apiKeyRequired && !apiKey) {
      setError(t("settings.byok.apiKeyRequired"));
      return;
    }
    const modelId = providerForm.model.trim();
    // 预测:更换模型且目标模型尚未学习成功 → 后端会触发 HF 上下文窗口学习
    const modelChanged = !!modelId && modelId !== (settings?.agent.model ?? "");
    const matchingPreset = settings?.model_presets.find((p) => p.model === modelId);
    const targetStatus = matchingPreset?.resolved_context_window_status ?? "unknown";
    const willQueryContext = modelChanged && targetStatus === "unknown";
    if (willQueryContext) {
      learningPollCancelRef.current = true;
      setLearningProvider(providerName);
      setTimeoutProvider(null);
      setContextWindowLearning(true);
      setContextWindowLearnTimeout(false);
    }
    setProviderSaving(providerName);
    try {
      let payload: SettingsPayload;
      if (provider.preset_name) {
        // preset 卡片(已配置区域):走 model-configuration update API
        // 适用于所有 preset(无论 is_custom_preset 与否):
        // - custom preset (custom__<name>): 凭证由 preset 自带
        // - 非 custom preset (<provider>__<name>): 凭证可能由 preset 携带或回退到 provider 单例,
        //   但更新时统一写到 preset 字段(让 preset 成为配置的源)
        payload = await updateModelConfiguration(token, {
          name: provider.preset_name,
          model: modelId || undefined,
          apiKey: apiKey || undefined,
          apiBase: providerForm.apiBase.trim() || undefined,
        });
      } else {
        payload = await updateProviderSettings(token, {
          provider: providerName,
          apiKey: apiKey || undefined,
          apiBase: providerForm.apiBase.trim(),
          apiType: providerForm.apiType,
        });
        // If a model ID was entered, also set it as the active model+provider
        // so the user doesn't have to jump to the Models section separately.
        if (modelId) {
          payload = await updateSettings(token, {
            provider: providerName,
            model: modelId,
          });
        }
      }
      applyPayload(payload);
      onModelNameChange(payload.agent.model || null);
      if (payload.requires_restart) {
        setPendingRestartSections((prev) => ({ ...prev, runtime: true }));
      }
      await maybeRestartHostEngine(payload);
      setProviderForms((prev) => ({
        ...prev,
        [providerName]: {
          apiKey: "",
          apiBase: providerForm.apiBase.trim(),
          apiType: providerForm.apiType,
          model: modelId,
        },
      }));
      setVisibleProviderKeys((prev) => ({ ...prev, [providerName]: false }));
      setEditingProviderKeys((prev) => ({ ...prev, [providerName]: false }));
      setProviderSaved((prev) => ({ ...prev, [providerName]: true }));
      setProviderModels((prev) => {
        if (!(providerName in prev)) return prev;
        const next = { ...prev };
        delete next[providerName];
        return next;
      });
      // 保存成功后收起卡片:配置已完成,已配置区域的卡片默认应是收起状态。
      // 注意:轮询(ContextWindowBadge 也会显示"查询中")不受影响,仍会持续。
      setExpandedProvider(null);
      setError(null);
      // 后端 _trigger_model_learning 是 fire-and-forget,启动轮询持续显示"查询中"
      if (willQueryContext) {
        pollContextWindowLearning(modelId, providerName);
      } else {
        setLearningProvider(null);
        setTimeoutProvider(null);
        setContextWindowLearning(false);
      }
    } catch (err) {
      setError((err as Error).message);
      setLearningProvider(null);
      setTimeoutProvider(null);
      setContextWindowLearning(false);
    } finally {
      setProviderSaving(null);
    }
  };

  // 删除 provider 配置:清除凭证 + 关联 model_preset,移回未配置区域。
  // 仅已配置(provider.configured)的卡片会显示删除入口。
  const confirmDeleteProvider = async () => {
    const providerName = providerToDelete;
    if (!providerName || providerDeleting) return;
    const provider = settings?.providers.find((item) => item.name === providerName);
    setProviderDeleting(true);
    try {
      // preset 卡片(已配置区域):走 model-configuration delete API 删除 preset。
      // 适用于所有 preset(无论 is_custom_preset 与否),让"已配置区域"成为配置的源:
      // 删除卡片即删除对应的 preset 注册信息,下拉列表会同步移除。
      const payload = provider?.preset_name
        ? await deleteModelConfiguration(token, provider.preset_name)
        : await deleteProviderSettings(token, providerName);
      applyPayload(payload);
      onModelNameChange(payload.agent.model || null);
      // 重置该 provider 的本地表单状态,避免展开时残留旧值
      resetProviderDraft(providerName);
      setProviderSaved((prev) => ({ ...prev, [providerName]: false }));
      setExpandedProvider(null);
      setProviderToDelete(null);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProviderDeleting(false);
    }
  };

  // 保存 custom provider 新配置:创建一个独立 model_preset(自带 api_key/api_base),
  // 不覆盖 config.providers.custom 单例,支持多个独立 custom endpoint。
  const saveCustomConfiguration = async () => {
    if (providerSaving) return;
    const form = providerForms["custom"] ?? { apiKey: "", apiBase: "", apiType: "auto", model: "" };
    const label = customPresetLabel.trim();
    const apiKey = form.apiKey.trim();
    const apiBase = form.apiBase.trim();
    const model = form.model.trim();
    if (!label) {
      setError(t("settings.byok.customLabelRequired", { defaultValue: "Label is required" }));
      return;
    }
    if (!apiBase) {
      setError(t("settings.byok.apiBaseRequired", { defaultValue: "API base is required" }));
      return;
    }
    if (!model) {
      setError(t("settings.byok.modelIdRequired", { defaultValue: "Model ID is required" }));
      return;
    }
    // 预测:目标模型尚未学习成功 → 后端会触发 HF 上下文窗口学习
    const matchingPreset = settings?.model_presets.find((p) => p.model === model);
    const targetStatus = matchingPreset?.resolved_context_window_status ?? "unknown";
    const willQueryContext = targetStatus === "unknown";
    if (willQueryContext) {
      learningPollCancelRef.current = true;
      setLearningProvider("custom");
      setTimeoutProvider(null);
      setContextWindowLearning(true);
      setContextWindowLearnTimeout(false);
    }
    setProviderSaving("custom");
    try {
      const payload = await createModelConfiguration(token, {
        label,
        provider: "custom",
        model,
        apiKey: apiKey || undefined,
        apiBase,
      });
      applyPayload(payload);
      onModelNameChange(payload.agent.model || null);
      // 清空 custom 表单,准备下一次添加
      setProviderForms((prev) => ({
        ...prev,
        custom: { apiKey: "", apiBase: "", apiType: "auto", model: "" },
      }));
      setCustomPresetLabel("");
      setVisibleProviderKeys((prev) => ({ ...prev, custom: false }));
      // custom 是添加入口,保存后保持 saved=false 以便连续添加新配置
      setProviderSaved((prev) => ({ ...prev, custom: false }));
      setExpandedProvider(null);
      setError(null);
      if (willQueryContext) {
        pollContextWindowLearning(model, "custom");
      } else {
        setLearningProvider(null);
        setTimeoutProvider(null);
        setContextWindowLearning(false);
      }
    } catch (err) {
      setError((err as Error).message);
      setLearningProvider(null);
      setTimeoutProvider(null);
      setContextWindowLearning(false);
    } finally {
      setProviderSaving(null);
    }
  };

  const fetchProviderModelList = async (providerName: string) => {
    if (providerModelsLoading) return;
    const provider = settings?.providers.find((item) => item.name === providerName);
    if (!provider) return;
    const providerForm = providerForms[providerName];
    // preset 卡片(已配置区域):后端用真实 provider 名查询模型,
    // 但用 preset 自带的 api_key/api_base(或回退到 provider 单例凭证)。
    // 适用于所有 preset(无论 is_custom_preset 与否)。
    const apiProviderName = provider.preset_name ? (provider.provider ?? providerName) : providerName;
    setProviderModelsLoading(providerName);
    try {
      const models = await fetchProviderModels(token, apiProviderName, {
        apiKey: providerForm?.apiKey.trim() || undefined,
        apiBase: providerForm?.apiBase.trim() || undefined,
      });
      setProviderModels((prev) => ({ ...prev, [providerName]: models }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      setProviderModels((prev) => ({ ...prev, [providerName]: [] }));
    } finally {
      setProviderModelsLoading(null);
    }
  };

  const runProviderOAuth = async (providerName: string, action: "login" | "logout") => {
    if (providerSaving) return;
    setProviderSaving(providerName);
    try {
      const payload =
        action === "login"
          ? await loginProviderOAuth(token, providerName)
          : await logoutProviderOAuth(token, providerName);
      applyPayload(payload);
      setExpandedProvider(providerName);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProviderSaving(null);
    }
  };

  const resetProviderDraft = useCallback((providerName: string) => {
    const provider = settingsProviders?.find((item) => item.name === providerName);
    if (!provider) return;
    // preset 卡片(已配置区域):用 preset 的 model/api_base 重置表单。
    // 适用于所有 preset(无论 is_custom_preset 与否)。
    if (provider.preset_name) {
      const preset = settingsModelPresets?.find((p) => p.name === provider.preset_name);
      setProviderForms((prev) => ({
        ...prev,
        [providerName]: {
          apiKey: "",
          apiBase: preset?.api_base || provider.api_base || "",
          apiType: "auto",
          model: preset?.model || provider.model || "",
        },
      }));
      setVisibleProviderKeys((prev) => ({ ...prev, [providerName]: false }));
      setEditingProviderKeys((prev) => ({ ...prev, [providerName]: false }));
      setProviderModels((prev) => {
        if (!(providerName in prev)) return prev;
        const next = { ...prev };
        delete next[providerName];
        return next;
      });
      return;
    }
    const activePreset = settingsModelPresets?.find((p) => p.active);
    const matchingPreset =
      activePreset && (activePreset.provider === providerName || (activePreset.is_default && settingsAgent?.provider === providerName))
        ? activePreset
        : settingsModelPresets?.find((p) => !p.is_default && p.provider === providerName);
    setProviderForms((prev) => ({
      ...prev,
      [providerName]: {
        apiKey: "",
        apiBase: provider.api_base ?? provider.default_api_base ?? "",
        apiType: provider.api_type ?? "auto",
        model: matchingPreset?.model ?? (settingsAgent?.provider === providerName ? (settingsAgent.model || "") : ""),
      },
    }));
    setVisibleProviderKeys((prev) => ({ ...prev, [providerName]: false }));
    setEditingProviderKeys((prev) => ({ ...prev, [providerName]: false }));
    setProviderModels((prev) => {
      if (!(providerName in prev)) return prev;
      const next = { ...prev };
      delete next[providerName];
      return next;
    });
  }, [settingsProviders, settingsModelPresets, settingsAgent]);

  const handleToggleProvider = useCallback((providerName: string) => {
    if (expandedProvider) resetProviderDraft(expandedProvider);
    if (expandedProvider === providerName) {
      setExpandedProvider(null);
    } else {
      setProviderModels((prev) => {
        if (!(providerName in prev)) return prev;
        const next = { ...prev };
        delete next[providerName];
        return next;
      });
      setExpandedProvider(providerName);
    }
  }, [expandedProvider, resetProviderDraft]);

  const toggleProviderKeyVisibility = (providerName: string) => {
    const isVisible = visibleProviderKeys[providerName];
    setVisibleProviderKeys((prev) => ({ ...prev, [providerName]: !isVisible }));
  };

  const toggleProviderKeyEditing = (providerName: string) => {
    setEditingProviderKeys((prev) => {
      const nextEditing = !prev[providerName];
      if (!nextEditing) {
        setProviderForms((forms) => ({
          ...forms,
          [providerName]: {
            apiKey: "",
            apiBase: forms[providerName]?.apiBase ?? "",
            apiType: forms[providerName]?.apiType ?? "auto",
            model: forms[providerName]?.model ?? "",
          },
        }));
        setVisibleProviderKeys((visible) => ({ ...visible, [providerName]: false }));
      }
      return { ...prev, [providerName]: nextEditing };
    });
  };

  const renderSection = () => {
    if (!settings) return null;
    switch (activeSection) {
      case "overview":
        return (
          <OverviewSettings
            settings={settings}
            requiresRestart={hasPendingRestart}
            onRestart={restartViaSettingsSurface}
            isRestarting={isRestarting || hostEngineApplying}
            showBrandLogos={localPrefs.brandLogos}
            onSelectSection={setActiveSection}
            runtimeForm={runtimeForm}
            runtimeDirty={runtimeDirty}
            runtimeSaving={runtimeSaving}
            onChangeRuntimeForm={setRuntimeForm}
            onSaveRuntime={saveRuntimeSettings}
          />
        );
      case "appearance":
        return (
          <AppearanceSettings
            themeMode={themeMode}
            onSetThemeMode={onSetThemeMode}
            localPrefs={localPrefs}
            onChangeLocalPrefs={setLocalPrefs}
          />
        );
      case "models":
        return (
          <div className="space-y-8">
            <ModelsSettings
              form={form}
              setForm={setForm}
              settings={settings}
              dirty={modelDirty}
              saving={saving}
              contextWindowLearning={contextWindowLearning}
              contextWindowLearnTimeout={contextWindowLearnTimeout}
              showBrandLogos={localPrefs.brandLogos}
              onSave={saveModelSettings}
              onSaveContextWindow={saveContextWindow}
              onCreateConfiguration={openModelConfigurationDialog}
            />
          <ProvidersSettings
              settings={settings}
              expandedProvider={expandedProvider}
              providerForms={providerForms}
              visibleProviderKeys={visibleProviderKeys}
              editingProviderKeys={editingProviderKeys}
              providerSaving={providerSaving}
              providerSaved={providerSaved}
              providerModels={providerModels}
              providerModelsLoading={providerModelsLoading}
              learningProvider={learningProvider}
              timeoutProvider={timeoutProvider}
              showBrandLogos={localPrefs.brandLogos}
              onToggleProvider={handleToggleProvider}
              onToggleProviderKey={toggleProviderKeyVisibility}
              onToggleProviderKeyEditing={toggleProviderKeyEditing}
              onChangeProviderForm={(provider, value) => {
                setProviderForms((prev) => ({
                  ...prev,
                  [provider]: {
                    apiKey: prev[provider]?.apiKey ?? "",
                    apiBase: prev[provider]?.apiBase ?? "",
                    apiType: prev[provider]?.apiType ?? "auto",
                    model: prev[provider]?.model ?? "",
                    ...value,
                  },
                }));
                setProviderSaved((prev) => ({ ...prev, [provider]: false }));
              }}
              onSaveProvider={saveProvider}
              onFetchProviderModels={fetchProviderModelList}
              onProviderOAuthLogin={(provider) => runProviderOAuth(provider, "login")}
              onProviderOAuthLogout={(provider) => runProviderOAuth(provider, "logout")}
              onRequestDeleteProvider={(provider) => setProviderToDelete(provider)}
              customPresetLabel={customPresetLabel}
              onChangeCustomPresetLabel={setCustomPresetLabel}
              onSaveCustomConfiguration={saveCustomConfiguration}
            />
          </div>
        );
      case "browser":
        return <div className="space-y-7" />;
      case "advanced":
        return (
          <AdvancedSettings
            form={networkSafetyForm}
            dirty={networkSafetyDirty}
            saving={networkSafetySaving}
            isNativeHostSurface={(settings.surface ?? settings.runtime_surface) === "native"}
            onChangeForm={setNetworkSafetyForm}
            onSave={saveNetworkSafetySettings}
            onRestart={restartViaSettingsSurface}
            isRestarting={isRestarting || hostEngineApplying}
            requiresRestartPending={pendingRestartSections.runtime}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[radial-gradient(circle_at_50%_0%,hsl(var(--muted))_0%,hsl(var(--background))_42%)] md:flex-row">
      {showSidebar ? (
        <SettingsSidebar
          activeSection={activeSection}
          onSelectSection={setActiveSection}
          onBackToChat={onBackToChat}
          onLogout={onLogout}
          hostChromeInset={hostChromeInset}
        />
      ) : null}

      <NewModelConfigurationDialog
        open={modelConfigurationOpen}
        draft={modelConfigurationForm}
        providers={configuredModelProviderOptions}
        saving={modelConfigurationSaving}
        showProviderLogos={localPrefs.brandLogos}
        onOpenChange={setModelConfigurationOpen}
        onChangeDraft={setModelConfigurationForm}
        onSave={handleCreateModelConfiguration}
      />

      <Dialog
        open={providerToDelete !== null}
        onOpenChange={(open) => {
          if (!open && !providerDeleting) setProviderToDelete(null);
        }}
      >
        <DialogContent className="max-w-[420px]">
          <DialogHeader>
            <DialogTitle>
              {t("settings.byok.deleteConfirmTitle", { defaultValue: "Delete provider configuration" })}
            </DialogTitle>
            <DialogDescription>
              {t("settings.byok.deleteConfirmDescription", {
                defaultValue:
                  "This will clear the provider's API key, API base, and associated model configurations. This action cannot be undone.",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setProviderToDelete(null)}
              disabled={providerDeleting}
              className="rounded-full"
            >
              {t("settings.bootstrap.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDeleteProvider}
              disabled={providerDeleting}
              className="rounded-full"
            >
              {providerDeleting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : null}
              {providerDeleting
                ? t("settings.byok.deleting", { defaultValue: "Deleting..." })
                : t("settings.byok.deleteConfirmAction", { defaultValue: "Delete" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <main className="min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div
          className={cn(
            "mx-auto w-full max-w-[920px] px-5 py-8 sm:px-8 lg:py-12",
            hostChromeInset && "pt-[4.25rem] sm:pt-[4.25rem] lg:pt-[4.75rem]",
          )}
        >
          <div className="mb-7">
            <p className="mb-2 text-[13px] font-medium text-muted-foreground">
              {t("settings.sidebar.title")}
            </p>
            <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-foreground sm:text-[34px]">
              {text(`settings.nav.${activeSection}`, titleForSection(activeSection))}
            </h1>
          </div>

          {loading ? (
            <div className="flex h-48 items-center justify-center rounded-[24px] border border-border/50 bg-card/75 text-sm text-muted-foreground shadow-[0_20px_70px_rgba(15,23,42,0.07)]">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("settings.status.loading")}
            </div>
          ) : error && !settings ? (
            <SettingsGroup>
              <SettingsRow title={t("settings.status.loadError")}>
                <span className="max-w-[520px] text-sm text-muted-foreground">{error}</span>
              </SettingsRow>
            </SettingsGroup>
          ) : settings ? (
            <div className="space-y-5">
              {error ? (
                <div className="rounded-[18px] border border-destructive/20 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
                  {error}
                </div>
              ) : null}
              {renderSection()}
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

const SETTINGS_NAV_ITEMS: Array<{ key: SettingsSectionKey; icon: LucideIcon; fallback: string }> = [
  { key: "overview", icon: Activity, fallback: "Overview" },
  { key: "appearance", icon: Palette, fallback: "Appearance" },
  { key: "models", icon: SlidersHorizontal, fallback: "Models" },
  { key: "browser", icon: Globe2, fallback: "Web" },
  { key: "advanced", icon: ShieldCheck, fallback: "Security" },
];

function visibleWebuiDefaultAccessMode(mode: string | null | undefined): WebuiDefaultAccessMode {
  return mode === "full" ? "full" : "default";
}

function parseDreamIntervalHours(schedule: string | undefined | null): number {
  if (!schedule) return 2;
  const match = schedule.match(/every\s+(\d+)h/i);
  return match ? parseInt(match[1], 10) : 2;
}

function titleForSection(section: SettingsSectionKey): string {
  return SETTINGS_NAV_ITEMS.find((item) => item.key === section)?.fallback ?? "Settings";
}

function SettingsSidebar({
  activeSection,
  onSelectSection,
  onBackToChat,
  onLogout,
  hostChromeInset,
}: {
  activeSection: SettingsSectionKey;
  onSelectSection: (section: SettingsSectionKey) => void;
  onBackToChat: () => void;
  onLogout?: () => void;
  hostChromeInset?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <aside
      className={cn(
        "flex w-full shrink-0 flex-col border-b border-border/55 bg-card/62 px-4 pb-3 shadow-[inset_0_-1px_0_rgba(255,255,255,0.55)] backdrop-blur-xl dark:bg-card/45 dark:shadow-none md:w-[17rem] md:border-b-0 md:border-r md:px-3 md:pb-4 md:shadow-[inset_-1px_0_0_rgba(255,255,255,0.55)]",
        hostChromeInset ? "pt-[4.25rem] md:pt-[4.25rem]" : "pt-4 md:pt-4",
      )}
    >
      <button
        type="button"
        onClick={onBackToChat}
        className="mb-2 inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground md:mb-3"
      >
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
        {t("settings.backToChat")}
      </button>
      <div className="mb-3 px-1 md:mb-4 md:px-2">
        <h2 className="text-[21px] font-semibold tracking-[-0.02em] text-foreground">
          {t("settings.sidebar.title")}
        </h2>
      </div>

      <nav
        aria-label={t("settings.sidebar.ariaLabel")}
        className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:mx-0 md:block md:space-y-1 md:overflow-visible md:px-0 md:pb-0"
      >
        {SETTINGS_NAV_ITEMS.map(({ key, icon: Icon, fallback }) => {
          const active = key === activeSection;
          return (
            <button
              key={key}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => onSelectSection(key)}
              className={cn(
                "flex h-9 w-auto shrink-0 items-center gap-2 rounded-full px-3 text-left text-[13px] font-medium transition-colors md:w-full md:rounded-[10px] md:px-2.5",
                active
                  ? "bg-muted/90 text-foreground shadow-[inset_0_0_0_1px_rgba(0,0,0,0.025)]"
                  : "text-muted-foreground/78 hover:bg-muted/45 hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
              <span className="truncate">{t(`settings.nav.${key}`, { defaultValue: fallback })}</span>
            </button>
          );
        })}
      </nav>

      <div className="hidden md:mt-auto md:block md:pt-4">
        {onLogout && !hostChromeInset ? (
          <Button
            type="button"
            variant="ghost"
            onClick={onLogout}
            className="h-9 w-full justify-start gap-2 rounded-[10px] px-2.5 text-[13px] font-medium text-muted-foreground hover:bg-destructive/8 hover:text-destructive"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            {t("app.account.logout")}
          </Button>
        ) : null}
      </div>
    </aside>
  );
}

function OverviewSettings({
  settings,
  requiresRestart,
  onRestart,
  isRestarting,
  onSelectSection,
  showBrandLogos,
  runtimeForm,
  runtimeDirty,
  runtimeSaving,
  onChangeRuntimeForm,
  onSaveRuntime,
}: {
  settings: SettingsPayload;
  requiresRestart: boolean;
  onRestart?: () => void;
  isRestarting?: boolean;
  onSelectSection: (section: SettingsSectionKey) => void;
  showBrandLogos: boolean;
  runtimeForm: RuntimeSettingsUpdate;
  runtimeDirty: boolean;
  runtimeSaving: boolean;
  onChangeRuntimeForm: Dispatch<SetStateAction<RuntimeSettingsUpdate>>;
  onSaveRuntime: () => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const activePreset = settings.agent.model_preset || "default";
  const activeProvider = settings.agent.resolved_provider ?? settings.agent.provider;
  return (
    <div className="space-y-7">
      <section>
        <div className="overflow-hidden rounded-[22px] border border-border/45 bg-card/86 shadow-[0_18px_65px_rgba(15,23,42,0.075)] backdrop-blur-xl dark:border-white/10 dark:shadow-[0_18px_65px_rgba(0,0,0,0.24)]">
          <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <div className="min-w-0">
                <div className="text-[12px] font-medium text-muted-foreground">MiniUnicorn</div>
                <div className="mt-0.5 truncate text-[18px] font-semibold leading-6 text-foreground">
                  {settings.agent.model}
                </div>
                <div className="mt-0.5 truncate text-[13px] leading-5 text-muted-foreground">
                  {activeProvider} · {activePreset}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              <StatusPill tone={requiresRestart ? "neutral" : "success"}>
                {requiresRestart
                  ? tx("settings.values.restartPending", "Restart pending")
                  : tx("settings.values.ready", "Ready")}
              </StatusPill>
              {requiresRestart && onRestart ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onRestart}
                  disabled={isRestarting}
                  className="rounded-full"
                >
                  {isRestarting ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  )}
                  {isRestarting ? t("app.system.restarting") : t("app.system.restart")}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section>
        <SettingsSectionTitle>{tx("settings.sections.ai", "AI")}</SettingsSectionTitle>
        <SettingsGroup>
          <OverviewListRow
            icon={Bot}
            valueLogoProvider={activeProvider}
            title={tx("settings.overview.model", "Current model")}
            value={settings.agent.model}
            caption={`${activeProvider} · ${activePreset}`}
            showBrandLogos={showBrandLogos}
            onClick={() => onSelectSection("models")}
          />
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>{tx("settings.sections.persona", "Persona")}</SettingsSectionTitle>
        <SettingsGroup>
          <BootstrapFileRow fileName="AGENTS.md" />
          <BootstrapFileRow fileName="SOUL.md" />
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>{tx("settings.sections.system", "System")}</SettingsSectionTitle>
        <SettingsGroup>
          <OverviewListRow
            icon={HardDrive}
            title={tx("settings.overview.workspace", "Workspace")}
            value={settings.runtime.workspace_path}
            caption={tx("settings.rows.configPath", "Config path")}
          />
          <SettingsRow
            icon={Activity}
            title={tx("settings.overview.heartbeat", "Heartbeat")}
            description={tx("settings.help.heartbeat", "Idle check interval in seconds (60-86400).")}
          >
            <NumberInput
              value={runtimeForm.heartbeatIntervalS ?? settings.runtime.heartbeat.interval_s}
              min={60}
              max={86400}
              suffix="s"
              onChange={(heartbeatIntervalS) =>
                onChangeRuntimeForm((prev) => ({ ...prev, heartbeatIntervalS }))
              }
            />
          </SettingsRow>
          <SettingsRow
            icon={Moon}
            title={tx("settings.overview.dream", "Dream")}
            description={tx("settings.help.dream", "Memory consolidation interval in hours (1-48).")}
          >
            <NumberInput
              value={runtimeForm.dreamIntervalH ?? parseDreamIntervalHours(settings.runtime.dream.schedule)}
              min={1}
              max={48}
              suffix="h"
              onChange={(dreamIntervalH) =>
                onChangeRuntimeForm((prev) => ({ ...prev, dreamIntervalH }))
              }
            />
          </SettingsRow>
          <RestartSettingsFooter
            dirty={runtimeDirty}
            saving={runtimeSaving}
            pendingRestart={false}
            onSave={onSaveRuntime}
            onRestart={onRestart}
            isRestarting={isRestarting}
          />
        </SettingsGroup>
      </section>
    </div>
  );
}

function AppearanceSettings({
  themeMode,
  onSetThemeMode,
  localPrefs,
  onChangeLocalPrefs,
}: {
  themeMode: ThemeMode;
  onSetThemeMode: (mode: ThemeMode) => void;
  localPrefs: LocalPreferences;
  onChangeLocalPrefs: Dispatch<SetStateAction<LocalPreferences>>;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const themeOptions: Array<{ value: ThemeMode; label: string }> = [
    { value: "light", label: t("settings.values.light") },
    { value: "dark", label: t("settings.values.dark") },
    { value: "system", label: tx("settings.values.system", "System") },
  ];
  return (
    <div className="space-y-7">
      <section>
        <SettingsSectionTitle>{t("settings.sections.interface")}</SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={t("settings.rows.theme")}
            description={t("settings.help.theme")}
          >
            <div className="inline-flex h-8 items-center rounded-full bg-muted p-0.5 text-[12px] font-medium text-muted-foreground">
              {themeOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onSetThemeMode(option.value)}
                  className={cn(
                    "rounded-full px-3 py-1 transition-colors",
                    themeMode === option.value && "bg-background text-foreground shadow-sm",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </SettingsRow>

          <SettingsRow
            title={t("settings.rows.language")}
            description={t("settings.help.language")}
          >
            <LanguageSwitcher />
          </SettingsRow>
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>{tx("settings.sections.localPreferences", "Local preferences")}</SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.rows.density", "Density")}
            description={tx("settings.help.density", "Stored only in this browser.")}
          >
            <SegmentedControl
              value={localPrefs.density}
              options={[
                { value: "comfortable", label: tx("settings.values.comfortable", "Comfortable") },
                { value: "compact", label: tx("settings.values.compact", "Compact") },
              ]}
              onChange={(density) =>
                onChangeLocalPrefs((prev) => ({ ...prev, density: density as LocalDensity }))
              }
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.activityMode", "Activity detail")}
            description={tx("settings.help.activityMode", "Choose how much agent activity chrome to show by default.")}
          >
            <SegmentedControl
              value={localPrefs.activityMode}
              options={[
                { value: "auto", label: tx("settings.values.auto", "Auto") },
                { value: "expanded", label: tx("settings.values.expanded", "Expanded") },
              ]}
              onChange={(activityMode) =>
                onChangeLocalPrefs((prev) => ({ ...prev, activityMode: activityMode as LocalActivityMode }))
              }
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.codeWrap", "Code wrapping")}
            description={tx("settings.help.codeWrap", "Keep long code lines readable on smaller screens.")}
          >
            <ToggleButton
              checked={localPrefs.codeWrap}
              onChange={(codeWrap) => onChangeLocalPrefs((prev) => ({ ...prev, codeWrap }))}
              ariaLabel={tx("settings.rows.codeWrap", "Code wrapping")}
              label={localPrefs.codeWrap ? tx("settings.values.on", "On") : tx("settings.values.off", "Off")}
            />
          </SettingsRow>
        </SettingsGroup>
      </section>
    </div>
  );
}

function NewModelConfigurationDialog({
  open,
  draft,
  providers,
  saving,
  showProviderLogos,
  onOpenChange,
  onChangeDraft,
  onSave,
}: {
  open: boolean;
  draft: ModelConfigurationDraft;
  providers: Array<{ name: string; label: string }>;
  saving: boolean;
  showProviderLogos: boolean;
  onOpenChange: (open: boolean) => void;
  onChangeDraft: Dispatch<SetStateAction<ModelConfigurationDraft>>;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const canSave = Boolean(draft.label.trim() && draft.provider.trim() && draft.model.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[520px] rounded-[28px] border-border/55 bg-card/95 p-0 shadow-[0_28px_90px_rgba(15,23,42,0.20)] backdrop-blur-xl dark:border-white/10">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <DialogHeader className="border-b border-border/45 px-5 py-4 text-left">
            <DialogTitle className="text-[18px] font-semibold tracking-[-0.01em]">
              {tx("settings.models.newConfiguration", "New model configuration")}
            </DialogTitle>
            <DialogDescription className="text-[12.5px] leading-5">
              {tx("settings.models.newConfigurationHelp", "Save a provider and model as a one-click option.")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 px-5 py-5">
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-muted-foreground">
                {tx("settings.models.configurationName", "Name")}
              </span>
              <ClearableInput
                autoFocus
                value={draft.label}
                placeholder={tx("settings.models.configurationNamePlaceholder", "Fast writing")}
                onChange={(event) =>
                  onChangeDraft((prev) => ({ ...prev, label: event.target.value }))
                }
                onClear={() => onChangeDraft((prev) => ({ ...prev, label: "" }))}
                className="h-10 rounded-full px-4 text-[14px]"
              />
            </label>

            <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-muted-foreground">
                  {tx("settings.rows.model", "Model")}
                </span>
                <ClearableInput
                  value={draft.model}
                  placeholder="openai/gpt-4.1"
                  onChange={(event) =>
                    onChangeDraft((prev) => ({ ...prev, model: event.target.value }))
                  }
                  onClear={() => onChangeDraft((prev) => ({ ...prev, model: "" }))}
                  className="h-10 rounded-full px-4 text-[14px]"
                />
              </label>
              <div className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-muted-foreground">
                  {tx("settings.rows.provider", "Provider")}
                </span>
                <ProviderPicker
                  providers={providers}
                  value={draft.provider}
                  emptyLabel={tx("settings.byok.noConfiguredProviders", "No configured providers")}
                  showProviderLogos={showProviderLogos}
                  onChange={(provider) =>
                    onChangeDraft((prev) => ({ ...prev, provider }))
                  }
                />
              </div>
            </div>
          </div>

          <DialogFooter className="border-t border-border/45 px-5 py-4 sm:space-x-2">
            <Button
              type="button"
              variant="ghost"
              className="rounded-full"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              {tx("settings.actions.cancel", "Cancel")}
            </Button>
            <Button
              type="submit"
              variant="outline"
              className="rounded-full"
              disabled={!canSave || saving || providers.length === 0}
            >
              {saving ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : null}
              {saving ? tx("settings.actions.saving", "Saving...") : tx("settings.actions.save", "Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ModelsSettings({
  form,
  setForm,
  settings,
  dirty,
  saving,
  contextWindowLearning,
  contextWindowLearnTimeout,
  showBrandLogos,
  onSave,
  onSaveContextWindow,
  onCreateConfiguration,
}: {
  form: AgentSettingsDraft;
  setForm: Dispatch<SetStateAction<AgentSettingsDraft>>;
  settings: SettingsPayload;
  dirty: boolean;
  saving: boolean;
  contextWindowLearning: boolean;
  contextWindowLearnTimeout: boolean;
  showBrandLogos: boolean;
  onSave: () => void;
  onSaveContextWindow: (value: number) => Promise<void>;
  onCreateConfiguration: () => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  // 上下文窗口跟随当前选中的 preset(未保存时也立即反映),
  // 而不是 settings.agent(只有保存后才会更新)
  const selectedPreset = settings.model_presets.find((p) => p.name === form.modelPreset);
  const ctxResolved = selectedPreset?.resolved_context_window_tokens ?? settings.agent.resolved_context_window_tokens;
  const ctxConfigured = selectedPreset?.context_window_tokens ?? settings.agent.context_window_tokens;
  const ctxStatus = selectedPreset?.resolved_context_window_status ?? settings.agent.resolved_context_window_status;
  const ctxError = selectedPreset?.resolved_context_window_error ?? settings.agent.resolved_context_window_error;
  return (
    <div className="space-y-7">
      <section>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.rows.currentModel", "Current model")}
            description={tx("settings.help.currentModel", "Choose the model MiniUnicorn uses for new replies.")}
          >
            <ModelPresetPicker
              presets={settings.model_presets}
              value={form.modelPreset}
              settings={settings}
              draftModel={form.model}
              draftProvider={form.provider}
              showProviderLogos={showBrandLogos}
              onChange={(modelPreset) => {
                const nextPreset = settings.model_presets.find((preset) => preset.name === modelPreset);
                setForm((prev) => ({
                  ...prev,
                  modelPreset,
                  model: nextPreset?.model ?? prev.model,
                  provider: nextPreset?.is_default
                    ? editableDefaultProvider(settings)
                    : nextPreset?.provider ?? prev.provider,
                  presetLabel: nextPreset?.label ?? modelPreset,
                }));
              }}
              onCreateConfiguration={onCreateConfiguration}
            />
          </SettingsRow>
          <SettingsRow
            title={t("settings.rows.contextWindow")}
            description={t("settings.help.contextWindow")}
          >
            <ContextWindowBadge
              key={`${form.modelPreset}-${ctxResolved}-${ctxStatus}`}
              resolved={ctxResolved}
              configured={ctxConfigured}
              status={ctxStatus}
              error={ctxError}
              timeout={contextWindowLearnTimeout}
              onSave={onSaveContextWindow}
            />
          </SettingsRow>
          <SettingsFooter
            dirty={dirty}
            saving={saving || contextWindowLearning}
            saved={false}
            disabled={false}
            savingLabel={contextWindowLearning ? t("settings.actions.queryingContext") : undefined}
            onSave={onSave}
          />
        </SettingsGroup>
      </section>
    </div>
  );
}

function ProvidersSettings({
  settings,
  expandedProvider,
  providerForms,
  visibleProviderKeys,
  editingProviderKeys,
  providerSaving,
  providerSaved,
  providerModels,
  providerModelsLoading,
  learningProvider,
  timeoutProvider,
  showBrandLogos,
  onToggleProvider,
  onToggleProviderKey,
  onToggleProviderKeyEditing,
  onChangeProviderForm,
  onSaveProvider,
  onFetchProviderModels,
  onProviderOAuthLogin,
  onProviderOAuthLogout,
  onRequestDeleteProvider,
  customPresetLabel,
  onChangeCustomPresetLabel,
  onSaveCustomConfiguration,
}: {
  settings: SettingsPayload;
  expandedProvider: string | null;
  providerForms: Record<string, ProviderForm>;
  visibleProviderKeys: Record<string, boolean>;
  editingProviderKeys: Record<string, boolean>;
  providerSaving: string | null;
  providerSaved: Record<string, boolean>;
  providerModels: Record<string, string[]>;
  providerModelsLoading: string | null;
  learningProvider: string | null;
  timeoutProvider: string | null;
  showBrandLogos: boolean;
  onToggleProvider: (provider: string) => void;
  onToggleProviderKey: (provider: string) => void;
  onToggleProviderKeyEditing: (provider: string) => void;
  onChangeProviderForm: (provider: string, value: Partial<ProviderForm>) => void;
  onSaveProvider: (provider: string) => void;
  onFetchProviderModels: (provider: string) => void;
  onProviderOAuthLogin: (provider: string) => void;
  onProviderOAuthLogout: (provider: string) => void;
  onRequestDeleteProvider: (provider: string) => void;
  customPresetLabel: string;
  onChangeCustomPresetLabel: (value: string) => void;
  onSaveCustomConfiguration: () => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  // custom preset 虚拟条目(name=custom__xxx)configured=true,会自动进入已配置区域。
  // 真正的 "custom" 单例 configured=false,作为未配置区域的添加入口。
  const configuredProviders = useMemo(
    () => settings.providers.filter((provider) => provider.configured),
    [settings.providers],
  );
  const unconfiguredProviders = useMemo(
    () => orderUnconfiguredProviders(settings.providers.filter((provider) => !provider.configured)),
    [settings.providers],
  );
  const renderProviderRow = (provider: SettingsPayload["providers"][number]) => {
    const expanded = expandedProvider === provider.name;
    const form = providerForms[provider.name] ?? {
      apiKey: "",
      apiBase: provider.api_base ?? provider.default_api_base ?? "",
      apiType: provider.api_type ?? "auto",
      model: "",
    };
    const saving = providerSaving === provider.name;
    const saved = !!providerSaved[provider.name];
    const modelsLoading = providerModelsLoading === provider.name;
    const fetchedModels = providerModels[provider.name] ?? [];
    const isOauthProvider = provider.auth_type === "oauth";
    const keyVisible = !!visibleProviderKeys[provider.name];
    const editingKey = !provider.configured || !!editingProviderKeys[provider.name];
    const apiKeyRequired = provider.api_key_required ?? true;
    const apiKey = form.apiKey.trim();
    const apiBase = form.apiBase.trim();
    const missingRequiredApiKey = !isOauthProvider && apiKeyRequired && !provider.configured && !apiKey;
    const missingOptionalCredential =
      !isOauthProvider && !apiKeyRequired && !provider.configured && !apiKey && !apiBase;
    return (
      <div key={provider.name} className="divide-y divide-border/45">
        <button
          type="button"
          onClick={() => onToggleProvider(provider.name)}
          className="flex min-h-[70px] w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/35 sm:px-5"
        >
          <span className="flex min-w-0 items-center gap-3">
            <ProviderIcon
              provider={provider.name}
              showBrandLogos={showBrandLogos}
              label={provider.label}
            />
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold leading-5 text-foreground">
                {provider.label}
              </span>
              <span className="block truncate text-[12px] text-muted-foreground">
                {provider.api_base || provider.default_api_base || provider.name}
              </span>
            </span>
          </span>
          <StatusPill tone={provider.configured ? "success" : "neutral"}>
            {isOauthProvider
              ? provider.configured
                ? tx("settings.oauth.signedIn", "Signed in")
                : tx("settings.oauth.notSignedIn", "Not signed in")
              : provider.configured
                ? t("settings.byok.configured")
                : t("settings.byok.notConfigured")}
          </StatusPill>
        </button>

        {expanded ? (
          <div className="space-y-3 bg-muted/18 px-4 py-4 sm:px-5">
            {isOauthProvider ? (
              <div className="flex flex-col gap-3 rounded-[18px] border border-border/45 bg-background/75 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-foreground">
                    {tx("settings.oauth.authentication", "OAuth authentication")}
                  </p>
                  <p className="mt-1 truncate text-[12px] text-muted-foreground">
                    {provider.configured
                      ? t("settings.oauth.signedInAs", {
                          account: provider.oauth_account || provider.label,
                          defaultValue: "Signed in as {{account}}",
                        })
                      : tx("settings.oauth.signInHelp", "Sign in from this device; no API key is stored in config.")}
                  </p>
                </div>
                <div className="flex shrink-0 justify-end gap-2">
                  {provider.configured ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onProviderOAuthLogout(provider.name)}
                      disabled={saving}
                      className="rounded-full"
                    >
                      {tx("settings.oauth.signOut", "Sign out")}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onProviderOAuthLogin(provider.name)}
                    disabled={saving || !provider.oauth_login_supported}
                    className="rounded-full"
                  >
                    {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                    {saving
                      ? tx("settings.oauth.signingIn", "Signing in...")
                      : provider.configured
                        ? tx("settings.oauth.signInAgain", "Sign in again")
                        : tx("settings.oauth.signIn", "Sign in")}
                  </Button>
                </div>
              </div>
            ) : (
              <>
            {/* custom provider:配置名称(每个 custom 配置是独立 model_preset,label 用于区分) */}
            {provider.name === "custom" ? (
              <label className="block space-y-1.5">
                <span className="text-[12px] font-medium text-muted-foreground">
                  {tx("settings.byok.customLabel", "Label")}
                </span>
                <ClearableInput
                  value={customPresetLabel}
                  onChange={(event) => onChangeCustomPresetLabel(event.target.value)}
                  onClear={() => onChangeCustomPresetLabel("")}
                  placeholder={tx("settings.byok.customLabelPlaceholder", "e.g. agnes, my-service")}
                  className="h-9 rounded-full text-[13px]"
                />
              </label>
            ) : null}
            <label className="block space-y-1.5">
              <span className="text-[12px] font-medium text-muted-foreground">
                {t("settings.byok.apiKey")}
              </span>
              <div className="relative">
                {editingKey ? (
                  <ClearableInput
                    type={keyVisible ? "text" : "password"}
                    value={form.apiKey}
                    onChange={(event) =>
                      onChangeProviderForm(provider.name, { apiKey: event.target.value })
                    }
                    onClear={() => onChangeProviderForm(provider.name, { apiKey: "" })}
                    placeholder={
                      provider.configured
                        ? t("settings.byok.apiKeyConfiguredPlaceholder")
                        : t("settings.byok.apiKeyPlaceholder")
                    }
                    className="h-9 rounded-full text-[13px]"
                    trailingSlot={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => onToggleProviderKey(provider.name)}
                        aria-label={
                          keyVisible
                            ? t("settings.byok.hideApiKey")
                            : t("settings.byok.showApiKey")
                        }
                        className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        {keyVisible ? (
                          <EyeOff className="h-3.5 w-3.5" aria-hidden />
                        ) : (
                          <Eye className="h-3.5 w-3.5" aria-hidden />
                        )}
                      </Button>
                    }
                  />
                ) : (
                  <>
                    <div className="flex h-9 items-center rounded-full border border-input bg-background px-3 pr-11 text-[13px] text-muted-foreground">
                      {provider.api_key_hint ?? t("settings.byok.configuredKeyHint")}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => onToggleProviderKeyEditing(provider.name)}
                      aria-label={t("settings.actions.edit")}
                      className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </>
                )}
              </div>
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-medium text-muted-foreground">
                {t("settings.byok.apiBase")}
              </span>
              <ClearableInput
                value={form.apiBase}
                onChange={(event) =>
                  onChangeProviderForm(provider.name, { apiBase: event.target.value })
                }
                onClear={() => onChangeProviderForm(provider.name, { apiBase: "" })}
                placeholder={provider.default_api_base ?? t("settings.byok.apiBasePlaceholder")}
                className="h-9 rounded-full text-[13px]"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-medium text-muted-foreground">
                {tx("settings.byok.modelId", "Model ID")}
              </span>
              <div className="flex gap-2">
                <ClearableInput
                  value={form.model}
                  onChange={(event) =>
                    onChangeProviderForm(provider.name, { model: event.target.value })
                  }
                  onClear={() => onChangeProviderForm(provider.name, { model: "" })}
                  placeholder={tx("settings.byok.modelIdPlaceholder", "e.g. gpt-4o, deepseek-chat")}
                  className="h-9 flex-1 rounded-full text-[13px]"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onFetchProviderModels(provider.name)}
                  disabled={modelsLoading}
                  className="h-9 shrink-0 rounded-full px-3 text-[12px]"
                >
                  {modelsLoading ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden />
                  ) : (
                    <Search className="mr-1 h-3 w-3" aria-hidden />
                  )}
                  {modelsLoading
                    ? tx("settings.byok.fetchingModels", "Fetching...")
                    : tx("settings.byok.fetchModels", "Fetch models")}
                </Button>
              </div>
              <span className="block text-[11px] text-muted-foreground/80">
                {tx("settings.byok.modelIdHelp", "Set as active model when saving.")}
              </span>
              {fetchedModels.length > 0 ? (
                <div className="mt-1 max-h-[160px] overflow-y-auto rounded-lg border border-border/45 bg-background/60">
                  {fetchedModels.map((modelId) => (
                    <button
                      key={modelId}
                      type="button"
                      onClick={() => onChangeProviderForm(provider.name, { model: modelId })}
                      className={cn(
                        "block w-full truncate px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-muted/50",
                        form.model === modelId
                          ? "font-semibold text-foreground"
                          : "text-muted-foreground",
                      )}
                      title={modelId}
                    >
                      {modelId}
                    </button>
                  ))}
                </div>
              ) : null}
            </label>
            {provider.name === "openai" ? (
              <label className="block space-y-1.5">
                <span className="text-[12px] font-medium text-muted-foreground">
                  {tx("settings.byok.apiType", "API type")}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-9 w-full justify-between rounded-full px-3 text-[13px]"
                    >
                      <span>
                        {OPENAI_API_TYPE_OPTIONS.find((option) => option.value === form.apiType)?.label ??
                          form.apiType}
                      </span>
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-[220px]">
                    {OPENAI_API_TYPE_OPTIONS.map((option) => (
                      <DropdownMenuItem
                        key={option.value}
                        onSelect={() => onChangeProviderForm(provider.name, { apiType: option.value })}
                      >
                        {option.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </label>
            ) : null}
            {provider.name === "custom" &&
              (!customPresetLabel.trim() ||
                !form.apiBase.trim() ||
                !form.model.trim()) ? (
              <p className="text-right text-[11px] text-muted-foreground">
                {tx("settings.byok.customRequiredHint", "Label, API base and model are required")}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  provider.name === "custom"
                    ? onSaveCustomConfiguration()
                    : onSaveProvider(provider.name)
                }
                disabled={
                  saving ||
                  saved ||
                  (provider.name !== "custom" && (missingRequiredApiKey || missingOptionalCredential))
                }
                className={cn(
                  "rounded-full",
                  saved && "opacity-50 cursor-not-allowed",
                )}
                title={timeoutProvider === provider.name ? t("settings.actions.queryTimeout") : undefined}
              >
                {saving
                  ? (learningProvider === provider.name
                      ? t("settings.actions.queryingContext")
                      : t("settings.actions.saving"))
                  : (learningProvider === provider.name
                      ? t("settings.actions.queryingContext")
                      : timeoutProvider === provider.name
                        ? t("settings.actions.queryTimeout")
                        : saved
                          ? tx("settings.providers.saved", "Saved")
                          : tx("settings.providers.saveProvider", "Save provider"))}
              </Button>
              {/* 已配置卡片:显示删除按钮(清除凭证 + 关联 model_preset,移回未配置)。
                  custom 是添加入口,不显示删除(已创建的 preset 在 Models 区域管理) */}
              {provider.configured && provider.name !== "custom" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onRequestDeleteProvider(provider.name)}
                  disabled={saving}
                  className="rounded-full"
                  title={tx("settings.byok.delete", "Delete")}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden />
                  {tx("settings.byok.delete", "Delete")}
                </Button>
              ) : null}
            </div>
              </>
            )}
          </div>
        ) : null}
      </div>
    );
  };
  return (
    <div className="space-y-6">
      <p className="max-w-[42rem] text-[13px] leading-6 text-muted-foreground">
        {t("settings.byok.description")}
      </p>
      <ProviderSection
        title={t("settings.byok.configuredSection")}
        count={configuredProviders.length}
        empty={t("settings.byok.noConfiguredProviders")}
      >
        {configuredProviders.map(renderProviderRow)}
      </ProviderSection>
      <ProviderSection
        title={t("settings.byok.notConfiguredSection")}
        count={unconfiguredProviders.length}
        empty={t("settings.byok.noConfiguredProviders")}
      >
        {unconfiguredProviders.map(renderProviderRow)}
      </ProviderSection>
    </div>
  );
}

function AdvancedSettings({
  form,
  dirty,
  saving,
  requiresRestartPending,
  isNativeHostSurface,
  onChangeForm,
  onSave,
  onRestart,
  isRestarting,
}: {
  form: NetworkSafetySettingsUpdate;
  dirty: boolean;
  saving: boolean;
  requiresRestartPending: boolean;
  isNativeHostSurface: boolean;
  onChangeForm: Dispatch<SetStateAction<NetworkSafetySettingsUpdate>>;
  onSave: () => void;
  onRestart?: () => void;
  isRestarting?: boolean;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  return (
    <div className="space-y-7">
      <section>
        <SettingsSectionTitle>
          {isNativeHostSurface
            ? tx("settings.sections.hostSafety", "App safety")
            : tx("settings.sections.webuiSafety", "Web safety")}
        </SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.rows.localServiceAccess", "Local Service Access")}
            description={tx(
              isNativeHostSurface ? "settings.help.localServiceAccessNative" : "settings.help.localServiceAccess",
              isNativeHostSurface
                ? "Allow Full Access shell commands to reach services on this Mac."
                : "Allow Full Access shell commands to reach localhost services.",
            )}
          >
            <ToggleButton
              checked={form.webuiAllowLocalServiceAccess}
              onChange={(webuiAllowLocalServiceAccess) =>
                onChangeForm((prev) => ({ ...prev, webuiAllowLocalServiceAccess }))
              }
              ariaLabel={tx("settings.rows.localServiceAccess", "Local Service Access")}
              label={form.webuiAllowLocalServiceAccess ? tx("settings.values.on", "On") : tx("settings.values.off", "Off")}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.webuiDefaultAccess", "Default access")}
            description={tx(
              isNativeHostSurface ? "settings.help.webuiDefaultAccessNative" : "settings.help.webuiDefaultAccess",
              isNativeHostSurface
                ? "Used by native chats without a project-specific permission."
                : "Used by web chats without a project-specific permission.",
            )}
          >
            <SegmentedControl
              value={form.webuiDefaultAccessMode}
              options={[
                { value: "default", label: tx("settings.values.defaultPermission", "Default Permission") },
                { value: "full", label: tx("settings.values.fullAccess", "Full Access") },
              ]}
              onChange={(webuiDefaultAccessMode) =>
                onChangeForm((prev) => ({
                  ...prev,
                  webuiDefaultAccessMode: webuiDefaultAccessMode as WebuiDefaultAccessMode,
                }))
              }
            />
          </SettingsRow>
          <RestartSettingsFooter
            dirty={dirty}
            saving={saving}
            pendingRestart={requiresRestartPending}
            onSave={onSave}
            onRestart={onRestart}
            isRestarting={isRestarting}
          />
        </SettingsGroup>
      </section>

      <p className="max-w-3xl px-1 text-sm leading-6 text-muted-foreground">
        {tx(
          "settings.help.securityManagedControls",
          "Web fetches always protect local, private, and metadata services. Core channel safety stays in config.json.",
        )}
      </p>
    </div>
  );
}

function ProviderPicker({
  providers,
  value,
  emptyLabel,
  showProviderLogos = false,
  onChange,
}: {
  providers: Array<{ name: string; label: string }>;
  value: string;
  emptyLabel: string;
  showProviderLogos?: boolean;
  onChange: (provider: string) => void;
}) {
  const selectedProvider = providers.find((provider) => provider.name === value) ?? null;
  const disabled = providers.length === 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            "h-8 w-[210px] justify-between rounded-full border-input bg-background px-3 text-[13px] font-normal shadow-none",
            "hover:bg-accent/55 focus-visible:ring-2 focus-visible:ring-ring",
            disabled && "text-muted-foreground",
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            {selectedProvider && showProviderLogos ? (
              <ProviderPickerIcon
                provider={selectedProvider.name}
                showBrandLogos={showProviderLogos}
              />
            ) : null}
            <span className="truncate">{selectedProvider?.label ?? emptyLabel}</span>
          </span>
          <ChevronDown className="ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[18rem] w-[240px] overflow-y-auto"
      >
        {providers.map((provider) => {
          const selected = provider.name === value;
          return (
            <DropdownMenuItem
              key={provider.name}
              onSelect={() => onChange(provider.name)}
              className={cn(
                "flex cursor-default items-center justify-between gap-2 rounded-[12px] px-2.5 py-2 text-[13px]",
                "focus:bg-muted/85 focus:text-foreground",
                selected && "bg-muted/80 text-foreground focus:bg-muted",
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                {showProviderLogos ? (
                  <ProviderPickerIcon
                    provider={provider.name}
                    showBrandLogos={showProviderLogos}
                  />
                ) : null}
                <span className="truncate">{provider.label}</span>
              </span>
              {selected ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProviderPickerIcon({
  provider,
  showBrandLogos,
}: {
  provider: string;
  showBrandLogos: boolean;
}) {
  const [logoIndex, setLogoIndex] = useState(0);
  const brand = providerBrand(provider);
  const Icon = PROVIDER_ICONS[provider] ?? Sparkles;
  const logoUrl = brand?.logoUrls[logoIndex];

  useEffect(() => setLogoIndex(0), [provider]);

  if (showBrandLogos && logoUrl) {
    return (
      <span
        data-testid={`provider-picker-logo-${provider}`}
        className="grid h-5 w-5 shrink-0 place-items-center overflow-hidden rounded-md border border-border/35 bg-background shadow-[inset_0_0_0_1px_rgba(0,0,0,0.02)]"
        style={{ boxShadow: `inset 0 0 0 1px ${brand.color}22` }}
        aria-hidden
      >
        <img
          src={logoUrl}
          alt=""
          className="h-3.5 w-3.5 object-contain"
          onError={() => setLogoIndex((index) => index + 1)}
        />
      </span>
    );
  }

  if (showBrandLogos && brand) {
    return (
      <span
        data-testid={`provider-picker-logo-fallback-${provider}`}
        className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-[7.5px] font-semibold text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]"
        style={{ backgroundColor: brand.color }}
        aria-hidden
      >
        {brand.initials}
      </span>
    );
  }

  return (
    <span
      className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
      aria-hidden
    >
      <Icon className="h-3 w-3" strokeWidth={2} />
    </span>
  );
}

function ProviderSection({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <ByokSectionHeader title={title} count={count} />
      <div className="overflow-hidden rounded-[22px] border border-border/45 bg-card/86 shadow-[0_18px_65px_rgba(15,23,42,0.07)] backdrop-blur-xl dark:border-white/10 dark:shadow-[0_18px_65px_rgba(0,0,0,0.22)]">
        {count > 0 ? (
          <div className="divide-y divide-border/45">{children}</div>
        ) : (
          <ByokEmptyState>{empty}</ByokEmptyState>
        )}
      </div>
    </section>
  );
}

function ByokSectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center justify-between px-1">
      <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground/85">
        {title}
      </h2>
      <span className="rounded-full bg-muted px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground">
        {count}
      </span>
    </div>
  );
}

function ByokEmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[18px] border border-dashed border-border/65 bg-card/45 px-4 py-5 text-[13px] text-muted-foreground">
      {children}
    </div>
  );
}

function orderUnconfiguredProviders(
  providers: SettingsPayload["providers"],
): SettingsPayload["providers"] {
  return providers
    .map((provider, index) => ({ provider, index }))
    .sort((left, right) => {
      const rank = providerVisibilityRank(left.provider) - providerVisibilityRank(right.provider);
      return rank || left.index - right.index;
    })
    .map(({ provider }) => provider);
}

function providerVisibilityRank(provider: SettingsPayload["providers"][number]): number {
  const localRank = LOCAL_UNCONFIGURED_PROVIDER_ORDER.get(provider.name);
  if (localRank !== undefined) return localRank;
  if ((provider.api_key_required ?? true) === false) return 100;
  return 200;
}

function modelPresetProviderKey(
  preset: SettingsPayload["model_presets"][number],
  settings: SettingsPayload,
  options: { draftProvider?: string } = {},
): string {
  const provider = options.draftProvider ?? preset.provider;
  if (provider === "auto") {
    return settings.agent.resolved_provider || settings.agent.provider || preset.provider;
  }
  return provider;
}

const PROVIDER_ICONS: Record<string, LucideIcon> = {
  custom: Hexagon,
  openrouter: Sparkles,
  skywork: Sparkles,
  aihubmix: Triangle,
  anthropic: Brain,
  openai: Bot,
  deepseek: Waves,
  zhipu: Grid3X3,
  dashscope: Cloud,
  moonshot: Moon,
  minimax: Zap,
  minimax_anthropic: Brain,
  groq: Cpu,
  huggingface: Layers,
  gemini: Gem,
  mistral: Orbit,
  siliconflow: Layers,
  volcengine: Cloud,
  volcengine_coding_plan: Cloud,
  byteplus: Cloud,
  byteplus_coding_plan: Cloud,
  qianfan: Database,
  ant_ling: Sparkles,
  azure_openai: Cloud,
  bedrock: Database,
  brave: Search,
  duckduckgo: Search,
  exa: Search,
  jina: Search,
  kagi: Search,
  olostep: Search,
  searxng: Search,
  tavily: Search,
  vllm: Cpu,
  ollama: Cpu,
  lm_studio: Cpu,
  atomic_chat: Cpu,
  ovms: Cpu,
  nvidia: Zap,
};

function ProviderIcon({
  provider,
  showBrandLogos,
  label,
}: {
  provider: string;
  showBrandLogos: boolean;
  label?: string | null;
}) {
  const [logoIndex, setLogoIndex] = useState(0);
  // preset 虚拟卡片(<provider>__<preset_name>):用真实 provider 的 brand 显示图标。
  // - custom preset (custom__<name>): 只用 custom brand 的颜色 + label 首字母,
  //   清空 logoUrls 避免尝试加载 localhost/duckduckgo/google favicon(国内连不通)
  // - 非 custom preset (如 opencode__<name>): 用真实 provider 的 brand,正常显示 logo
  const isPresetCard = provider.includes("__");
  const isCustomPreset = provider.startsWith("custom__");
  const lookupKey = isPresetCard ? provider.split("__", 2)[0] : provider;
  const baseBrand = providerBrand(lookupKey);
  const brand =
    isCustomPreset && baseBrand
      ? {
          logoUrl: "",
          logoUrls: [],
          color: baseBrand.color,
          initials: (label?.trim().charAt(0).toUpperCase() || baseBrand.initials),
        }
      : baseBrand;
  const Icon = PROVIDER_ICONS[lookupKey] ?? Hexagon;
  const logoUrl = brand?.logoUrls[logoIndex];

  useEffect(() => setLogoIndex(0), [provider]);

  if (showBrandLogos && logoUrl) {
    return (
      <span
        data-testid={`provider-logo-${provider}`}
        className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-[14px] border border-border/45 bg-background shadow-[inset_0_0_0_1px_rgba(0,0,0,0.025)]"
        style={{ boxShadow: `inset 0 0 0 1px ${brand.color}22` }}
      >
        <img
          src={logoUrl}
          alt=""
          className="h-6 w-6 object-contain"
          onError={() => setLogoIndex((index) => index + 1)}
        />
      </span>
    );
  }
  if (showBrandLogos && brand) {
    return (
      <span
        data-testid={`provider-logo-fallback-${provider}`}
        className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-[14px] border border-border/45 bg-background shadow-[inset_0_0_0_1px_rgba(0,0,0,0.025)]"
        style={{ boxShadow: `inset 0 0 0 1px ${brand.color}22` }}
        aria-hidden
      >
        <span
          className="text-[13px] font-semibold"
          style={{ color: brand.color }}
        >
          {brand.initials}
        </span>
      </span>
    );
  }
  return (
    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-muted text-foreground/82 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.025)] dark:bg-muted/70">
      <Icon className="h-5 w-5" strokeWidth={2} aria-hidden />
    </span>
  );
}

/** 带一键清空的 Input 包装:有值时在右侧显示 X 按钮。
 *
 * `trailingSlot` 用于已有右侧图标(如 API Key 的眼睛按钮)的场景,
 * X 会排在 trailingSlot 之前;`clearAlign` 控制对齐方式。
 */
function ClearableInput({
  value,
  onChange,
  onClear,
  className,
  clearClassName,
  trailingSlot,
  ...rest
}: {
  value: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
  className?: string;
  clearClassName?: string;
  trailingSlot?: React.ReactNode;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const hasValue = typeof value === "string" && value.length > 0;
  const basePadding = trailingSlot ? "pr-[68px]" : "pr-9";
  return (
    <div className="relative">
      <Input
        value={value}
        onChange={onChange}
        className={cn(basePadding, className)}
        {...rest}
      />
      {hasValue ? (
        <button
          type="button"
          tabIndex={-1}
          onClick={onClear}
          aria-label="clear"
          className={cn(
            "absolute top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            trailingSlot ? "right-9" : "right-1.5",
            clearClassName,
          )}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
      {trailingSlot}
    </div>
  );
}

function OverviewRowIcon({
  icon: Icon,
}: {
  icon: LucideIcon;
}) {
  return (
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[12px] bg-muted text-foreground/82 transition-colors group-hover:bg-muted/80 dark:bg-muted/70">
      <Icon className="h-4 w-4" aria-hidden />
    </span>
  );
}

function OverviewListRow({
  icon: Icon,
  title,
  value,
  caption,
  onClick,
}: {
  icon: LucideIcon;
  valueLogoProvider?: string | null;
  title: string;
  value: string;
  caption: string;
  showBrandLogos?: boolean;
  onClick?: () => void;
}) {
  const content = (
    <>
      <OverviewRowIcon icon={Icon} />
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium leading-5 text-foreground">{title}</span>
        <span className="mt-0.5 block truncate text-[12px] leading-5 text-muted-foreground">{caption}</span>
      </span>
      <span className="ml-auto flex min-w-0 max-w-[48%] items-center gap-2">
        <span className="truncate text-right text-[13px] leading-5 text-muted-foreground">
          {value}
        </span>
        {onClick ? (
          <ChevronRight
            className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5"
            aria-hidden
          />
        ) : null}
      </span>
    </>
  );
  if (!onClick) {
    return (
      <div className="flex min-h-[68px] w-full items-center gap-3 px-4 py-3.5 text-left sm:px-5">
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-[68px] w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/30 sm:px-5"
    >
      {content}
    </button>
  );
}

function BootstrapFileRow({ fileName }: { fileName: string }) {
  const { t } = useTranslation();
  const { token } = useClient();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState<boolean | null>(null);

  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });

  const openEditor = async () => {
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      const data = await readBootstrapFile(token, fileName);
      setContent(data.content);
      setExists(data.exists);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!content.trim()) {
      setError(tx("settings.bootstrap.emptyError", "Content must not be empty"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveBootstrapFile(token, fileName, content);
      setExists(true);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={openEditor}
        className="group flex min-h-[68px] w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/30 sm:px-5"
      >
        <OverviewRowIcon icon={FileText} />
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-medium leading-5 text-foreground">{fileName}</span>
          <span className="mt-0.5 block truncate text-[12px] leading-5 text-muted-foreground">
            {exists === null
              ? tx("settings.bootstrap.tapToView", "Tap to view / edit")
              : exists
                ? tx("settings.bootstrap.configured", "Configured")
                : tx("settings.bootstrap.notConfigured", "Not configured — using template")}
          </span>
        </span>
        <span className="ml-auto flex min-w-0 items-center gap-2">
          <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" aria-hidden />
        </span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <FileText className="h-4 w-4 text-muted-foreground" />
              {fileName}
            </DialogTitle>
            <DialogDescription>
              {tx(
                "settings.bootstrap.editorDescription",
                "Loaded into the system prompt every turn. Edits apply on next message.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {loading ? (
              <div className="flex h-[360px] items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {tx("settings.bootstrap.loading", "Loading…")}
              </div>
            ) : (
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={tx("settings.bootstrap.placeholder", "Markdown content…")}
                className="min-h-[360px] font-mono text-[12px] leading-relaxed"
              />
            )}
            {error && <p className="text-[11px] text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" className="h-8" onClick={() => setOpen(false)} disabled={saving}>
              {tx("settings.bootstrap.cancel", "Cancel")}
            </Button>
            <Button size="sm" className="h-8" onClick={handleSave} disabled={saving || loading}>
              {saving ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
              {saving ? tx("settings.bootstrap.saving", "Saving…") : tx("settings.bootstrap.save", "Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SettingsSectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-2 px-1 text-[13px] font-semibold tracking-[-0.01em] text-foreground/85">
      {children}
    </h2>
  );
}

function SettingsGroup({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[22px] border border-border/45 bg-card/86 shadow-[0_18px_65px_rgba(15,23,42,0.075)] backdrop-blur-xl dark:border-white/10 dark:shadow-[0_18px_65px_rgba(0,0,0,0.24)]">
      <div className="divide-y divide-border/45">{children}</div>
    </div>
  );
}

function SettingsRow({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-[68px] flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="flex min-w-0 items-center gap-3">
        {Icon ? (
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[12px] bg-muted text-foreground/82 transition-colors group-hover:bg-muted/80 dark:bg-muted/70">
            <Icon className="h-4 w-4" aria-hidden />
          </span>
        ) : null}
        <div className="min-w-0">
          <div className="text-[14px] font-medium leading-5 text-foreground">{title}</div>
          {description ? (
            <div className="mt-0.5 max-w-[28rem] text-[12px] leading-5 text-muted-foreground">
              {description}
            </div>
          ) : null}
        </div>
      </div>
      {children ? <div className="shrink-0 sm:ml-6">{children}</div> : null}
    </div>
  );
}


function ContextWindowBadge({
  resolved,
  configured,
  status,
  error,
  timeout,
  onSave,
}: {
  resolved?: number;
  configured?: number;
  status?: "configured" | "learned" | "unknown" | "failed" | "default";
  error?: string | null;
  timeout?: boolean;
  onSave: (value: number) => Promise<void>;
}) {
  const { t } = useTranslation();
  const isConfigured = typeof configured === "number" && configured > 0;
  const value = typeof resolved === "number" && resolved > 0 ? resolved : configured ?? 0;
  // 已学习状态:HF 查询成功且用户未手动配置
  const isLearned = status === "learned" && !isConfigured;

  const [inputValue, setInputValue] = useState(value ? String(value) : "");
  const [saving, setSaving] = useState(false);

  // 同步外部值变化(如切换模型后)
  useEffect(() => {
    setInputValue(value ? String(value) : "");
  }, [value]);

  // 解析输入:支持纯数字(如 32000)和带 k/m 后缀(如 32k、1m、1.5m)。
  // 返回 { num: 转换后的整数 | null, hasSuffix: 是否使用了后缀语法 }
  const parsedInput = (() => {
    const raw = inputValue.trim();
    if (!raw) return { num: null, hasSuffix: false };
    let multiplier = 1;
    let body = raw;
    const last = raw[raw.length - 1];
    if (last === "k" || last === "K") {
      multiplier = 1_000;
      body = raw.slice(0, -1);
    } else if (last === "m" || last === "M") {
      multiplier = 1_000_000;
      body = raw.slice(0, -1);
    }
    const hasSuffix = multiplier !== 1;
    const parsed = Number(body);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { num: null, hasSuffix };
    }
    return { num: Math.round(parsed * multiplier), hasSuffix };
  })();
  const numValue = parsedInput.num;
  const isValid = numValue !== null && numValue > 0;
  // 输入与当前值不一致即视为已修改(清空也算,即用户想取消已学习值)
  const initialInputValue = value ? String(value) : "";
  const inputChanged = inputValue !== initialInputValue;
  // 当用户使用 k/m 后缀时,显示转换后的数值提示
  const suffixPreview = parsedInput.hasSuffix && numValue !== null
    ? `= ${numValue.toLocaleString()}`
    : "";
  // 已配置状态:用户手动保存了 context_window_tokens,且输入框未修改
  const isConfiguredSaved = isConfigured && !inputChanged && !timeout && !saving;

  // 按钮文本:超时 → "查询超时,请手动输入";已学习且未修改 → "已学习";
  // 已配置且未修改 → "已配置";否则 → "保存"
  const buttonLabel = saving
    ? t("settings.actions.saving")
    : timeout && !isConfigured && !inputChanged
      ? t("settings.actions.queryTimeout")
      : isLearned && !inputChanged
        ? t("settings.models.contextWindowLearned")
        : isConfiguredSaved
          ? t("settings.byok.configured")
          : t("settings.actions.save");

  // 按钮禁用:保存中,或输入无效,或(已学习/已配置且未修改)
  const buttonDisabled = saving || !isValid || ((isLearned || isConfigured) && !inputChanged);

  // 已学习/已配置且未修改(且非超时/保存中)时,直接复用 StatusPill 渲染,
  // 与 opencode 卡片"已配置"徽章使用完全相同的 DOM 结构和样式,避免 Button
  // 基础类(h-9 / justify-center / ring-offset / disabled:opacity 等)造成视觉差异。
  const showAsLearnedPill = (isLearned || isConfiguredSaved) && !inputChanged && !timeout && !saving;

  const handleSave = async () => {
    if (!isValid) return;
    setSaving(true);
    try {
      await onSave(numValue);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="inline-flex items-center gap-2"
      title={timeout ? t("settings.actions.queryTimeout") : (error ?? undefined)}
    >
      <div className="relative flex items-center">
        <Input
          type="text"
          inputMode="decimal"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder={t("settings.models.contextWindowPlaceholder")}
          className={cn(
            "h-7 w-28 text-center text-[12px] tabular-nums",
            timeout && !isConfigured && "border-amber-500/60 focus-visible:border-amber-500",
            suffixPreview && "pr-2",
          )}
          disabled={saving}
        />
        {suffixPreview ? (
          <span
            className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground tabular-nums"
            aria-hidden
          >
            {suffixPreview}
          </span>
        ) : null}
      </div>
      {showAsLearnedPill ? (
        <StatusPill tone="success">{buttonLabel}</StatusPill>
      ) : (
        <Button
          size="sm"
          variant={timeout && !isConfigured && !inputChanged ? "outline" : "default"}
          onClick={handleSave}
          disabled={buttonDisabled}
          className={cn(
            "h-7 gap-1 px-2.5 py-1 text-[12px] font-medium rounded-full",
            timeout && !isConfigured && !inputChanged &&
              "border-amber-500/60 text-amber-700 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-300",
          )}
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {buttonLabel}
        </Button>
      )}
    </div>
  );
}


function ModelPresetPicker({
  presets,
  value,
  settings,
  draftModel,
  draftProvider,
  showProviderLogos,
  onChange,
  onCreateConfiguration,
}: {
  presets: SettingsPayload["model_presets"];
  value: string;
  settings: SettingsPayload;
  draftModel: string;
  draftProvider: string;
  showProviderLogos: boolean;
  onChange: (preset: string) => void;
  onCreateConfiguration: () => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  // 重构后 settings.model_presets 不再包含 virtual "default"。
  // 当 value === "default"(初始状态或删除 preset 后的回退)时,下拉列表中
  // 没有匹配项,此时显示占位符"默认配置(Default)"让用户知道当前是 fallback 状态。
  const selectedPreset = presets.find((preset) => preset.name === value) ?? null;
  const isDefaultFallback = value === "default" || !value;
  const defaultLabel = tx("settings.models.defaultPreset", "Default configuration");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={!presets.length && isDefaultFallback}>
        <Button
          type="button"
          variant="outline"
          disabled={!presets.length && isDefaultFallback}
          className={cn(
            "h-10 w-[min(340px,72vw)] justify-between rounded-full border-input bg-background px-3 text-[13px] font-normal shadow-none",
            "hover:bg-accent/55 focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {selectedPreset ? (
            <ModelPresetOptionContent
              preset={selectedPreset}
              settings={settings}
              draftModel={draftModel}
              draftProvider={draftProvider}
              showProviderLogos={showProviderLogos}
              compact
            />
          ) : isDefaultFallback ? (
            <span className="flex min-w-0 items-center gap-2.5">
              <ProviderPickerIcon provider="auto" showBrandLogos={showProviderLogos} />
              <span className="min-w-0 text-left leading-tight">
                <span className="block truncate font-medium text-foreground">
                  {draftModel || defaultLabel}
                </span>
                <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">
                  {defaultLabel}
                </span>
              </span>
            </span>
          ) : (
            <span className="truncate text-muted-foreground">
              {tx("settings.models.selectModel", "Select model")}
            </span>
          )}
          <ChevronDown className="ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[20rem] w-[340px] max-w-[calc(100vw-2rem)] overflow-y-auto"
      >
        {presets.map((preset) => {
          const selected = preset.name === value;
          return (
            <DropdownMenuItem
              key={preset.name}
              onSelect={() => onChange(preset.name)}
              className={cn(
                "flex cursor-default items-center justify-between gap-3 rounded-[12px] px-2.5 py-2 text-[13px]",
                "focus:bg-muted/85 focus:text-foreground",
                selected && "bg-muted/80 text-foreground focus:bg-muted",
              )}
            >
              <ModelPresetOptionContent
                preset={preset}
                settings={settings}
                draftModel={draftModel}
                draftProvider={draftProvider}
                showProviderLogos={showProviderLogos}
              />
              {selected ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
            </DropdownMenuItem>
          );
        })}
        <div className="mt-1 border-t border-border/55 pt-1">
          <DropdownMenuItem
            onSelect={onCreateConfiguration}
            className={cn(
              "flex cursor-default items-center gap-2 rounded-[12px] px-2.5 py-2 text-[13px] font-medium",
              "text-foreground focus:bg-muted/85 focus:text-foreground",
            )}
          >
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
              <Plus className="h-3.5 w-3.5" aria-hidden />
            </span>
            <span>{tx("settings.models.addConfiguration", "Add configuration")}</span>
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ModelPresetOptionContent({
  preset,
  settings,
  draftModel,
  draftProvider,
  showProviderLogos,
  compact = false,
}: {
  preset: SettingsPayload["model_presets"][number];
  settings: SettingsPayload;
  draftModel: string;
  draftProvider: string;
  showProviderLogos: boolean;
  compact?: boolean;
}) {
  const provider = modelPresetProviderKey(preset, settings, {
    draftProvider: preset.is_default ? draftProvider : undefined,
  });
  const model = preset.is_default ? draftModel : preset.model;
  const providerName = providerDisplayLabel(settings.providers, provider);
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <ProviderPickerIcon provider={provider} showBrandLogos={showProviderLogos} />
      <span className="min-w-0 text-left leading-tight">
        <span className="block truncate font-medium text-foreground">{model || preset.label}</span>
        <span
          className={cn(
            "mt-0.5 block truncate text-muted-foreground",
            compact ? "text-[11.5px]" : "text-[12px]",
          )}
        >
          {providerName}
          {preset.label ? ` · ${preset.label}` : ""}
        </span>
      </span>
    </span>
  );
}

function RestartSettingsFooter({
  dirty,
  saving,
  pendingRestart,
  disabled = false,
  message,
  dirtyMessage,
  pendingMessage,
  onSave,
  onRestart,
  onReset,
  isRestarting,
}: {
  dirty: boolean;
  saving: boolean;
  pendingRestart: boolean;
  disabled?: boolean;
  message?: string;
  dirtyMessage?: string;
  pendingMessage?: string;
  onSave: () => void;
  onRestart?: () => void;
  onReset?: () => void;
  isRestarting?: boolean;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const isNativeHost = getHostApi() !== null;
  const restartLabel = isNativeHost
    ? tx("app.system.restartEngine", "Restart engine")
    : t("app.system.restart");
  const restartingLabel = isNativeHost
    ? tx("app.system.restartingEngine", "Restarting engine...")
    : t("app.system.restarting");
  const statusMessage =
    message ??
    (pendingRestart && !dirty
      ? pendingMessage ?? tx("settings.status.savedRestartApply", "Saved. Restart when ready.")
      : dirty
        ? dirtyMessage ?? t("settings.status.unsaved")
        : undefined);
  const statusTone = disabled ? "danger" : dirty || pendingRestart ? "accent" : undefined;

  return (
    <div className="flex min-h-[58px] flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="min-w-0 text-[13px] leading-5 text-muted-foreground">
        <SettingsStatusMessage tone={statusTone}>{statusMessage}</SettingsStatusMessage>
      </div>
      <div className="flex w-full shrink-0 flex-wrap justify-end gap-2 sm:w-auto">
        {pendingRestart && !dirty && onRestart ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={onRestart}
            disabled={isRestarting}
            className="rounded-full"
          >
            {isRestarting ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            )}
            {isRestarting ? restartingLabel : restartLabel}
          </Button>
        ) : null}
        {onReset ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={onReset}
            disabled={!dirty || saving}
            className="rounded-full"
          >
            {t("settings.actions.cancel")}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={onSave}
          disabled={!dirty || disabled || saving}
          className="rounded-full"
        >
          {saving ? t("settings.actions.saving") : t("settings.actions.save")}
        </Button>
      </div>
    </div>
  );
}

function SettingsFooter({
  dirty,
  saving,
  saved,
  disabled = false,
  message,
  onSave,
  savingLabel,
}: {
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  disabled?: boolean;
  message?: string;
  onSave: () => void;
  savingLabel?: string;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const statusMessage = message ?? (dirty
    ? t("settings.status.unsaved")
    : saved
      ? t("settings.status.savedRestart")
      : tx("settings.status.upToDate", "Up to date."));
  return (
    <div className="flex min-h-[58px] flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="text-[13px] text-muted-foreground">
        <SettingsStatusMessage tone={disabled ? "danger" : dirty || saved ? "accent" : undefined}>
          {statusMessage}
        </SettingsStatusMessage>
      </div>
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={onSave} disabled={!dirty || disabled || saving} className="rounded-full">
          {saving ? (savingLabel ?? t("settings.actions.saving")) : t("settings.actions.save")}
        </Button>
      </div>
    </div>
  );
}

function SettingsStatusMessage({
  children,
  tone,
}: {
  children?: ReactNode;
  tone?: "accent" | "danger";
}) {
  if (!children) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2",
        tone === "accent" && "font-medium text-blue-600 dark:text-blue-300",
        tone === "danger" && "font-medium text-destructive",
      )}
    >
      {tone ? (
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            tone === "accent" &&
              "bg-blue-500 shadow-[0_0_0_3px_rgba(59,130,246,0.14)] dark:bg-blue-400 dark:shadow-[0_0_0_3px_rgba(96,165,250,0.18)]",
            tone === "danger" && "bg-destructive/70",
          )}
          aria-hidden
        />
      ) : null}
      <span>{children}</span>
    </span>
  );
}

function StatusPill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning";
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-[260px] items-center rounded-full px-2.5 py-1 text-[12px] font-medium",
        tone === "success" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        tone === "warning" && "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        tone === "neutral" && "bg-muted text-muted-foreground",
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

function SegmentedControl({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="inline-flex h-8 items-center rounded-full bg-muted p-0.5 text-[12px] font-medium text-muted-foreground">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-full px-3 py-1 transition-colors",
            value === option.value && "bg-background text-foreground shadow-sm",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ToggleButton({
  checked,
  onChange,
  ariaLabel,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel?: string;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel ?? label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full p-[2px]",
        "transition-colors duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        checked
          ? "bg-[#2997FF] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.035)]"
          : "bg-muted shadow-[inset_0_0_0_1px_rgba(0,0,0,0.035)] hover:bg-muted/80",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "h-[18px] w-[18px] rounded-full bg-background shadow-[0_1px_2px_rgba(0,0,0,0.18),0_2px_7px_rgba(0,0,0,0.11)]",
          "transition-transform duration-200 ease-out",
          checked ? "translate-x-[16px]" : "translate-x-0",
        )}
      />
      <span className="sr-only">{label}</span>
    </button>
  );
}

function NumberInput({
  value,
  min,
  max,
  onChange,
  suffix,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  suffix?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        className="h-8 w-24 rounded-full text-[13px]"
      />
      {suffix ? <span className="text-[12px] text-muted-foreground">{suffix}</span> : null}
    </div>
  );
}
