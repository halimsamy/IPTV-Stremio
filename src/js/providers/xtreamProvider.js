// xtreamProvider.js
// Extended to support series (shows) via Xtream API:
// - fetchData now retrieves series list when includeSeries !== false
// - fetchSeriesInfo lazily queries per-series episodes (get_series_info)
// episodes are transformed into Stremio 'videos' (season/episode).
const fetch = require('node-fetch');
const { createProxyAgent } = require('../../../proxyAgent');

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function withProxyFetchOptions(url, options = {}, proxyUrl) {
    if (!proxyUrl || options.agent) return options;

    return {
        ...options,
        agent: createProxyAgent(url, proxyUrl)
    };
}

async function fetchWithRetry(url, options = {}, retries = 2, retryDelayMs = 500, proxyUrl = '') {
    let lastError = null;
    const requestOptions = withProxyFetchOptions(url, options, proxyUrl);
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url, requestOptions);
            if (!response.ok && attempt < retries && response.status >= 500) {
                await delay(retryDelayMs * (attempt + 1));
                continue;
            }
            return response;
        } catch (error) {
            lastError = error;
            if (attempt >= retries) throw error;
            await delay(retryDelayMs * (attempt + 1));
        }
    }
    throw lastError;
}

function normalizeReleased(value) {
    if (!value) return null;
    const raw = String(value).trim();
    if (!raw) return null;

    if (/^\d{10}$/.test(raw)) {
        return new Date(parseInt(raw, 10) * 1000).toISOString();
    }
    if (/^\d{13}$/.test(raw)) {
        return new Date(parseInt(raw, 10)).toISOString();
    }

    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

async function fetchData(addonInstance) {
    const { config } = addonInstance;
    const {
        xtreamUrl,
        xtreamUsername,
        xtreamPassword,
        xtreamProxyUrl,
        xtreamUseM3U,
        xtreamOutput
    } = config;

    if (!xtreamUrl || !xtreamUsername || !xtreamPassword) {
        throw new Error('Xtream credentials incomplete');
    }

    let nextChannels = [];
    let nextMovies = [];
    let nextSeries = config.includeSeries !== false ? [] : addonInstance.series;
    let nextEpgData = {};

    if (xtreamUseM3U) {
        // M3U plus mode (series heuristic limited)
        const url =
            `${xtreamUrl}/get.php?username=${encodeURIComponent(xtreamUsername)}` +
            `&password=${encodeURIComponent(xtreamPassword)}` +
            `&type=m3u_plus` +
            (xtreamOutput ? `&output=${encodeURIComponent(xtreamOutput)}` : '');
        const resp = await fetchWithRetry(url, {
            timeout: 30000,
            headers: { 'User-Agent': 'Stremio M3U/EPG Addon (xtreamProvider/m3u)' }
        }, 2, 500, xtreamProxyUrl);
        if (!resp.ok) throw new Error('Xtream M3U fetch failed');
        const text = await resp.text();
        const items = addonInstance.parseM3U(text);

        nextChannels = items.filter(i => i.type === 'tv');
        nextMovies = items.filter(i => i.type === 'movie');

        if (config.includeSeries !== false) {
            const seriesCandidates = items.filter(i => i.type === 'series');
            // Reduce duplication by grouping by cleaned series name
            const seen = new Map();
            for (const sc of seriesCandidates) {
                const baseName = sc.name.replace(/\bS\d{1,2}E\d{1,2}\b.*$/i, '').trim();
                if (!seen.has(baseName)) {
                    seen.set(baseName, {
                        id: `iptv_series_${cryptoHash(baseName)}`,
                        series_id: cryptoHash(baseName),
                        name: baseName,
                        type: 'series',
                        poster: sc.logo || sc.attributes?.['tvg-logo'],
                        plot: sc.attributes?.['plot'] || '',
                        category: sc.category,
                        attributes: {
                            'tvg-logo': sc.logo || sc.attributes?.['tvg-logo'],
                            'group-title': sc.category || sc.attributes?.['group-title'],
                            'plot': sc.attributes?.['plot'] || ''
                        }
                    });
                }
            }
            nextSeries = Array.from(seen.values());
        }
    } else {
        // JSON API mode
        const base = `${xtreamUrl}/player_api.php?username=${encodeURIComponent(xtreamUsername)}&password=${encodeURIComponent(xtreamPassword)}`;
        // Fetch streams + category lists in parallel to map category_id -> category_name
        const [liveResp, vodResp, liveCatsResp, vodCatsResp] = await Promise.all([
            fetchWithRetry(`${base}&action=get_live_streams`, { timeout: 600000 }, 2, 500, xtreamProxyUrl),
            fetchWithRetry(`${base}&action=get_vod_streams`, { timeout: 600000 }, 2, 500, xtreamProxyUrl),
            fetchWithRetry(`${base}&action=get_live_categories`, { timeout: 300000 }, 2, 500, xtreamProxyUrl).catch(() => null),
            fetchWithRetry(`${base}&action=get_vod_categories`, { timeout: 300000 }, 2, 500, xtreamProxyUrl).catch(() => null)
        ]);

        if (!liveResp.ok) throw new Error('Xtream live streams fetch failed');
        if (!vodResp.ok) throw new Error('Xtream VOD streams fetch failed');
        const live = await liveResp.json();
        const vod = await vodResp.json();

        let liveCatMap = {};
        let vodCatMap = {};
        try {
            if (liveCatsResp && liveCatsResp.ok) {
                const arr = await liveCatsResp.json();
                if (Array.isArray(arr)) {
                    for (const c of arr) {
                        if (c && c.category_id && c.category_name)
                            liveCatMap[c.category_id] = c.category_name;
                    }
                }
            }
        } catch { /* ignore */ }
        try {
            if (vodCatsResp && vodCatsResp.ok) {
                const arr = await vodCatsResp.json();
                if (Array.isArray(arr)) {
                    for (const c of arr) {
                        if (c && c.category_id && c.category_name)
                            vodCatMap[c.category_id] = c.category_name;
                    }
                }
            }
        } catch { /* ignore */ }

        nextChannels = (Array.isArray(live) ? live : []).map(s => {
            const cat = liveCatMap[s.category_id] || s.category_name || s.category_id || 'Live';
            return {
                id: `iptv_live_${s.stream_id}`,
                name: s.name,
                type: 'tv',
                url: `${xtreamUrl}/live/${xtreamUsername}/${xtreamPassword}/${s.stream_id}.m3u8`,
                logo: s.stream_icon,
                category: cat,
                epg_channel_id: s.epg_channel_id,
                attributes: {
                    'tvg-logo': s.stream_icon,
                    'tvg-id': s.epg_channel_id,
                    'group-title': cat
                }
            };
        });

        nextMovies = (Array.isArray(vod) ? vod : []).map(s => {
            const cat = vodCatMap[s.category_id] || s.category_name || 'Movies';
            return {
                id: `iptv_vod_${s.stream_id}`,
                name: s.name,
                type: 'movie',
                url: `${xtreamUrl}/movie/${xtreamUsername}/${xtreamPassword}/${s.stream_id}.${s.container_extension}`,
                poster: s.stream_icon,
                plot: s.plot,
                year: s.releasedate ? new Date(s.releasedate).getFullYear() : null,
                addedAt: normalizeReleased(s.added || s.releasedate || null),
                category: cat,
                attributes: {
                    'tvg-logo': s.stream_icon,
                    'group-title': cat,
                    'plot': s.plot
                }
            };
        });

        if (config.includeSeries !== false) {
            try {
                const [seriesResp, seriesCatsResp] = await Promise.all([
                    fetchWithRetry(`${base}&action=get_series`, { timeout: 35000 }, 2, 500, xtreamProxyUrl),
                    fetchWithRetry(`${base}&action=get_series_categories`, { timeout: 20000 }, 2, 500, xtreamProxyUrl).catch(() => null)
                ]);
                let seriesCatMap = {};
                try {
                    if (seriesCatsResp && seriesCatsResp.ok) {
                        const arr = await seriesCatsResp.json();
                        if (Array.isArray(arr)) {
                            for (const c of arr) {
                                if (c && c.category_id && c.category_name)
                                    seriesCatMap[c.category_id] = c.category_name;
                            }
                        }
                    }
                } catch { /* ignore */ }
                if (seriesResp.ok) {
                    const seriesList = await seriesResp.json();
                    if (Array.isArray(seriesList)) {
                        nextSeries = seriesList.map(s => {
                            const cat = seriesCatMap[s.category_id] || s.category_name || 'Series';
                            return {
                                id: `iptv_series_${s.series_id}`,
                                series_id: s.series_id,
                                name: s.name,
                                type: 'series',
                                poster: s.cover,
                                plot: s.plot,
                                addedAt: normalizeReleased(s.last_modified || s.releaseDate || null),
                                category: cat,
                                attributes: {
                                    'tvg-logo': s.cover,
                                    'group-title': cat,
                                    'plot': s.plot
                                }
                            };
                        });
                    }
                }
            } catch (e) {
                // Series optional
            }
        }
    }

    // EPG handling:
    if (config.enableEpg) {
        const customEpgUrl = config.epgUrl && typeof config.epgUrl === 'string' && config.epgUrl.trim() ? config.epgUrl.trim() : null;
        const epgSource = customEpgUrl
            ? customEpgUrl
            : `${xtreamUrl}/xmltv.php?username=${encodeURIComponent(xtreamUsername)}&password=${encodeURIComponent(xtreamPassword)}`;

        try {
            const epgResp = await fetchWithRetry(epgSource, { timeout: 45000 }, 1, 500, xtreamProxyUrl);
            if (epgResp.ok) {
                const epgContent = await epgResp.text();
                nextEpgData = await addonInstance.parseEPG(epgContent);
            }
        } catch {
            // Ignore EPG errors
        }
    }

    addonInstance.channels = nextChannels;
    addonInstance.movies = nextMovies;
    if (config.includeSeries !== false) addonInstance.series = nextSeries;
    addonInstance.epgData = nextEpgData;
}

async function fetchSeriesInfo(addonInstance, seriesId) {
    // For xtream JSON API only
    const { config } = addonInstance;
    if (!seriesId) return { videos: [] };
    if (!config || !config.xtreamUrl || !config.xtreamUsername || !config.xtreamPassword) return { videos: [] };

    const base = `${config.xtreamUrl}/player_api.php?username=${encodeURIComponent(config.xtreamUsername)}&password=${encodeURIComponent(config.xtreamPassword)}`;
    try {
        const infoResp = await fetchWithRetry(
            `${base}&action=get_series_info&series_id=${encodeURIComponent(seriesId)}`,
            { timeout: 30000 },
            2,
            500,
            config.xtreamProxyUrl
        );
        if (!infoResp.ok) return { videos: [] };
        const infoJson = await infoResp.json();
        const videos = [];
        // Xtream returns episodes keyed by season: { "1": [ { id, title, container_extension, episode_num, season, ...}, ... ], "2": [...] }
        const episodesObj = infoJson.episodes || {};
        Object.keys(episodesObj).forEach(seasonKey => {
            const seasonEpisodes = episodesObj[seasonKey];
            if (Array.isArray(seasonEpisodes)) {
                seasonEpisodes.forEach((ep, index) => {
                    const epId = ep.id;
                    const container = ep.container_extension || 'mp4';
                    const url = `${config.xtreamUrl}/series/${encodeURIComponent(config.xtreamUsername)}/${encodeURIComponent(config.xtreamPassword)}/${epId}.${container}`;
                    let season = parseInt(ep.season || seasonKey, 10);
                    if (!Number.isInteger(season) || season < 1) season = 1;
                    let episode = parseInt(ep.episode_num || ep.episode || 0, 10);
                    if (!Number.isInteger(episode) || episode < 1) episode = index + 1;
                    videos.push({
                        id: `iptv_series_ep_${epId}`,
                        title: ep.title || `Episode ${ep.episode_num}`,
                        season,
                        episode,
                        released: normalizeReleased(ep.releasedate || ep.added || null),
                        thumbnail: ep.info?.movie_image || ep.info?.episode_image || ep.info?.cover_big || null,
                        url,
                        stream_id: epId
                    });
                });
            }
        });
        // Sort by season then episode
        videos.sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
        return { videos, fetchedAt: Date.now(), info: infoJson.info || null };
    } catch {
        return { videos: [] };
    }
}

function cryptoHash(text) {
    return require('crypto').createHash('md5').update(text).digest('hex').slice(0, 12);
}

module.exports = {
    fetchData,
    fetchSeriesInfo
};
