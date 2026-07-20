// Settings 状态管理 hook:从 SettingsView.tsx 抽取的全部 state / effect / memo / callback。
//
// 行为与拆分前完全一致:
//  - 所有 useState / useRef / useEffect / useMemo / useCallback 的依赖数组保持不变
//  - 所有非 useCallback 的 async 回调(saveModelSettings / saveProvider 等)原样迁入
//  - hook 内单独调用 useTranslation(),供 setError 等回调使用
//
// 主组件只需消费返回的 state 与 callback,不再持有任何业务状态。

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
  createModelConfiguration,
  deleteModelConfiguration,
  deleteProviderSettings,
  fetchProviderModels,
  fetchSettings,
  loginProviderOAuth,
  logoutProviderOAuth,
  updateModelConfiguration,
  updateNetworkSafetySettings,
  updateProviderSettings,
  updateRuntimeSettings,
  updateSettings,
  updateWebSearchSettings,
} from "@/lib/api";
import { getHostApi } from "@/lib/runtime";
import { STORAGE_KEYS } from "@/lib/storage";
import type {
  NetworkSafetySettingsUpdate,
  RuntimeSettingsUpdate,
  SettingsPayload,
  WebSearchSettingsUpdate,
} from "@/lib/types";

import {
  EMPTY_PENDING_RESTART_SECTIONS,
  LOCAL_PREFS_STORAGE_KEY,
  extractDreamCron,
  defaultPreset,
  editableDefaultProvider,
  modelPresetValue,
  readLocalPreferences,
  visibleWebuiDefaultAccessMode,
  type AgentSettingsDraft,
  type LocalPreferences,
  type ModelConfigurationDraft,
  type PendingRestartSections,
  type ProviderForm,
  type RestartAwarePayload,
  type SettingsSectionKey,
} from "../types";

export interface UseSettingsStateParams {
  token: string;
  initialSection?: SettingsSectionKey;
  onSettingsChange?: (payload: SettingsPayload) => void;
  onModelNameChange: (modelName: string | null) => void;
  onRestart?: () => void;
}

