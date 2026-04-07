// Shared overlay & manifest polling logic (enhanced + strict disabling of action buttons until manifest ready)
(function () {
    const overlay         = document.getElementById('loaderOverlay');
    const progressBar     = document.getElementById('progressBar');
    const progressText    = document.getElementById('progressText');
    const loaderMessage   = document.getElementById('loaderMessage');
    const statusDetails   = document.getElementById('statusDetails');
    const copyBtn         = document.getElementById('copyManifestBtn');
    const openBtn         = document.getElementById('openStremioBtn');

    // Polling / timing constants
    const POLL_INTERVAL_MS     = 1500;
    const MAX_WAIT_MS          = 90000;
    const PROGRESS_ESTIMATE_MS = 45000;

    let pollTimer      = null;
    let autoOpened     = false;
    let manifestUrl    = '';
    let stremioUrl     = '';
    let startTime      = 0;
    let manualPhase    = false;
    let baselinePct    = 0;
    let ready          = false;

    /* -------- Utility UI helpers -------- */

    function disableActionButtons() {
        if (openBtn) {
            openBtn.disabled = true;
            openBtn.classList.add('locked');
            openBtn.style.display = 'none'; // HIDE until ready

        }
        if (copyBtn) {
            copyBtn.disabled = true;
            copyBtn.classList.add('locked');
            copyBtn.style.display = 'none'; // HIDE until ready
        }
    }

    function enableActionButtons() {
        if (openBtn) {
            openBtn.disabled = false;
            openBtn.classList.remove('locked');
            openBtn.style.display = ''; // SHOW when ready
        }
        if (copyBtn) {
            copyBtn.disabled = false;
            copyBtn.classList.remove('locked');
            copyBtn.style.display = ''; // SHOW when ready
        }
    }

    function showOverlay(isManualPrePhase = false) {
        manualPhase = isManualPrePhase;
        if (overlay) overlay.classList.remove('hidden');
        setProgress(0, 'Initializing…');
        statusDetails && (statusDetails.textContent = '');
        autoOpened = false;
        ready = false;
        disableActionButtons(); // ALWAYS ensure disabled on open
    }

    function hideOverlay() {
        if (overlay) overlay.classList.add('hidden');
        if (pollTimer) clearTimeout(pollTimer);
    }

    function setProgress(pct, label) {
        if (progressBar) progressBar.style.width = Math.min(100, pct) + '%';
        if (progressText) progressText.textContent = `${Math.round(pct)}%`;
        if (label) loaderMessage.textContent = label;
    }

    function appendDetail(line) {
        if (!statusDetails) return;
        statusDetails.textContent += (statusDetails.textContent ? '\n' : '') + line;
        statusDetails.scrollTop = statusDetails.scrollHeight;
    }

    function progressMessage(elapsed) {
        if (elapsed < 4000)  return 'Downloading playlist…';
        if (elapsed < 10000) return 'Parsing channels…';
        if (elapsed < 18000) return 'Grouping / movies…';
        if (elapsed < 26000) return 'Fetching EPG (if enabled)…';
        if (elapsed < 35000) return 'Parsing EPG data…';
        if (elapsed < 45000) return 'Finalizing manifest…';
        return 'Almost done…';
    }

    /* -------- Polling logic -------- */

    function attemptPoll() {
        if (manualPhase) return; // Pre-flight still running client-side
        if (ready) return;

        const elapsed = Date.now() - startTime;

        // Synthetic progress up to baseline + 95%
        if (progressBar && parseFloat(progressBar.style.width) < baselinePct + 95) {
            const synthetic = baselinePct + Math.min(95, (elapsed / PROGRESS_ESTIMATE_MS) * 95);
            setProgress(synthetic, progressMessage(elapsed));
        }

        fetch(manifestUrl + '?_=' + Date.now(), { cache: 'no-store' })
            .then(r => r.ok ? r.json() : Promise.reject(r.status))
            .then(json => {
                if (json && json.id) {
                    ready = true;
                    setProgress(100, 'Ready');
                    appendDetail('Manifest ready.');
                    enableActionButtons(); // ENABLE ONLY HERE
                    // Inject a Close button (success case) if not already present
                    try {
                        const status = document.getElementById('statusDetails');
                        if (status && !document.getElementById('successCloseBtn')) {
                            const btn = document.createElement('button');
                            btn.id = 'successCloseBtn';
                            btn.textContent = 'Close';
                            btn.className = 'btn secondary';
                            btn.style.marginTop = '14px';
                            btn.addEventListener('click', hideOverlay);
                            status.parentElement.appendChild(btn);
                        }
                    } catch (e) { /* ignore DOM injection errors */ }
                    if (!autoOpened) {
                        autoOpened = true;
                        // Do not force-open if user might want to copy first.
                        // To auto-open uncomment next line:
                        // window.location.href = stremioUrl;
                    }
                    if (pollTimer) clearTimeout(pollTimer);
                    return;
                }
                scheduleNext(elapsed);
            })
            .catch(() => scheduleNext(elapsed));
    }

    function scheduleNext(elapsed) {
        if (ready) return;
        if (elapsed > MAX_WAIT_MS) {
            loaderMessage.textContent = 'Taking longer than expected.';
            appendDetail('Timeout waiting for manifest. You may retry or open later.');
            setProgress(100, 'Timeout');
            // Still allow user to copy / open after timeout
            enableActionButtons();
            return;
        }
        pollTimer = setTimeout(attemptPoll, POLL_INTERVAL_MS);
    }

    function startPolling(startPct = 50) {
        baselinePct = startPct;
        manualPhase = false;
        startTime = Date.now();
        disableActionButtons(); // Ensure still disabled when entering polling
        attemptPoll();
    }

    /* -------- Clipboard / events -------- */

    function copyManifest() {
        if (!manifestUrl || copyBtn.disabled) return;
        navigator.clipboard.writeText(manifestUrl)
            .then(() => {
                const old = copyBtn.textContent;
                copyBtn.textContent = 'Copied!';
                setTimeout(() => copyBtn.textContent = old, 1600);
            })
            .catch(() => {
                const old = copyBtn.textContent;
                copyBtn.textContent = 'Copy Failed';
                setTimeout(() => copyBtn.textContent = old, 1600);
            });
    }

    function openInStremio() {
        if (!stremioUrl || openBtn.disabled) return;
        window.location.href = stremioUrl;
    }

    if (copyBtn) copyBtn.addEventListener('click', copyManifest);
    if (openBtn) openBtn.addEventListener('click', openInStremio);

    /* -------- Token / URL builder -------- */

    function encodeConfigBase64Url(config) {
        const json = JSON.stringify(config);
        let b64 = btoa(unescape(encodeURIComponent(json)));
        return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    function buildUrls(config) {
        const token = encodeConfigBase64Url(config);
        const origin = window.location.origin;
        manifestUrl = `${origin}/${token}/manifest.json`;
        const hostPart = origin.replace(/^https?:\/\//, '');
        stremioUrl = `stremio://${hostPart}/${token}/manifest.json`;
        return { token, manifestUrl, stremioUrl };
    }

    function parseTokenConfigFromLocation() {
        const segments = window.location.pathname.split('/').filter(Boolean);
        if (segments.length < 2 || !segments[1].startsWith('configure')) return null;

        const token = decodeURIComponent(segments[0] || '');
        if (!token || token.startsWith('enc:')) return null;

        try {
            let base = token.replace(/-/g, '+').replace(/_/g, '/');
            const padNeeded = (4 - (base.length % 4)) % 4;
            if (padNeeded) base += '='.repeat(padNeeded);
            return JSON.parse(decodeURIComponent(escape(atob(base))));
        } catch {
            return null;
        }
    }

    function setInputValue(id, value) {
        const element = document.getElementById(id);
        if (!element || value === null || typeof value === 'undefined') return;

        if (element.type === 'checkbox') {
            element.checked = !!value;
            return;
        }

        element.value = String(value);
    }

    function prefillIfReconfigure(provider) {
        const config = parseTokenConfigFromLocation();
        if (!config || config.provider !== provider) return;

        if (provider === 'xtream') {
            setInputValue('xtreamUrl', config.xtreamUrl);
            setInputValue('xtreamUsername', config.xtreamUsername);

            const pwdInput = document.getElementById('xtreamPassword');
            if (pwdInput && config.xtreamPassword) {
                pwdInput.value = '********';
                pwdInput.dataset.original = config.xtreamPassword;
            }

            setInputValue('enableEpg', config.enableEpg !== false);
            setInputValue('enableXtreamProxy', !!config.xtreamProxyUrl);
            setInputValue('xtreamProxyUrl', config.xtreamProxyUrl || '');
            setInputValue('customEpgUrl', config.epgUrl || '');
            setInputValue('epgOffsetHours', config.epgOffsetHours || '');
            const epgMode = config.epgUrl ? 'custom' : 'xtream';
            const radio = document.querySelector(`input[name="epgMode"][value="${epgMode}"]`);
            if (radio) radio.checked = true;
            return;
        }

        if (provider === 'direct') {
            setInputValue('m3uUrl', config.m3uUrl);
            setInputValue('enableEpg', config.enableEpg !== false);
            setInputValue('epgUrl', config.epgUrl || '');
            setInputValue('epgOffsetHours', config.epgOffsetHours || '');
        }
    }

    /* -------- Public API -------- */

    window.ConfigureCommon = {
        showOverlay,
        hideOverlay,
        startPolling,
        buildUrls,
        overlaySetMessage(msg) { loaderMessage.textContent = msg; },
        setProgress,
        appendDetail,
        prefillIfReconfigure,
        // For direct-config pre-flight to re-disable if needed
        forceDisableActions: disableActionButtons
    };
})();
