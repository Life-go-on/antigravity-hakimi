  // -------------------------------------------------------------
  // -------------------------------------------------------------
  // 模块 1.5: 插件面板语言 (Context Meter) 与客户端语言 (Antigravity)
  // -------------------------------------------------------------
  const panelLangBtns = {
    'zh-CN': el('btn-panel-lang-zh-CN'),
    'zh-TW': el('btn-panel-lang-zh-TW'),
    en: el('btn-panel-lang-en')
  };
  const panelTopLangBtns = {
    'zh-CN': el('btn-top-lang-zh-CN'),
    'zh-TW': el('btn-top-lang-zh-TW'),
    en: el('btn-top-lang-en')
  };
  const panelLangSaveBadge = el('panel-lang-save-badge');
  const btnClientLangZhCn = el('btn-client-lang-zh-CN');
  const btnClientLangEn = el('btn-client-lang-en');

  function syncPanelLanguageButtons(lang) {
    const normalized = normalizePanelLanguage(lang);
    for (const [k, btn] of Object.entries(panelLangBtns)) {
      if (!btn) continue;
      const active = k === normalized;
      if (active) addClass(btn, 'active');
      else removeClass(btn, 'active');
      btn.setAttribute?.('aria-pressed', String(active));
    }
    for (const [k, btn] of Object.entries(panelTopLangBtns)) {
      if (!btn) continue;
      const active = k === normalized;
      if (active) addClass(btn, 'active');
      else removeClass(btn, 'active');
      btn.setAttribute?.('aria-pressed', String(active));
      btn.setAttribute?.('aria-selected', String(active));
    }
  }

  function syncClientLanguageButtons() {
    if (btnClientLangZhCn) {
      if (currentChineseEnabled) addClass(btnClientLangZhCn, 'active');
      else removeClass(btnClientLangZhCn, 'active');
      btnClientLangZhCn.setAttribute?.('aria-pressed', String(currentChineseEnabled));
    }
    if (btnClientLangEn) {
      if (!currentChineseEnabled) addClass(btnClientLangEn, 'active');
      else removeClass(btnClientLangEn, 'active');
      btnClientLangEn.setAttribute?.('aria-pressed', String(!currentChineseEnabled));
    }
  }

  async function applyPanelLanguage(lang, opts = {}) {
    const nextLang = normalizePanelLanguage(lang);
    const persist = opts.persist !== false;
    setPanelLanguageInternal(nextLang);
    syncPanelLanguageButtons(nextLang);
    applyStaticPanelTranslations(shadow);

    try {
      if (colorDrawerArrow && colorDrawerBody) {
        const open = colorDrawerBody.style.display === 'block';
        colorDrawerArrow.textContent = open ? t('drawer.colors.collapse') : t('drawer.colors.expand');
      }
      if (drawerArrow && drawerBody) {
        const open = drawerBody.style.display === 'block';
        drawerArrow.textContent = open ? t('session.techDrawer.collapse') : t('session.techDrawer.expand');
      }
      if (tokenColorDrawerArrow && tokenColorDrawerBody) {
        const open = tokenColorDrawerBody.style.display === 'block';
        tokenColorDrawerArrow.textContent = open ? t('drawer.colors.collapse') : t('drawer.colors.expand');
      }
      const btnPlanDet = el('btn-plan-detail-toggle');
      if (btnPlanDet) {
        btnPlanDet.textContent = planDetailExpanded ? t('plan.detail.toggleClose') : t('plan.detail.toggleOpen');
      }
    } catch {}
    try { if (typeof applyTheme === 'function') applyTheme(); } catch {}
    try { renderVersionSyncBanner(); } catch {}
    try { renderSshRemoteContextBanners(); } catch {}
    try { render(); } catch {}
    try { renderSpeedComparisonTab(); } catch {}
    try { renderCliUnlockState(currentCliUnlockStatus); } catch {}
    try {
      if (typeof renderPlanDetail === 'function' && ANTIGRAVITY_TOKEN_DATA?.planStatus) {
        renderPlanDetail(ANTIGRAVITY_TOKEN_DATA.planStatus);
      }
    } catch {}
    try {
      if (isChineseExpanded || isContextSettingsView) {
        void refreshModulesDisplay();
      }
      if (isContextSettingsView) {
        void refreshCliUnlockDisplay();
        if (typeof refreshAccountsStatus === 'function') void refreshAccountsStatus({ silent: true });
      }
    } catch {}
    try {
      if (typeof applyTokenHistoryPayload === 'function' && ANTIGRAVITY_TOKEN_DATA) {
        applyTokenHistoryPayload(ANTIGRAVITY_TOKEN_DATA);
      }
    } catch {}
    try {
      if (typeof quotaShadow !== 'undefined' && quotaShadow) {
        applyStaticPanelTranslations(quotaShadow);
      }
      if (typeof shortcutsShadow !== 'undefined' && shortcutsShadow) {
        applyStaticPanelTranslations(shortcutsShadow);
      }
      if (typeof accountsShadow !== 'undefined' && accountsShadow) {
        applyStaticPanelTranslations(accountsShadow);
      }
      if (typeof renderModelQuota === 'function') {
        renderModelQuota(true);
      }
      if (typeof renderAccountsUI === 'function') {
        renderAccountsUI();
      }
      if (typeof renderModelShortcutsPopover === 'function' && typeof shortcutsPopoverOpen !== 'undefined' && shortcutsPopoverOpen) {
        renderModelShortcutsPopover();
      }
    } catch {}

    if (persist) {
      userActionSeq++;
      try { localStorage?.setItem('ag_panel_language', nextLang); } catch {}
      const res = await saveSettingsPayloadBridge({
        panelLanguage: nextLang,
        uiPreferences: { panelLanguage: nextLang }
      });
      if (panelLangSaveBadge) {
        panelLangSaveBadge.textContent = res?.ok ? t('settings.panelLang.saved') : t('settings.panelLang.saveLocal');
        panelLangSaveBadge.className = `key-pill ${res?.ok ? 'pill-ok' : 'pill-warn'}`;
        panelLangSaveBadge.hidden = false;
      }
    }
  }

  function setPanelLanguageInternal(lang) {
    currentPanelLanguage = normalizePanelLanguage(lang);
  }

  for (const [langCode, btn] of Object.entries(panelLangBtns)) {
    btn?.addEventListener('click', () => {
      void applyPanelLanguage(langCode, { persist: true });
    });
  }

  for (const [langCode, btn] of Object.entries(panelTopLangBtns)) {
    btn?.addEventListener('click', () => {
      void applyPanelLanguage(langCode, { persist: true });
    });
  }

  // 模块 2: 客户端界面汉化 (AntigravityChinese)
  // -------------------------------------------------------------
  const btnToggleChinese = el('btn-toggle-chinese');
  const chineseDrawerBody = el('chinese-drawer-body');
  const chineseDrawerArrow = el('chinese-drawer-arrow');
  const chineseBadge = el('chinese-badge');
  const chineseStatusDesc = el('chinese-status-desc');
  const btnToggleChineseModule = el('btn-toggle-chinese-module');

  let isChineseExpanded = false;
  let currentChineseEnabled = false;

  btnToggleChinese?.addEventListener('click', () => {
    isChineseExpanded = !isChineseExpanded;
    if (chineseDrawerBody) chineseDrawerBody.style.display = isChineseExpanded ? 'block' : 'none';
    if (chineseDrawerArrow) chineseDrawerArrow.textContent = isChineseExpanded ? t('drawer.collapse') : t('drawer.expand');
    btnToggleChinese?.setAttribute('aria-expanded', String(isChineseExpanded));
    if (isChineseExpanded) {
      void refreshModulesDisplay();
    }
  });

  const btnClientLangRestart = el('btn-client-lang-restart');
  const clientLangResultBox = el('client-lang-result');
  const clientLangResultText = el('client-lang-result-text');

  function showClientLangResult(ok, message) {
    if (!clientLangResultBox || !clientLangResultText) return;
    clientLangResultBox.style.display = 'block';
    clientLangResultBox.className = `unlock-result-box ${ok ? 'result-success' : 'result-error'}`;
    clientLangResultText.textContent = message;
  }

  btnClientLangRestart?.addEventListener('click', openClientRestartConfirmFlow);

  let lastVersionSyncState = null;

  function renderVersionSyncBanner(vs = lastVersionSyncState) {
    const banner = el('version-sync-banner');
    const textEl = el('version-sync-text');
    if (!banner || !textEl) return;
    if (vs && vs.outdated && vs.officialVersion && vs.hakimiVersion) {
      textEl.textContent = t('versionSync.mismatch', {
        officialVer: vs.officialVersion,
        hakimiVer: vs.hakimiVersion
      });
      banner.hidden = false;
    } else {
      textEl.textContent = '';
      banner.hidden = true;
    }
  }

  async function refreshModulesDisplay() {
    try {
      const res = await invokeModulesApi('status');
      if (!res || !res.ok || !res.data) {
        const errMsg = (res && res.error) ? translateBackendText(res.error) : t('msg.unknownErr');
        if (chineseBadge) {
          chineseBadge.textContent = t('mod.readFail');
          chineseBadge.className = 'key-pill pill-danger';
        }
        if (chineseStatusDesc) {
          chineseStatusDesc.textContent = t('mod.zh.failDetect', { err: errMsg });
        }
        return;
      }
      lastVersionSyncState = res.versionSync || null;
      renderVersionSyncBanner(lastVersionSyncState);
      const cfg = res.data;

      currentChineseEnabled = Boolean(cfg.modules?.chinese?.enabled);
      // 判定宿主界面是否已翻译：定向检查系统导航、活动栏、菜单及操作按钮等固有系统壳层（排除用户消息内容区域）
      const isDomTranslated = (() => {
        if (typeof window.__AGY_I18N_DATA__ !== 'undefined' || typeof window.__AGY_TRANSLATE_EL__ !== 'undefined') {
          return true;
        }
        try {
          const systemContainers = document.querySelectorAll(
            "div[role='navigation'], nav, header, [role='banner'], aside, [data-testid*='sidebar'], [data-testid*='navigation'], [class*='@container/titlebar'], .monaco-workbench, .activitybar"
          );
          const systemKeywords = ['新建对话', '新建会话', '新建', '设置', '账户', '项目', '关于', '帮助', '工作区', '管理', '自定义扩展', '资源管理器', '活动栏'];
          for (let i = 0; i < systemContainers.length; i++) {
            const container = systemContainers[i];
            if (container.closest && container.closest('.chat-session, .conversation-view, .monaco-list-row, .markdown, [data-testid*="chat"], [data-testid*="message"]')) {
              continue; // 严格排除用户聊天内容区
            }
            const labeledNodes = container.querySelectorAll ? container.querySelectorAll('button, a, [role="button"], [aria-label], [title], span') : [];
            for (let j = 0; j < Math.min(labeledNodes.length, 40); j++) {
              const node = labeledNodes[j];
              const label = (node.getAttribute && (node.getAttribute('aria-label') || node.getAttribute('title'))) || '';
              if (label && systemKeywords.some(kw => label.includes(kw))) return true;
              const text = (node.textContent || '').trim();
              if (text && systemKeywords.some(kw => text.includes(kw))) return true;
            }
            const txt = container.innerText || '';
            if (systemKeywords.some(kw => txt.includes(kw))) return true;
          }
          const nav = document.querySelector("div[role='navigation'], nav");
          if (nav && nav.innerText && systemKeywords.some(kw => nav.innerText.includes(kw))) {
            return true;
          }
        } catch {}
        return false;
      })();
      const disk = res.disk || {};

      if (chineseBadge) {
        if (!currentChineseEnabled) {
          if (isDomTranslated) {
            chineseBadge.textContent = t('mod.zh.badgeRestartEn');
            chineseBadge.className = 'key-pill pill-warn';
          } else {
            chineseBadge.textContent = disk.chinese ? t('mod.zh.badgeOffReady') : t('mod.zh.badgeNotInstalled');
            chineseBadge.className = 'key-pill pill-muted';
          }
        } else if (isDomTranslated) {
          chineseBadge.textContent = t('mod.zh.badgeActive');
          chineseBadge.className = 'key-pill pill-ok';
        } else if (!disk.chinese) {
          chineseBadge.textContent = t('mod.zh.badgeNotInjected');
          chineseBadge.className = 'key-pill pill-danger';
        } else {
          chineseBadge.textContent = t('mod.zh.badgePendingRestart');
          chineseBadge.className = 'key-pill pill-warn';
        }
      }
      if (chineseStatusDesc) {
        if (!currentChineseEnabled) {
          if (isDomTranslated) {
            chineseStatusDesc.textContent = t('mod.zh.descRestartEn');
          } else {
            chineseStatusDesc.textContent = disk.chinese
              ? t('mod.zh.descOffReady')
              : t('mod.zh.descOffNotInstalled');
          }
        } else if (isDomTranslated) {
          chineseStatusDesc.textContent = t('mod.zh.descActive');
        } else if (!disk.chinese) {
          chineseStatusDesc.textContent = t('mod.zh.descNeedInject');
        } else {
          chineseStatusDesc.textContent = t('mod.zh.descPendingRestart');
        }
      }
      if (btnToggleChineseModule) {
        btnToggleChineseModule.textContent = currentChineseEnabled ? t('mod.zh.btnDisable') : t('mod.zh.btnEnable');
      }
      syncClientLanguageButtons();
    } catch (err) {
      const errMsg = err?.message || String(err);
      if (chineseBadge) {
        chineseBadge.textContent = t('mod.readErr');
        chineseBadge.className = 'key-pill pill-danger';
      }
      if (chineseStatusDesc) {
        chineseStatusDesc.textContent = t('mod.zh.errDetect', { err: errMsg });
      }
    }
  }

  async function setClientLanguageTarget(wantChinese) {
    if (Boolean(wantChinese) === Boolean(currentChineseEnabled)) return;
    if (btnToggleChineseModule) {
      btnToggleChineseModule.disabled = true;
      btnToggleChineseModule.textContent = t('mod.processing');
    }
    try {
      const res = await invokeModulesApi('toggle', 'chinese', Boolean(wantChinese), {
        language: wantChinese ? 'zh-CN' : 'en'
      });
      if (!res || !res.ok) {
        showClientLangResult(false, translateBackendText(res?.error) || t('mod.zh.toggleFail'));
      } else {
        needsRestartAfterApply = true;
        if (btnClientLangRestart) btnClientLangRestart.hidden = false;
        showClientLangResult(true, t('msg.appliedRestart'));
      }
      await refreshModulesDisplay();
    } catch (e) {
      showClientLangResult(false, `${t('mod.zh.toggleFail')}: ${e.message}`);
    } finally {
      if (btnToggleChineseModule) {
        btnToggleChineseModule.disabled = false;
        btnToggleChineseModule.textContent = currentChineseEnabled ? t('mod.zh.btnDisable') : t('mod.zh.btnEnable');
      }
    }
  }

  btnClientLangZhCn?.addEventListener('click', () => {
    void setClientLanguageTarget(true);
  });
  btnClientLangEn?.addEventListener('click', () => {
    void setClientLanguageTarget(false);
  });

  btnToggleChineseModule?.addEventListener('click', () => {
    void setClientLanguageTarget(!currentChineseEnabled);
  });

  const cliUnlockBadge = el('cli-unlock-badge');
  const cliUnlockMeta = el('cli-unlock-meta');
  const btnCliUnlockApply = el('btn-cli-unlock-apply');
  const btnCliUnlockRefresh = el('btn-cli-unlock-refresh');
  const cliUnlockResultBox = el('cli-unlock-result');
  const cliUnlockResultText = el('cli-unlock-result-text');

  let currentCliUnlockStatus = null;
  let isCliUnlockBusy = false;

  async function invokeCliUnlockApi(action, opts = {}) {
    if (action === 'status' && window.contextMeterAPI?.getCliUnlockStatus) {
      return await window.contextMeterAPI.getCliUnlockStatus(opts);
    }
    if (action === 'apply' && window.contextMeterAPI?.applyCliUnlock) {
      return await window.contextMeterAPI.applyCliUnlock(opts);
    }
    return { ok: false, error: t('models.err.noApplyBridge'), unavailable: true };
  }

  function renderCliUnlockState(res = currentCliUnlockStatus) {
    if (!cliUnlockBadge || !cliUnlockMeta) return;
    if (!res || !res.ok || !res.data) {
      cliUnlockBadge.textContent = t('status.badge.unavailable');
      cliUnlockBadge.className = 'key-pill pill-muted';
      cliUnlockMeta.textContent = res?.error ? translateBackendText(res.error) : '—';
      if (btnCliUnlockApply) btnCliUnlockApply.disabled = true;
      return;
    }

    const d = res.data;
    const region = d.regionUnlock && d.regionUnlock.status && d.regionUnlock.status !== 'missing'
      ? d.regionUnlock
      : null;
    const patchedCount = region && region.status === 'patched' ? 1 : 0;
    const totalCount = region ? 1 : 0;

    if (d.status === 'patched') {
      cliUnlockBadge.textContent = t('settings.cliUnlock.patched', { ok: patchedCount || 1, total: totalCount || 1 });
      cliUnlockBadge.className = 'key-pill pill-ok';
    } else if (d.status === 'partial') {
      cliUnlockBadge.textContent = t('settings.cliUnlock.partial');
      cliUnlockBadge.className = 'key-pill pill-warn';
    } else if (d.status === 'not_found') {
      cliUnlockBadge.textContent = t('settings.cliUnlock.notFound');
      cliUnlockBadge.className = 'key-pill pill-muted';
    } else if (d.status === 'unsupported') {
      cliUnlockBadge.textContent = t('settings.cliUnlock.unsupported');
      cliUnlockBadge.className = 'key-pill pill-danger';
    } else {
      cliUnlockBadge.textContent = t('settings.cliUnlock.unpatched');
      cliUnlockBadge.className = 'key-pill pill-muted';
    }

    const metaParts = [];
    if (d.realPath || d.binaryPath) {
      metaParts.push(t('settings.cliUnlock.metaPath', { path: d.realPath || d.binaryPath }));
    } else if (d.message) {
      metaParts.push(translateBackendText(d.message));
    }
    if (Array.isArray(d.brokenSymlinks) && d.brokenSymlinks.length > 0) {
      metaParts.push(t('settings.cliUnlock.brokenLinks', {
        paths: d.brokenSymlinks.map(s => s.path).join(', ')
      }));
    }
    cliUnlockMeta.textContent = metaParts.join(' · ') || '—';

    if (btnCliUnlockApply) {
      const blocked = d.status === 'not_found' || d.status === 'unsupported' || d.status === 'partial';
      btnCliUnlockApply.disabled = isCliUnlockBusy || blocked;
      btnCliUnlockApply.textContent = isCliUnlockBusy ? t('settings.cliUnlock.busy') : t('settings.cliUnlock.applyBtn');
    }
  }

  async function refreshCliUnlockDisplay(opts = {}) {
    try {
      const res = await invokeCliUnlockApi('status', opts);
      currentCliUnlockStatus = res;
      renderCliUnlockState(res);
      return res;
    } catch (err) {
      const fallback = { ok: false, error: err?.message || t('msg.unknownErr') };
      currentCliUnlockStatus = fallback;
      renderCliUnlockState(fallback);
      return fallback;
    }
  }

  btnCliUnlockRefresh?.addEventListener('click', () => {
    void refreshCliUnlockDisplay();
  });

  btnCliUnlockApply?.addEventListener('click', async () => {
    if (isCliUnlockBusy) return;
    isCliUnlockBusy = true;
    renderCliUnlockState(currentCliUnlockStatus);
    if (cliUnlockResultBox) cliUnlockResultBox.style.display = 'none';
    try {
      const res = await invokeCliUnlockApi('apply', {});
      if (!res || !res.ok) {
        if (cliUnlockResultBox && cliUnlockResultText) {
          cliUnlockResultBox.className = 'unlock-result-box result-error';
          cliUnlockResultBox.style.display = 'block';
          cliUnlockResultText.textContent = buildFriendlyWriteError(res?.error);
        }
      } else {
        if (cliUnlockResultBox && cliUnlockResultText) {
          cliUnlockResultBox.className = 'unlock-result-box result-success';
          cliUnlockResultBox.style.display = 'block';
          cliUnlockResultText.textContent = res.message || t('msg.applied');
        }
      }
      await refreshCliUnlockDisplay();
    } catch (err) {
      if (cliUnlockResultBox && cliUnlockResultText) {
        cliUnlockResultBox.className = 'unlock-result-box result-error';
        cliUnlockResultBox.style.display = 'block';
        cliUnlockResultText.textContent = buildFriendlyWriteError(err?.message);
      }
    } finally {
      isCliUnlockBusy = false;
      renderCliUnlockState(currentCliUnlockStatus);
    }
  });

  // 静默初始化检测各模块状态
  setTimeout(() => {
    void refreshModulesDisplay();
    void refreshCliUnlockDisplay();
  }, 500);
  setTimeout(() => {
    if (currentChineseEnabled) {
      void refreshModulesDisplay();
    }
  }, 2000);

  // 二级抽屉 1（面板 B 内）: 指标与背景颜色自定义抽屉折叠展开
  const btnColors = el('btn-toggle-colors');
  const colorDrawerBody = el('color-drawer-body');
  const colorDrawerArrow = el('color-drawer-arrow');
  function toggleColorsDrawer(forceOpen) {
    if (!colorDrawerBody) return;
    const isHidden = colorDrawerBody.style.display === 'none' || !colorDrawerBody.style.display;
    const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : isHidden;
    colorDrawerBody.style.display = nextOpen ? 'block' : 'none';
    if (colorDrawerArrow) colorDrawerArrow.textContent = nextOpen ? t('drawer.colors.collapse') : t('drawer.colors.expand');
    btnColors?.setAttribute('aria-expanded', String(nextOpen));
    if (!nextOpen) {
      closeColorPicker();
    }
  }
  btnColors?.addEventListener('click', () => toggleColorsDrawer());

  // 二级抽屉 2（面板 B 内）: 底层技术抽屉折叠展开
  const btnDetails = el('btn-toggle-details');
  const drawerBody = el('drawer-body');
  const drawerArrow = el('drawer-arrow');
  btnDetails?.addEventListener('click', () => {
    if (!drawerBody) return;
    const isHidden = drawerBody.style.display === 'none' || !drawerBody.style.display;
    drawerBody.style.display = isHidden ? 'block' : 'none';
    if (drawerArrow) drawerArrow.textContent = isHidden ? t('session.techDrawer.collapse') : t('session.techDrawer.expand');
    btnDetails.setAttribute('aria-expanded', String(isHidden));
  });

  // 二级抽屉 3（面板 A 内就近设置）: 热力图色阶与面板外观自定义抽屉折叠展开
  const btnTokenColors = el('btn-toggle-token-colors');
  const tokenColorDrawerBody = el('token-color-drawer-body');
  const tokenColorDrawerArrow = el('token-color-drawer-arrow');
  function toggleTokenColorsDrawer(forceOpen) {
    if (!tokenColorDrawerBody) return;
    const curHidden = tokenColorDrawerBody.style.display === 'none' || !tokenColorDrawerBody.style.display;
    const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : curHidden;
    tokenColorDrawerBody.style.display = nextOpen ? 'block' : 'none';
    tokenColorDrawerBody.classList?.toggle?.('is-expanded', nextOpen);
    if (tokenColorDrawerArrow) tokenColorDrawerArrow.textContent = nextOpen ? t('drawer.colors.collapse') : t('drawer.colors.expand');
    btnTokenColors?.setAttribute('aria-expanded', String(nextOpen));
    if (!nextOpen) {
      closeColorPicker(false);
    }
  }
  btnTokenColors?.addEventListener('click', () => toggleTokenColorsDrawer());
  el('heat-legend-scale')?.addEventListener('click', () => toggleTokenColorsDrawer(true));

  // 热力图视图切换（每天 / 每周 / 累计总量）

  const heatPop = el('heat-pop');
  const heatPopDate = el('heat-pop-date');
  const heatPopVal = el('heat-pop-val');
  const heatPopDet = el('heat-pop-det');

  function hidePopover() {
    if (heatPop) heatPop.style.opacity = '0';
  }

  function updateHeatTabThumb() {
    const thumb = el('heat-tab-thumb');
    const tabsBar = el('heat-tabs-bar');
    const activeBtn = el(`h-tab-${activeHeatView}`);
    if (!thumb || !tabsBar || !activeBtn) return;

    const offsetLeft = activeBtn.offsetLeft || 0;
    const offsetWidth = activeBtn.offsetWidth || 0;
    thumb.style.transform = `translateX(${offsetLeft}px)`;
    thumb.style.width = `${offsetWidth}px`;

    const thumbColor = customColors.tokenAccent || (typeof getEffectiveHeatmapScale === 'function' ? getEffectiveHeatmapScale()[4] : '#a78bfa');
    thumb.style.setProperty('--ag-tab-thumb-bg', thumbColor);
  }

  function renderActiveHeatView(forceRebuild = false) {
    if (activeHeatView === 'weekly') {
      renderHeatmapWeekly();
    } else if (activeHeatView === 'monthly') {
      renderHeatmapMonthly();
    } else if (activeHeatView === 'yearly') {
      renderHeatmapYearly();
    } else if (activeHeatView === 'cum') {
      renderHeatmapCum();
    } else {
      renderHeatmapGrid(forceRebuild);
    }
    computeTimelineWindow();
    updateHeatTabThumb();
  }

  function switchHeatView(view, save = true) {
    if (!['daily', 'weekly', 'monthly', 'yearly', 'cum'].includes(view)) view = 'daily';
    activeHeatView = view;

    const views = ['daily', 'weekly', 'monthly', 'yearly', 'cum'];
    views.forEach(v => {
      const tabBtn = el(`h-tab-${v}`);
      const box = el(`h-${v}-box`);
      const isActive = (v === view);
      if (tabBtn) {
        if (tabBtn.classList) {
          if (isActive) tabBtn.classList.add('active');
          else tabBtn.classList.remove('active');
        } else {
          const cls = (tabBtn.className || '').split(/\s+/).filter(c => c && c !== 'active');
          if (isActive) cls.push('active');
          tabBtn.className = cls.join(' ');
        }
        tabBtn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        tabBtn.setAttribute('tabindex', isActive ? '0' : '-1');
      }
      if (box) {
        if (isActive) {
          box.style.display = (v === 'weekly' || v === 'monthly' || v === 'yearly') ? 'flex' : 'block';
        } else {
          box.style.display = 'none';
        }
      }
    });

    hidePopover();
    renderActiveHeatView(true);
    updateHeatTabThumb();

    if (save && typeof window !== 'undefined' && typeof window.contextMeterAPI?.saveSettings === 'function') {
      window.contextMeterAPI.saveSettings({ savedHeatView: view });
    }
  }

  ['daily', 'weekly', 'monthly', 'yearly', 'cum'].forEach(v => {
    el(`h-tab-${v}`)?.addEventListener('click', () => switchHeatView(v));
  });

  const tabsBarEl = el('heat-tabs-bar');
  tabsBarEl?.addEventListener('keydown', e => {
    const views = ['daily', 'weekly', 'monthly', 'yearly', 'cum'];
    const curIdx = views.indexOf(activeHeatView);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIdx = (curIdx + 1) % views.length;
      switchHeatView(views[nextIdx]);
      el(`h-tab-${views[nextIdx]}`)?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIdx = (curIdx - 1 + views.length) % views.length;
      switchHeatView(views[prevIdx]);
      el(`h-tab-${views[prevIdx]}`)?.focus();
    }
  });

  // 初始化默认热力图视图状态与药丸滑块
  switchHeatView('daily', false);

  el('h-page-prev')?.addEventListener('click', () => {
    if (activeHeatView === 'monthly') {
      heatMonthOffset -= 1;
    } else if (activeHeatView === 'yearly') {
      heatYearOffset -= 1;
    } else {
      heatPageOffset -= 1;
    }
    renderActiveHeatView(true);
  });
  el('h-page-next')?.addEventListener('click', () => {
    if (activeHeatView === 'monthly') {
      if (heatMonthOffset < 0) heatMonthOffset += 1;
    } else if (activeHeatView === 'yearly') {
      if (heatYearOffset < 0) heatYearOffset += 1;
    } else {
      if (heatPageOffset < 0) heatPageOffset += 1;
    }
    renderActiveHeatView(true);
  });

  el('refresh').addEventListener('click', () => { if (state.route && !state.scanBusy) void scan(state.generation, state.route, true); });
  const outside = e => {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const pop = el('color-picker-popover');
    if (!path.includes(host)) {
      closeColorPicker(true);
      toggle(false);
      hideContextTooltip();
      hideTopbarActionTooltip(true);
      const om = el('overflow-menu');
      if (om) om.hidden = true;
      syncHostStackingElevation(false);
      return;
    }
    const isClosingNow = pop?.classList ? pop.classList.contains('is-closing') : pop?.getAttribute('data-closing') === 'true';
    if (pop && !pop.hidden && !isClosingNow) {
      const isInsidePicker = path.includes(pop);
      const isSwatchBtn = path.some(n => n?.classList?.contains?.('color-swatch-btn') || n?.classList?.contains?.('heat-leg-swatch') || n?.id?.startsWith?.('swatch-') || n?.id?.startsWith?.('heat-leg-'));
      if (!isInsidePicker && !isSwatchBtn) {
        closeColorPicker();
      }
    }
  };
  const escape = e => {
    if (e.key === 'Escape') {
      const pop = el('color-picker-popover');
      const isEscClosing = pop?.classList ? pop.classList.contains('is-closing') : pop?.getAttribute('data-closing') === 'true';
      if (pop && !pop.hidden && !isEscClosing) {
        const returnFocus = activePickerAnchor;
        closeColorPicker();
        returnFocus?.focus?.();
        return;
      }
      const tokenDrawer = el('token-color-drawer-body');
      if (tokenDrawer && tokenDrawer.style.display !== 'none') {
        toggleTokenColorsDrawer(false);
        btnTokenColors?.focus?.();
        return;
      }
      const colorDrawer = el('color-drawer-body');
      if (colorDrawer && colorDrawer.style.display !== 'none') {
        toggleColorsDrawer(false);
        btnColors?.focus?.();
        return;
      }
      toggle(false);
      hideContextTooltip();
      hideTopbarActionTooltip(true);
      const om = el('overflow-menu');
      if (om) om.hidden = true;
      syncHostStackingElevation(false);
      el('badge')?.focus?.();
    }
  };
  document.addEventListener('click', outside);
  document.addEventListener('keydown', escape);