export function useSettingsState({
  token,
  initialSection = "overview",
  onSettingsChange,
  onModelNameChange,
  onRestart,
}: UseSettingsStateParams) {
  const { t } = useTranslation();
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
  const [webSearchSaving, setWebSearchSaving] = useState(false);
  const [webSearchForm, setWebSearchForm] = useState<WebSearchSettingsUpdate>({
    enable: true,
    provider: "auto",
    max_results: 5,
    timeout: 30,
    proxy: "",
    user_agent: "",
    backends: {},
  });
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [runtimeForm, setRuntimeForm] = useState<RuntimeSettingsUpdate>({
    heartbeatIntervalS: 3600,
    dreamCron: "0 3 * * *",
    heartbeatModelPreset: "",
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
      dreamCron: extractDreamCron(payload.runtime.dream.schedule),
      heartbeatModelPreset: payload.runtime.heartbeat.model_preset ?? "",
    });
    // web_search form 从 payload 初始化;backends 的 api_key 字段用空串占位,
    // 后端只回传 hint,真实 key 不下发到前端
    if (payload.web_search) {
      const ws = payload.web_search;
      const backendsDraft: WebSearchSettingsUpdate["backends"] = {};
      for (const [name, info] of Object.entries(ws.backends ?? {})) {
        backendsDraft[name] = {
          api_key: "",
          base_url: info.base_url ?? "",
          timeout: info.timeout ?? 30,
        };
      }
      setWebSearchForm({
        enable: ws.enable,
        provider: ws.provider,
        max_results: ws.max_results,
        timeout: ws.timeout,
        proxy: ws.proxy ?? "",
        user_agent: ws.user_agent ?? "",
        backends: backendsDraft,
      });
    }
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

  const webSearchDirty = useMemo(() => {
    if (!settings?.web_search) return false;
    const ws = settings.web_search;
    if (webSearchForm.enable !== ws.enable) return true;
    if (webSearchForm.provider !== ws.provider) return true;
    if (webSearchForm.max_results !== ws.max_results) return true;
    if (webSearchForm.timeout !== ws.timeout) return true;
    if ((webSearchForm.proxy || null) !== (ws.proxy ?? null)) return true;
    if ((webSearchForm.user_agent || null) !== (ws.user_agent ?? null)) return true;
    // backends:任何 api_key 非空都视为 dirty(用户输入了新 key)
    for (const draft of Object.values(webSearchForm.backends)) {
      if (draft.api_key) return true;
    }
    // backends base_url / timeout 变化也算 dirty
    for (const [name, draft] of Object.entries(webSearchForm.backends)) {
      const cur = ws.backends?.[name];
      if (!cur) return true; // 新增后端
      if (draft.base_url !== cur.base_url) return true;
      if (draft.timeout !== cur.timeout) return true;
    }
    // 后端有但 form 没有的:用户没改动不算 dirty(初始化时已补全)
    return false;
  }, [webSearchForm, settings]);

  const runtimeDirty = useMemo(() => {
    if (!settingsRuntime) return false;
    const hbPresetChanged =
      (runtimeForm.heartbeatModelPreset ?? "") !== (settingsRuntime.heartbeat.model_preset ?? "");
    return (
      runtimeForm.heartbeatIntervalS !== settingsRuntime.heartbeat.interval_s ||
      (runtimeForm.dreamCron ?? "") !== extractDreamCron(settingsRuntime.dream.schedule) ||
      hbPresetChanged
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

  const saveWebSearchSettings = async () => {
    if (!settings || !webSearchDirty || webSearchSaving) return;
    setWebSearchSaving(true);
    try {
      const payload = await updateWebSearchSettings(token, webSearchForm);
      applyPayload(payload);
      if (payload.requires_restart) {
        setPendingRestartSections((prev) => ({ ...prev, browser: true }));
      }
      await maybeRestartHostEngine(payload);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWebSearchSaving(false);
    }
  };

  const saveRuntimeSettings = async () => {
    if (!settings || !runtimeDirty || runtimeSaving) return;
    setRuntimeSaving(true);
    try {
      const rt = settingsRuntime!;
      // 仅发送发生变化的字段,避免意外清除其他 runtime 配置。
      const update: RuntimeSettingsUpdate = {};
      if (runtimeForm.heartbeatIntervalS !== undefined && runtimeForm.heartbeatIntervalS !== rt.heartbeat.interval_s) {
        update.heartbeatIntervalS = runtimeForm.heartbeatIntervalS;
      }
      const dreamCurrent = extractDreamCron(rt.dream.schedule);
      if (runtimeForm.dreamCron !== undefined && (runtimeForm.dreamCron ?? "") !== dreamCurrent) {
        update.dreamCron = runtimeForm.dreamCron ?? "";
      }
      const hbPresetChanged =
        (runtimeForm.heartbeatModelPreset ?? "") !== (rt.heartbeat.model_preset ?? "");
      if (hbPresetChanged) {
        update.heartbeatModelPreset = runtimeForm.heartbeatModelPreset ?? "";
      }
      const payload = await updateRuntimeSettings(token, update);
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

  // 主组件 JSX 中 onChangeProviderForm 内联 lambda 抽出来的等价回调
  const changeProviderForm = useCallback((providerName: string, value: Partial<ProviderForm>) => {
    setProviderForms((prev) => ({
      ...prev,
      [providerName]: {
        apiKey: prev[providerName]?.apiKey ?? "",
        apiBase: prev[providerName]?.apiBase ?? "",
        apiType: prev[providerName]?.apiType ?? "auto",
        model: prev[providerName]?.model ?? "",
        ...value,
      },
    }));
    setProviderSaved((prev) => ({ ...prev, [providerName]: false }));
  }, []);

  return {
    // state
    settings,
    loading,
    saving,
    contextWindowLearning,
    learningProvider,
    timeoutProvider,
    contextWindowLearnTimeout,
    modelConfigurationOpen,
    modelConfigurationSaving,
    modelConfigurationForm,
    providerSaving,
    providerSaved,
    providerModels,
    providerModelsLoading,
    providerToDelete,
    providerDeleting,
    customPresetLabel,
    networkSafetySaving,
    webSearchSaving,
    webSearchForm,
    runtimeSaving,
    runtimeForm,
    hostEngineApplying,
    error,
    activeSection,
    expandedProvider,
    providerForms,
    visibleProviderKeys,
    editingProviderKeys,
    pendingRestartSections,
    localPrefs,
    networkSafetyForm,
    form,

    // derived state / memo
    settingsAdvanced,
    settingsRuntime,
    modelDirty,
    networkSafetyDirty,
    webSearchDirty,
    runtimeDirty,
    configuredModelProviderOptions,
    hasPendingRestart,

    // setters (used directly by JSX / sub-components)
    setActiveSection,
    setRuntimeForm,
    setLocalPrefs,
    setForm,
    setProviderToDelete,
    setModelConfigurationOpen,
    setModelConfigurationForm,
    setCustomPresetLabel,
    setNetworkSafetyForm,
    setWebSearchForm,
    setExpandedProvider,

    // translation helper
    text,

    // callbacks
    applyPayload,
    restartViaSettingsSurface,
    maybeRestartHostEngine,
    pollContextWindowLearning,
    saveModelSettings,
    saveContextWindow,
    openModelConfigurationDialog,
    handleCreateModelConfiguration,
    saveNetworkSafetySettings,
    saveWebSearchSettings,
    saveRuntimeSettings,
    saveProvider,
    confirmDeleteProvider,
    saveCustomConfiguration,
    fetchProviderModelList,
    runProviderOAuth,
    resetProviderDraft,
    handleToggleProvider,
    toggleProviderKeyVisibility,
    toggleProviderKeyEditing,
    changeProviderForm,
  };
}
