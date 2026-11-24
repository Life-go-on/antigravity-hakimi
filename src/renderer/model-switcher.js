  // =========================================================================
  // 模型与思考强度（Effort）快速切换引擎与快捷键编解码器
  // 通过宿主 [data-testid="model-selector-trigger"] 的 React Fiber 读取原生
  // ModelSelectorProvider（selectedModel / setSelectedModel / effortIndex / groups），
  // 实现零闪烁、零延迟的原生模型与 Effort 切换，不触碰任何提示词或外发请求体。
  // =========================================================================
  const MODEL_SHORTCUT_ACTION_IDS = ['effortUp', 'effortDown', 'effortCycle', 'modelNext', 'modelPrev'];
  const EFFORT_ASC_RANK = {
    minimal: 1,
    low: 2,
    medium: 3,
    high: 4,
    xhigh: 5,
    extra: 6,
    'extra high': 7,
    max: 8
  };
  const EFFORT_CANONICAL_DISPLAY = {
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra',
    extra: 'Extra',
    'extra high': 'Extra High',
    max: 'Max'
  };
  const lastEffortByModelGroup = new Map();

  function isMacPlatform() {
    try {
      const plat = (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || '';
      return /Mac|iPhone|iPad|iPod/i.test(plat);
    } catch {
      return false;
    }
  }

  function normalizeEffortKeyToken(raw) {
    return String(raw || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  }

  function formatEffortShortName(effortKey, explicitDisplay = '') {
    const cleanExplicit = String(explicitDisplay || '').trim();
    if (cleanExplicit) return cleanExplicit;
    const norm = normalizeEffortKeyToken(effortKey);
    if (!norm) return '';
    if (EFFORT_CANONICAL_DISPLAY[norm]) return EFFORT_CANONICAL_DISPLAY[norm];
    return norm.replace(/\b[a-z]/g, ch => ch.toUpperCase());
  }

  function getEffortSortRank(effortKey, explicitOrderIdx = -1) {
    if (explicitOrderIdx >= 0) return explicitOrderIdx;
    const norm = normalizeEffortKeyToken(effortKey);
    return Object.prototype.hasOwnProperty.call(EFFORT_ASC_RANK, norm) ? EFFORT_ASC_RANK[norm] : 99;
  }

  function findHostModelSelectorContext(triggerEl = null) {
    const trigger = triggerEl || (typeof peekHostSelectedTrigger === 'function' ? peekHostSelectedTrigger() : null);
    if (!trigger || typeof trigger !== 'object') return null;
    try {
      const fiberKey = Object.keys(trigger).find(
        k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
      );
      if (!fiberKey) return null;
      let fiber = trigger[fiberKey];
      for (let depth = 0; fiber && depth < 80; depth++, fiber = fiber.return) {
        const val = fiber.memoizedProps?.value;
        if (
          val &&
          typeof val === 'object' &&
          typeof val.setSelectedModel === 'function' &&
          (val.effortIndex instanceof Map || Array.isArray(val.modelOptions) || Array.isArray(val.groups))
        ) {
          return val;
        }
      }
    } catch {}
    return null;
  }

  function sameModelOption(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.modelId && b.modelId && String(a.modelId) === String(b.modelId)) return true;
    if (a.label && b.label && String(a.label) === String(b.label)) {
      if (a.value !== undefined && b.value !== undefined) return String(a.value) === String(b.value);
      return true;
    }
    return false;
  }

  function buildEffortEntriesFromMap(groupKey, byEffortMap, groupedModelsMap, selectedModel) {
    const groupedMeta = groupedModelsMap && typeof groupedModelsMap === 'object'
      ? groupedModelsMap[groupKey]
      : null;
    const supportedLevels = Array.isArray(groupedMeta?.supportedThinkingLevels)
      ? groupedMeta.supportedThinkingLevels
      : null;
    const levelDisplayByKey = new Map();
    const levelOrderByKey = new Map();
    if (supportedLevels) {
      supportedLevels.forEach((lvl, idx) => {
        const suffix = String(lvl?.thinkingSuffix || '').trim();
        if (!suffix) return;
        if (lvl.thinkingDisplayName) levelDisplayByKey.set(suffix, String(lvl.thinkingDisplayName).trim());
        levelOrderByKey.set(suffix, idx);
      });
    }

    const entries = [];
    let seq = 0;
    for (const [effortKey, opt] of byEffortMap.entries()) {
      if (!opt) continue;
      const isSelected = sameModelOption(opt, selectedModel);
      if (opt.disabled && !isSelected) continue;
      const keyStr = String(effortKey || '').trim();
      const explicitIdx = levelOrderByKey.has(keyStr) ? levelOrderByKey.get(keyStr) : -1;
      const displayName = formatEffortShortName(keyStr, levelDisplayByKey.get(keyStr) || '');
      entries.push({
        key: keyStr,
        label: displayName,
        option: opt,
        disabled: Boolean(opt.disabled),
        _order: explicitIdx >= 0 ? explicitIdx : getEffortSortRank(keyStr, -1),
        _hasExplicitOrder: explicitIdx >= 0,
        _seq: seq++
      });
    }
    if (entries.length > 1) {
      const useExplicit = entries.every(e => e._hasExplicitOrder);
      entries.sort((a, b) => {
        if (useExplicit) return a._order - b._order;
        if (a._order !== b._order) return a._order - b._order;
        return a._seq - b._seq;
      });
    }
    return {
      baseLabel: String(groupedMeta?.displayName || '').trim(),
      entries: entries.map(({ key, label, option, disabled }) => ({ key, label, option, disabled }))
    };
  }

  function resolveBaseLabelFromOption(opt, fallbackGroupKey = '') {
    if (!opt) return String(fallbackGroupKey || '').trim();
    const g = groupProductSafe({ modelId: opt.modelId || opt.value || opt.label, label: opt.label || '' });
    return String(g?.productLabel || opt.label || fallbackGroupKey || '').trim();
  }

  function buildSwitchableModelsFromContext(ctx) {
    if (!ctx) return [];
    const selectedModel = ctx.selectedModel || null;
    const groupedModelsMap = ctx.userStatus?.cascadeModelConfigData?.groupedModels || null;
    const effortIndex = ctx.effortIndex instanceof Map ? ctx.effortIndex : null;

    // 1. 预先建立 option -> effortGroup 元数据索引
    const groupMetaByKey = new Map();
    const optionToGroupKey = new Map();
    if (effortIndex) {
      for (const [groupKey, byEffortMap] of effortIndex.entries()) {
        if (!(byEffortMap instanceof Map) || byEffortMap.size === 0) continue;
        const built = buildEffortEntriesFromMap(groupKey, byEffortMap, groupedModelsMap, selectedModel);
        if (!built.entries.length) continue;
        const firstOpt = built.entries[0].option;
        const baseLabel = built.baseLabel || resolveBaseLabelFromOption(firstOpt, groupKey);
        const meta = {
          id: String(groupKey),
          baseLabel,
          efforts: built.entries.length >= 2 ? built.entries : [],
          allOptions: built.entries.map(e => e.option),
          defaultOption: built.entries[0].option
        };
        groupMetaByKey.set(String(groupKey), meta);
        for (const opt of byEffortMap.values()) {
          if (opt) optionToGroupKey.set(opt, String(groupKey));
        }
      }
    }

    const findGroupForOption = (opt) => {
      if (!opt) return null;
      if (optionToGroupKey.has(opt)) return groupMetaByKey.get(optionToGroupKey.get(opt)) || null;
      for (const meta of groupMetaByKey.values()) {
        if (meta.allOptions.some(o => sameModelOption(o, opt))) return meta;
      }
      return null;
    };

    // 2. 按 Antigravity 原生 groups 顺序收集可切换模型（回退到 modelOptions + customModels）
    const orderedCandidates = [];
    if (Array.isArray(ctx.groups) && ctx.groups.length > 0) {
      for (const grp of ctx.groups) {
        if (!Array.isArray(grp?.options)) continue;
        for (const opt of grp.options) {
          if (opt) orderedCandidates.push(opt);
        }
      }
    } else if (Array.isArray(ctx.modelOptions)) {
      for (const opt of ctx.modelOptions) {
        if (opt) orderedCandidates.push(opt);
      }
    }
    if (Array.isArray(ctx.customModels)) {
      for (const opt of ctx.customModels) {
        if (opt && !orderedCandidates.some(o => sameModelOption(o, opt))) {
          orderedCandidates.push(opt);
        }
      }
    }

    const models = [];
    const seenIds = new Set();
    const fallbackByProductKey = new Map();

    // 当原生 effortIndex 为空时，按 groupProductSafe 自动归并同产品的不同 Effort 档位
    if (!effortIndex || effortIndex.size === 0) {
      for (const opt of orderedCandidates) {
        if (!opt || (opt.disabled && !sameModelOption(opt, selectedModel))) continue;
        const g = groupProductSafe({ modelId: opt.modelId || opt.value || opt.label, label: opt.label || '' });
        if (!g?.productKey || !g.effort) continue;
        let bucket = fallbackByProductKey.get(g.productKey);
        if (!bucket) {
          bucket = { id: g.productKey, baseLabel: g.productLabel || opt.label, entries: [] };
          fallbackByProductKey.set(g.productKey, bucket);
        }
        const effKey = normalizeEffortKeyToken(g.effort);
        if (!bucket.entries.some(e => e.key === effKey)) {
          bucket.entries.push({
            key: effKey,
            label: formatEffortShortName(effKey, g.effort),
            option: opt,
            disabled: Boolean(opt.disabled)
          });
        }
      }
      for (const bucket of fallbackByProductKey.values()) {
        bucket.entries.sort((a, b) => getEffortSortRank(a.key) - getEffortSortRank(b.key));
      }
    }

    for (const opt of orderedCandidates) {
      if (!opt) continue;
      const meta = findGroupForOption(opt);
      if (meta) {
        if (seenIds.has(meta.id)) continue;
        const enabledEfforts = meta.efforts.filter(e => !e.disabled || sameModelOption(e.option, selectedModel));
        if (meta.efforts.length >= 2 && enabledEfforts.length === 0) continue;
        if (meta.efforts.length < 2 && opt.disabled && !sameModelOption(opt, selectedModel)) continue;
        seenIds.add(meta.id);
        models.push({
          id: meta.id,
          baseLabel: meta.baseLabel,
          efforts: enabledEfforts.length >= 2 ? enabledEfforts : [],
          defaultOption: enabledEfforts[0]?.option || meta.defaultOption || opt
        });
        continue;
      }

      if (opt.disabled && !sameModelOption(opt, selectedModel)) continue;
      const g = groupProductSafe({ modelId: opt.modelId || opt.value || opt.label, label: opt.label || '' });
      const fallbackBucket = g?.productKey ? fallbackByProductKey.get(g.productKey) : null;
      if (fallbackBucket && fallbackBucket.entries.length >= 2) {
        if (seenIds.has(fallbackBucket.id)) continue;
        seenIds.add(fallbackBucket.id);
        models.push({
          id: fallbackBucket.id,
          baseLabel: fallbackBucket.baseLabel,
          efforts: fallbackBucket.entries,
          defaultOption: fallbackBucket.entries[0].option
        });
        continue;
      }

      const standaloneId = String(opt.modelId || opt.label || opt.value || '').trim();
      if (!standaloneId || seenIds.has(standaloneId)) continue;
      seenIds.add(standaloneId);
      models.push({
        id: standaloneId,
        baseLabel: String(opt.label || standaloneId).trim(),
        efforts: [],
        defaultOption: opt
      });
    }

    return models;
  }

  function inspectHostModelSwitcherState(triggerEl = null) {
    const ctx = findHostModelSelectorContext(triggerEl);
    const selected = typeof extractHostSelectedModel === 'function' ? extractHostSelectedModel() : null;
    if (!ctx) {
      const fallbackEffort = selected?.effort ? formatEffortShortName(selected.effort) : '';
      return {
        supported: false,
        ctx: null,
        selectedModel: null,
        currentGroupId: selected?.productKey || null,
        baseLabel: selected?.productLabel || selected?.rawText || '',
        effortKey: fallbackEffort ? normalizeEffortKeyToken(fallbackEffort) : null,
        effortLabel: fallbackEffort,
        efforts: [],
        effortIndex: -1,
        canStepUp: false,
        canStepDown: false,
        models: [],
        modelIndex: -1
      };
    }

    const models = buildSwitchableModelsFromContext(ctx);
    const selectedModel = ctx.selectedModel || null;
    let modelIndex = -1;
    let effortIndex = -1;
    let activeModelGroup = null;

    if (selectedModel) {
      for (let i = 0; i < models.length; i++) {
        const m = models[i];
        if (m.efforts.length > 0) {
          const eIdx = m.efforts.findIndex(e => sameModelOption(e.option, selectedModel));
          if (eIdx >= 0) {
            modelIndex = i;
            effortIndex = eIdx;
            activeModelGroup = m;
            break;
          }
        }
        if (sameModelOption(m.defaultOption, selectedModel)) {
          modelIndex = i;
          activeModelGroup = m;
          break;
        }
      }
    }

    const efforts = activeModelGroup ? activeModelGroup.efforts : [];
    const activeEffort = effortIndex >= 0 ? efforts[effortIndex] : null;
    if (activeModelGroup && activeEffort) {
      lastEffortByModelGroup.set(activeModelGroup.id, activeEffort.key);
    }

    const baseLabel = activeModelGroup?.baseLabel
      || (selectedModel ? resolveBaseLabelFromOption(selectedModel) : '')
      || selected?.productLabel
      || selected?.rawText
      || '';
    const effortKey = activeEffort?.key || (selected?.effort ? normalizeEffortKeyToken(selected.effort) : null);
    const effortLabel = activeEffort?.label || (selected?.effort ? formatEffortShortName(selected.effort) : '');

    return {
      supported: true,
      ctx,
      selectedModel,
      currentGroupId: activeModelGroup?.id || null,
      baseLabel,
      effortKey,
      effortLabel,
      efforts,
      effortIndex,
      canStepUp: efforts.length >= 2 && effortIndex >= 0 && effortIndex < efforts.length - 1,
      canStepDown: efforts.length >= 2 && effortIndex > 0,
      models,
      modelIndex
    };
  }

  function pickPreferredOptionForModelGroup(targetGroup, preferredEffortKey = '') {
    if (!targetGroup) return { option: null, effortKey: '', effortLabel: '' };
    if (!Array.isArray(targetGroup.efforts) || targetGroup.efforts.length === 0) {
      return { option: targetGroup.defaultOption || null, effortKey: '', effortLabel: '' };
    }
    const candidates = [
      preferredEffortKey,
      lastEffortByModelGroup.get(targetGroup.id) || ''
    ].filter(Boolean);
    for (const want of candidates) {
      const wantNorm = normalizeEffortKeyToken(want);
      const hit = targetGroup.efforts.find(
        e => normalizeEffortKeyToken(e.key) === wantNorm || normalizeEffortKeyToken(e.label) === wantNorm
      );
      if (hit && hit.option) {
        return { option: hit.option, effortKey: hit.key, effortLabel: hit.label };
      }
    }
    const fallback = targetGroup.efforts.find(e => e.option && !e.disabled) || targetGroup.efforts[0];
    return {
      option: fallback?.option || targetGroup.defaultOption || null,
      effortKey: fallback?.key || '',
      effortLabel: fallback?.label || ''
    };
  }

  function applyHostSelectedOption(ctx, option, groupId = '', effortKey = '') {
    if (!ctx || typeof ctx.setSelectedModel !== 'function' || !option) return false;
    if (groupId && effortKey) lastEffortByModelGroup.set(groupId, effortKey);
    ctx.setSelectedModel(option);
    if (typeof renderModelQuota === 'function') {
      try { renderModelQuota(true); } catch {}
      try {
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => { if (!state.disposed) renderModelQuota(true); });
        }
      } catch {}
      try {
        setTimeout(() => { if (!state.disposed) renderModelQuota(true); }, 80);
      } catch {}
    }
    return true;
  }

  function switchHostEffortStep(delta, opts = {}) {
    const info = inspectHostModelSwitcherState();
    if (!info.supported || !info.ctx) {
      return { ok: false, reason: 'unsupported' };
    }
    const { efforts, effortIndex, baseLabel, currentGroupId } = info;
    if (!efforts.length || efforts.length < 2 || effortIndex < 0) {
      return { ok: false, reason: 'no_efforts', modelLabel: baseLabel };
    }
    const step = delta >= 0 ? 1 : -1;
    let nextIdx = effortIndex + step;
    if (opts.wrap) {
      nextIdx = (effortIndex + step + efforts.length) % efforts.length;
    } else if (nextIdx >= efforts.length) {
      return {
        ok: false,
        reason: 'at_max',
        modelLabel: baseLabel,
        effortKey: efforts[effortIndex].key,
        effortLabel: efforts[effortIndex].label
      };
    } else if (nextIdx < 0) {
      return {
        ok: false,
        reason: 'at_min',
        modelLabel: baseLabel,
        effortKey: efforts[effortIndex].key,
        effortLabel: efforts[effortIndex].label
      };
    }
    const next = efforts[nextIdx];
    if (!next?.option) return { ok: false, reason: 'no_target' };
    applyHostSelectedOption(info.ctx, next.option, currentGroupId, next.key);
    return {
      ok: true,
      modelLabel: baseLabel,
      effortKey: next.key,
      effortLabel: next.label,
      index: nextIdx,
      total: efforts.length
    };
  }

  function cycleHostEffort() {
    return switchHostEffortStep(1, { wrap: true });
  }

  function switchHostModelStep(delta) {
    const info = inspectHostModelSwitcherState();
    if (!info.supported || !info.ctx) {
      return { ok: false, reason: 'unsupported' };
    }
    const { models, modelIndex, effortKey } = info;
    if (!models.length || models.length < 2) {
      return { ok: false, reason: 'no_models' };
    }
    const step = delta >= 0 ? 1 : -1;
    const nextIdx = modelIndex >= 0
      ? (modelIndex + step + models.length) % models.length
      : (step > 0 ? 0 : models.length - 1);
    const targetGroup = models[nextIdx];
    const remembered = lastEffortByModelGroup.get(targetGroup.id) || '';
    const picked = pickPreferredOptionForModelGroup(targetGroup, remembered || effortKey || '');
    if (!picked.option) return { ok: false, reason: 'no_target' };
    applyHostSelectedOption(info.ctx, picked.option, targetGroup.id, picked.effortKey);
    return {
      ok: true,
      modelId: targetGroup.id,
      modelLabel: targetGroup.baseLabel,
      effortKey: picked.effortKey,
      effortLabel: picked.effortLabel
    };
  }

  function switchHostModelPreset(preset) {
    if (!preset || typeof preset !== 'object') return { ok: false, reason: 'invalid_preset' };
    const info = inspectHostModelSwitcherState();
    if (!info.supported || !info.ctx) {
      return { ok: false, reason: 'unsupported' };
    }
    const wantId = String(preset.modelKey || '').trim().toLowerCase();
    const wantLabel = String(preset.modelLabel || '').trim().toLowerCase();
    const targetGroup = info.models.find(m =>
      (wantId && m.id.toLowerCase() === wantId) ||
      (wantLabel && m.baseLabel.toLowerCase() === wantLabel) ||
      (wantLabel && String(m.defaultOption?.label || '').trim().toLowerCase() === wantLabel)
    );
    if (!targetGroup) {
      return { ok: false, reason: 'model_not_found', modelLabel: preset.modelLabel || preset.modelKey || '' };
    }
    const wantEffort = String(preset.effortKey || '').trim();
    const picked = pickPreferredOptionForModelGroup(targetGroup, wantEffort || info.effortKey || '');
    if (!picked.option) {
      return { ok: false, reason: 'no_target', modelLabel: targetGroup.baseLabel };
    }
    applyHostSelectedOption(info.ctx, picked.option, targetGroup.id, picked.effortKey);
    return {
      ok: true,
      modelId: targetGroup.id,
      modelLabel: targetGroup.baseLabel,
      effortKey: picked.effortKey,
      effortLabel: picked.effortLabel
    };
  }

  // ---- 快捷键编解码、校验与跨平台展示 ----
  const CODE_TO_KEY_TOKEN = {
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight',
    Space: 'Space',
    Tab: 'Tab',
    Enter: 'Enter',
    Minus: 'Minus',
    Equal: 'Equal',
    BracketLeft: 'BracketLeft',
    BracketRight: 'BracketRight',
    Backslash: 'Backslash',
    Semicolon: 'Semicolon',
    Quote: 'Quote',
    Backquote: 'Backquote',
    Comma: 'Comma',
    Period: 'Period',
    Slash: 'Slash',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown'
  };
  const CHAR_TO_CODE_FALLBACK = {
    ' ': 'Space',
    '-': 'Minus',
    '=': 'Equal',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '\\': 'Backslash',
    ';': 'Semicolon',
    "'": 'Quote',
    '`': 'Backquote',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash'
  };
  const KEY_TOKEN_DISPLAY_COMMON = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Space: 'Space',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    Comma: ',',
    Period: '.',
    Slash: '/',
    PageUp: 'PgUp',
    PageDown: 'PgDn'
  };
  const PURE_MODIFIER_KEYS = new Set([
    'Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'OS',
    'MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight',
    'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight'
  ]);

  function extractCanonicalKeyToken(e) {
    const code = String(e?.code || '').trim();
    if (code) {
      if (/^Key[A-Z]$/.test(code)) return code;
      if (/^Digit[0-9]$/.test(code)) return code;
      if (/^F([1-9]|1[0-2])$/.test(code)) return code;
      if (CODE_TO_KEY_TOKEN[code]) return CODE_TO_KEY_TOKEN[code];
    }
    const key = String(e?.key || '').trim();
    if (!key) return '';
    if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
    if (/^[0-9]$/.test(key)) return `Digit${key}`;
    if (/^F([1-9]|1[0-2])$/i.test(key)) return key.toUpperCase();
    if (CODE_TO_KEY_TOKEN[key]) return CODE_TO_KEY_TOKEN[key];
    if (CHAR_TO_CODE_FALLBACK[key]) return CHAR_TO_CODE_FALLBACK[key];
    return '';
  }

  function isFunctionKeyToken(token) {
    return /^F([1-9]|1[0-2])$/.test(String(token || ''));
  }

  function normalizeShortcutCombo(raw) {
    if (typeof raw !== 'string') return '';
    const parts = raw.split('+').map(s => s.trim()).filter(Boolean);
    if (!parts.length) return '';
    let hasMeta = false;
    let hasCtrl = false;
    let hasAlt = false;
    let hasShift = false;
    let keyToken = '';
    for (const part of parts) {
      const low = part.toLowerCase();
      if (low === 'meta' || low === 'cmd' || low === 'command') hasMeta = true;
      else if (low === 'ctrl' || low === 'control') hasCtrl = true;
      else if (low === 'alt' || low === 'opt' || low === 'option') hasAlt = true;
      else if (low === 'shift') hasShift = true;
      else if (!keyToken) {
        keyToken = extractCanonicalKeyToken({ code: part, key: part });
      }
    }
    if (!keyToken) return '';
    if (!hasMeta && !hasCtrl && !hasAlt && !isFunctionKeyToken(keyToken)) return '';
    const out = [];
    if (hasMeta) out.push('Meta');
    if (hasCtrl) out.push('Ctrl');
    if (hasAlt) out.push('Alt');
    if (hasShift) out.push('Shift');
    out.push(keyToken);
    const combo = out.join('+');
    if (combo === 'Meta+KeyQ') return '';
    return combo;
  }

  function eventToShortcutCombo(e) {
    if (!e) return { combo: '', valid: false, reason: 'empty' };
    const rawKey = String(e.key || '');
    const rawCode = String(e.code || '');
    const hasMeta = Boolean(e.metaKey);
    const hasCtrl = Boolean(e.ctrlKey);
    const hasAlt = Boolean(e.altKey);
    const hasShift = Boolean(e.shiftKey);
    const anyMod = hasMeta || hasCtrl || hasAlt || hasShift;

    if (PURE_MODIFIER_KEYS.has(rawKey) || PURE_MODIFIER_KEYS.has(rawCode)) {
      return { combo: '', valid: false, reason: 'modifier_only' };
    }
    if (!anyMod && (rawKey === 'Escape' || rawCode === 'Escape')) {
      return { combo: '', valid: false, isCancel: true, reason: 'cancel' };
    }
    if (!anyMod && (rawKey === 'Backspace' || rawKey === 'Delete' || rawCode === 'Backspace' || rawCode === 'Delete')) {
      return { combo: '', valid: false, isClear: true, reason: 'clear' };
    }

    const token = extractCanonicalKeyToken(e);
    if (!token) {
      return { combo: '', valid: false, reason: 'unsupported_key' };
    }
    if (!hasMeta && !hasCtrl && !hasAlt && !isFunctionKeyToken(token)) {
      return { combo: '', valid: false, reason: 'need_modifier' };
    }
    const parts = [];
    if (hasMeta) parts.push('Meta');
    if (hasCtrl) parts.push('Ctrl');
    if (hasAlt) parts.push('Alt');
    if (hasShift) parts.push('Shift');
    parts.push(token);
    const combo = parts.join('+');
    if (combo === 'Meta+KeyQ') {
      return { combo: '', valid: false, reason: 'reserved' };
    }
    return { combo, valid: true, reason: '' };
  }

  function formatShortcutForDisplay(combo, macOverride = null) {
    const norm = normalizeShortcutCombo(combo);
    if (!norm) return '';
    const mac = macOverride === null ? isMacPlatform() : Boolean(macOverride);
    const parts = norm.split('+');
    const keyToken = parts.pop() || '';
    const keyDisp = /^Key([A-Z])$/.test(keyToken)
      ? keyToken.slice(3)
      : /^Digit([0-9])$/.test(keyToken)
        ? keyToken.slice(5)
        : (keyToken === 'Tab' && mac ? '⇥' : keyToken === 'Enter' && mac ? '↵' : (KEY_TOKEN_DISPLAY_COMMON[keyToken] || keyToken));

    if (mac) {
      const modOrder = ['Ctrl', 'Alt', 'Shift', 'Meta'];
      const modSym = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
      const mods = modOrder.filter(m => parts.includes(m)).map(m => modSym[m]).join('');
      return `${mods}${keyDisp}`;
    }
    const modOrder = ['Ctrl', 'Alt', 'Shift', 'Meta'];
    const modLabel = { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win' };
    const mods = modOrder.filter(m => parts.includes(m)).map(m => modLabel[m]);
    return [...mods, keyDisp].join('+');
  }

  function createEmptyModelShortcutsConfig() {
    return {
      actions: {
        effortUp: '',
        effortDown: '',
        effortCycle: '',
        modelNext: '',
        modelPrev: ''
      },
      presets: []
    };
  }

  function sanitizeModelShortcutsConfig(raw) {
    const out = createEmptyModelShortcutsConfig();
    if (!raw || typeof raw !== 'object') return out;
    const seen = new Set();
    const rawActions = raw.actions && typeof raw.actions === 'object' ? raw.actions : {};
    for (const id of MODEL_SHORTCUT_ACTION_IDS) {
      const norm = normalizeShortcutCombo(rawActions[id] || '');
      if (norm && !seen.has(norm)) {
        out.actions[id] = norm;
        seen.add(norm);
      }
    }
    if (Array.isArray(raw.presets)) {
      let seq = 0;
      for (const item of raw.presets) {
        if (!item || typeof item !== 'object') continue;
        const modelKey = String(item.modelKey || '').trim();
        const modelLabel = String(item.modelLabel || modelKey || '').trim();
        if (!modelKey && !modelLabel) continue;
        const effortKey = String(item.effortKey || '').trim();
        const effortLabel = String(item.effortLabel || (effortKey ? formatEffortShortName(effortKey) : '')).trim();
        const rawShortcut = normalizeShortcutCombo(item.shortcut || '');
        const shortcut = (rawShortcut && !seen.has(rawShortcut)) ? rawShortcut : '';
        if (shortcut) seen.add(shortcut);
        const id = String(item.id || `preset_${++seq}`).trim();
        out.presets.push({ id, modelKey: modelKey || modelLabel, modelLabel, effortKey, effortLabel, shortcut });
        if (out.presets.length >= 20) break;
      }
    }
    return out;
  }

  function countConfiguredModelShortcuts(cfg) {
    if (!cfg || typeof cfg !== 'object') return 0;
    let count = 0;
    for (const id of MODEL_SHORTCUT_ACTION_IDS) {
      if (cfg.actions?.[id]) count++;
    }
    if (Array.isArray(cfg.presets)) {
      for (const p of cfg.presets) {
        if (p?.shortcut) count++;
      }
    }
    return count;
  }
