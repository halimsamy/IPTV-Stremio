// IPTV Stremio Addon Core (with debug logging + series (shows) support for BOTH Xtream & Direct M3U)
// Version 1.4.0: Adds Direct M3U series grouping + per‑episode streams
require('dotenv').config();

const { addonBuilder } = require("stremio-addon-sdk");
const crypto = require("crypto");
const { version: ADDON_VERSION } = require('./package.json');
const LRUCache = require("./lruCache");
const fetch = require('node-fetch');

let redisClient = null;
if (process.env.REDIS_URL) {
    try {
        const { Redis } = require('ioredis');
        redisClient = new Redis(process.env.REDIS_URL, {
            lazyConnect: true,
            maxRetriesPerRequest: 2
        });
        redisClient.on('error', e => console.error('[REDIS] Error:', e.message));
        redisClient.connect().catch(err => console.error('[REDIS] Connect failed:', err.message));
        console.log('[REDIS] Enabled');
    } catch (e) {
        console.warn('[REDIS] ioredis not installed or failed, falling back to in-memory LRU');
        redisClient = null;
    }
}

const ADDON_NAME = "M3U/EPG TV Addon";
const ADDON_ID = "org.stremio.m3u-epg-addon";
const BASE_CATALOG_EXTRAS = Object.freeze(['genre', 'skip']);
const DYNAMIC_CATALOG_PREFIX = Object.freeze({
    movie: 'iptv_movie_group_',
    series: 'iptv_series_group_'
});
const DEFAULT_HOME_CATEGORY_CATALOG_LIMIT = 0;
const MAX_HOME_CATEGORY_CATALOG_LIMIT = 24;

const DEBUG_ENV = (process.env.DEBUG_MODE || '').toLowerCase() === 'true';

const ALL_GENRE_LABELS = new Set([
    'all',
    'all channels',
    'all movies',
    'all series'
]);

const ARABIC_DIGIT_MAP = Object.freeze({
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
    '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
    '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9'
});

function normalizeSearchText(value) {
    return (value || '')
        .toString()
        .normalize('NFKD')
        .replace(/[٠-٩۰-۹]/g, digit => ARABIC_DIGIT_MAP[digit] || digit)
        .replace(/[\u0640\u200c\u200d]/g, '')
        .replace(/\p{M}/gu, '')
        .replace(/[أإآٱ]/g, 'ا')
        .replace(/ؤ/g, 'و')
        .replace(/ئ/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/ى/g, 'ي')
        .replace(/ء/g, '')
        .replace(/([\p{L}])(\p{N})/gu, '$1 $2')
        .replace(/(\p{N})(\p{L})/gu, '$1 $2')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .toLowerCase();
}

function extractYear(value) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    const match = String(value || '').match(/\b(19|20)\d{2}\b/);
    return match ? parseInt(match[0], 10) : null;
}

function normalizeReleasedValue(value, fallbackYear) {
    const raw = String(value || '').trim();
    if (raw) {
        const parsed = new Date(raw);
        if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
        const year = extractYear(raw);
        if (year) return `${year}-01-01T00:00:00.000Z`;
    }

    const year = extractYear(fallbackYear);
    if (year) return `${year}-01-01T00:00:00.000Z`;
    return '1970-01-01T00:00:00.000Z';
}

function normalizeAssetUrl(value) {
    if (!value || typeof value !== 'string') return value || undefined;

    try {
        const url = new URL(value);
        if (url.protocol !== 'http:') return value;

        const host = url.hostname.toLowerCase();
        if (host === 'images.vega-xt-mh.com') {
            url.protocol = 'https:';
            if (url.port === '80') url.port = '';
            return url.toString();
        }
    } catch {
        return value;
    }

    return value;
}

function stripNullishDeep(value) {
    if (Array.isArray(value)) {
        return value
            .map(stripNullishDeep)
            .filter(item => item !== undefined);
    }

    if (value && typeof value === 'object') {
        const cleaned = {};
        for (const [key, entry] of Object.entries(value)) {
            const normalized = stripNullishDeep(entry);
            if (normalized !== undefined) cleaned[key] = normalized;
        }
        return cleaned;
    }

    if (value === null || typeof value === 'undefined') return undefined;
    return value;
}

function getItemGroupLabel(item, fallbackLabel) {
    const raw = item?.category || item?.attributes?.['group-title'];
    const label = String(raw || '').trim();
    return label || fallbackLabel;
}

function buildDynamicCatalogId(type, label) {
    const prefix = DYNAMIC_CATALOG_PREFIX[type];
    if (!prefix) return '';
    const digest = crypto.createHash('md5').update(`${type}:${label}`).digest('hex').slice(0, 12);
    return `${prefix}${digest}`;
}

function getItemFreshnessValue(item) {
    const candidate = item?.addedAt || item?.released || item?.releaseDate;
    if (!candidate) return 0;

    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;

    const raw = String(candidate).trim();
    if (!raw) return 0;
    if (/^\d{10}$/.test(raw)) return parseInt(raw, 10) * 1000;
    if (/^\d{13}$/.test(raw)) return parseInt(raw, 10);

    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizeHomeCategoryCatalogLimit(value) {
    if (value === null || typeof value === 'undefined' || value === '') {
        return DEFAULT_HOME_CATEGORY_CATALOG_LIMIT;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_HOME_CATEGORY_CATALOG_LIMIT;
    return Math.min(parsed, MAX_HOME_CATEGORY_CATALOG_LIMIT);
}

function getFuzzyDistanceLimit(term) {
    const len = (term || '').length;
    if (len < 5) return 0;
    if (len < 9) return 1;
    return 2;
}

function boundedLevenshtein(a, b, maxDistance) {
    if (a === b) return 0;
    const aLen = a.length;
    const bLen = b.length;
    if (Math.abs(aLen - bLen) > maxDistance) return maxDistance + 1;
    if (!aLen) return bLen <= maxDistance ? bLen : maxDistance + 1;
    if (!bLen) return aLen <= maxDistance ? aLen : maxDistance + 1;

    let previous = Array.from({ length: bLen + 1 }, (_, idx) => idx);
    for (let i = 1; i <= aLen; i++) {
        let current = [i];
        let minInRow = current[0];
        for (let j = 1; j <= bLen; j++) {
            const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
            const value = Math.min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + substitutionCost
            );
            current[j] = value;
            if (value < minInRow) minInRow = value;
        }
        if (minInRow > maxDistance) return maxDistance + 1;
        previous = current;
    }
    return previous[bLen];
}

function tokenMatchesApproximately(term, candidateTokens) {
    const maxDistance = getFuzzyDistanceLimit(term);
    if (maxDistance === 0) return false;

    return candidateTokens.some(token => boundedLevenshtein(term, token, maxDistance) <= maxDistance);
}

function hasArabicScript(value) {
    return /[\u0600-\u06FF]/.test(value || '');
}

function stripArabicArticle(value) {
    return (value || '').replace(/^ال+/u, '');
}

function normalizeTokenForSearch(value) {
    if (!value) return '';
    return hasArabicScript(value) ? stripArabicArticle(value) : value;
}

function tokenMatchesSearchTerm(token, term) {
    const normalizedToken = normalizeTokenForSearch(token);
    const normalizedTerm = normalizeTokenForSearch(term);
    if (!normalizedToken || !normalizedTerm) return false;
    if (normalizedToken === normalizedTerm) return true;
    if (normalizedToken.startsWith(normalizedTerm)) return true;
    if (!hasArabicScript(normalizedTerm) && normalizedToken.includes(normalizedTerm)) return true;
    return false;
}

function makeLogger(cfgDebug) {
    const enabled = !!cfgDebug || DEBUG_ENV;
    return {
        debug: (...a) => { if (enabled) console.log('[DEBUG]', ...a); },
        info:  (...a) => console.log('[INFO]', ...a),
        warn:  (...a) => console.warn('[WARN]', ...a),
        error: (...a) => console.error('[ERROR]', ...a)
    };
}

const CACHE_ENABLED = (process.env.CACHE_ENABLED || 'true').toLowerCase() !== 'false';
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || (6 * 3600 * 1000).toString(), 10);
const MAX_CACHE_ENTRIES = parseInt(process.env.MAX_CACHE_ENTRIES || '300', 10);

const dataCache = new LRUCache({ max: MAX_CACHE_ENTRIES, ttl: CACHE_TTL_MS });
const buildPromiseCache = new Map();

async function redisGetJSON(key) {
    if (!redisClient) return null;
    try {
        const raw = await redisClient.get(key);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch { return null; }
}
async function redisSetJSON(key, value, ttl) {
    if (!redisClient) return;
    try {
        await redisClient.set(key, JSON.stringify(value), 'PX', ttl);
    } catch { /* ignore */ }
}

function stableStringify(obj) {
    return JSON.stringify(obj, Object.keys(obj).sort());
}

function createCacheKey(config) {
    const minimal = {
        provider: config.provider,
        m3uUrl: config.m3uUrl,
        epgUrl: config.epgUrl,
        enableEpg: !!config.enableEpg,
        xtreamUrl: config.xtreamUrl,
        xtreamUsername: config.xtreamUsername,
        xtreamUseM3U: !!config.xtreamUseM3U,
        xtreamOutput: config.xtreamOutput,
        epgOffsetHours: config.epgOffsetHours,
        includeSeries: config.includeSeries !== false, // default true
        homeCategoryCatalogLimit: normalizeHomeCategoryCatalogLimit(config.homeCategoryCatalogLimit)
    };
    return crypto.createHash('md5').update(stableStringify(minimal)).digest('hex');
}

class M3UEPGAddon {
    constructor(config = {}, manifestRef) {
        if (!config.provider) {
            config.provider = config.useXtream ? 'xtream' : 'direct';
        }
        this.providerName = config.provider === 'xtream' ? 'xtream' : 'direct';
        this.config = config;
        this.manifestRef = manifestRef;
        this.cacheKey = createCacheKey(config);
        this.updateInterval = 3600000;
        this.channels = []; // live TV
        this.movies = [];   // VOD movies
        this.series = [];   // Series (shows)
        this.searchIndex = {
            tv: [],
            movie: [],
            series: []
        };
        this.catalogGenreLookup = new Map();
        this.seriesInfoCache = new Map(); // seriesId -> { videos: [...], fetchedAt }
        this.epgData = {};
        this.lastUpdate = 0;
        this.updatePromise = null;
        this.log = makeLogger(config.debug);

        // Direct provider may populate this (seriesId -> episodes array)
        this.directSeriesEpisodeIndex = new Map();

        if (typeof this.config.epgOffsetHours === 'string') {
            const n = parseFloat(this.config.epgOffsetHours);
            if (!isNaN(n)) this.config.epgOffsetHours = n;
        }
        if (typeof this.config.epgOffsetHours !== 'number' || !isFinite(this.config.epgOffsetHours))
            this.config.epgOffsetHours = 0;
        if (Math.abs(this.config.epgOffsetHours) > 48)
            this.config.epgOffsetHours = 0;
        if (typeof this.config.includeSeries === 'undefined')
            this.config.includeSeries = true;
        this.config.homeCategoryCatalogLimit = normalizeHomeCategoryCatalogLimit(this.config.homeCategoryCatalogLimit);

        this.log.debug('Addon instance created', {
            provider: this.providerName,
            cacheKey: this.cacheKey,
            epgOffsetHours: this.config.epgOffsetHours,
            includeSeries: this.config.includeSeries,
            homeCategoryCatalogLimit: this.config.homeCategoryCatalogLimit
        });
    }

    hasData() {
        return !!(this.channels.length || this.movies.length || this.series.length);
    }

    rebuildSearchIndex() {
        const buildIndex = (items) => items.map(item => {
            const nameNorm = normalizeSearchText(item.name);
            const haystack = [
                item.name,
                item.category,
                item.attributes?.['group-title']
            ].map(normalizeSearchText).filter(Boolean).join(' ');
            const haystackTokens = haystack.split(' ').filter(Boolean);
            return {
                item,
                name: nameNorm,
                nameTokens: nameNorm.split(' ').filter(Boolean),
                haystack,
                haystackTokens,
                searchTokens: Array.from(new Set([
                    ...nameNorm.split(' ').filter(Boolean),
                    ...haystackTokens
                ]))
            };
        });

        this.searchIndex.tv = buildIndex(this.channels);
        this.searchIndex.movie = buildIndex(this.movies);
        this.searchIndex.series = buildIndex(this.series);
    }

    async loadFromCache() {
        if (!CACHE_ENABLED) return;
        const cacheKey = 'addon:data:' + this.cacheKey;
        let cached = dataCache.get(cacheKey);
        if (!cached && redisClient) {
            cached = await redisGetJSON(cacheKey);
            if (cached) dataCache.set(cacheKey, cached);
        }
        if (cached) {
            this.channels = cached.channels || [];
            this.movies = cached.movies || [];
            this.series = cached.series || [];
            this.epgData = cached.epgData || {};
            this.lastUpdate = cached.lastUpdate || 0;
            this.rebuildSearchIndex();
            // Direct series episodes index is not persisted; rebuild on next fetch
            this.log.debug('Cache hit for data', {
                channels: this.channels.length,
                movies: this.movies.length,
                series: this.series.length,
                lastUpdate: new Date(this.lastUpdate).toISOString()
            });
        }
    }

    async saveToCache() {
        if (!CACHE_ENABLED) return;
        const cacheKey = 'addon:data:' + this.cacheKey;
        const entry = {
            channels: this.channels,
            movies: this.movies,
            series: this.series,
            epgData: this.epgData,
            lastUpdate: this.lastUpdate
        };
        dataCache.set(cacheKey, entry);
        await redisSetJSON(cacheKey, entry, CACHE_TTL_MS);
        this.log.debug('Saved data to cache');
    }

    buildGenresInManifest() {
        if (!this.manifestRef) return;
        const previousCatalogs = Array.isArray(this.manifestRef.catalogs) ? this.manifestRef.catalogs : [];
        const applyGenreOptions = (catalog, genres) => {
            if (!catalog || !Array.isArray(catalog.extra)) return;
            const genreExtra = catalog.extra.find(entry => entry && entry.name === 'genre');
            if (genreExtra) genreExtra.options = genres.slice();
        };
        const tvCatalog = previousCatalogs.find(c => c.id === 'iptv_channels') || {
            type: 'tv',
            id: 'iptv_channels',
            name: 'IPTV Channels',
            extra: BASE_CATALOG_EXTRAS.map(extraName => ({ name: extraName })),
            extraSupported: BASE_CATALOG_EXTRAS.slice(),
            extraRequired: [],
            genres: []
        };
        const searchCatalog = previousCatalogs.find(c => c.id === 'iptv_movies_search') || {
            type: 'all',
            id: 'iptv_movies_search',
            name: 'IPTV Search',
            extra: [{ name: 'search', isRequired: true }],
            extraSupported: ['search'],
            extraRequired: ['search']
        };
        const movieBrowseCatalog = previousCatalogs.find(c => c.id === 'iptv_movies') || {
            type: 'movie',
            id: 'iptv_movies',
            name: 'IPTV Movies',
            extra: BASE_CATALOG_EXTRAS.map(extraName => ({ name: extraName })),
            extraSupported: BASE_CATALOG_EXTRAS.slice(),
            extraRequired: [],
            genres: []
        };
        const seriesBrowseCatalog = previousCatalogs.find(c => c.id === 'iptv_series') || {
            type: 'series',
            id: 'iptv_series',
            name: 'IPTV Series',
            extra: BASE_CATALOG_EXTRAS.map(extraName => ({ name: extraName })),
            extraSupported: BASE_CATALOG_EXTRAS.slice(),
            extraRequired: [],
            genres: []
        };

        const buildCategoryCatalogs = (type, items, fallbackLabel) => {
            const stats = new Map();

            for (const item of items) {
                const label = getItemGroupLabel(item, fallbackLabel);
                if (!label) continue;
                const freshness = getItemFreshnessValue(item);
                const existing = stats.get(label) || { label, freshness: 0, count: 0 };
                existing.freshness = Math.max(existing.freshness, freshness);
                existing.count += 1;
                stats.set(label, existing);
            }

            return Array.from(stats.values())
                .sort((a, b) =>
                    b.freshness - a.freshness ||
                    b.count - a.count ||
                    a.label.localeCompare(b.label)
                )
                .slice(0, this.config.homeCategoryCatalogLimit)
                .map(({ label }) => {
                    const id = buildDynamicCatalogId(type, label);
                    this.catalogGenreLookup.set(id, { type, genre: label });
                    return {
                        type,
                        id,
                        name: label,
                        extra: [{ name: 'skip' }],
                        extraSupported: ['skip'],
                        extraRequired: []
                    };
                });
        };

        this.catalogGenreLookup = new Map();

        if (tvCatalog) {
            const groups = [
                ...new Set(
                    this.channels
                        .map(c => c.category || c.attributes?.['group-title'])
                        .filter(Boolean)
                        .map(s => s.trim())
                )
            ].sort((a, b) => a.localeCompare(b));
            if (!groups.includes('All Channels')) groups.unshift('All Channels');
            tvCatalog.genres = groups;
            applyGenreOptions(tvCatalog, groups);
        }

        const movieGroups = [
            ...new Set(
                this.movies
                    .map(item => getItemGroupLabel(item, 'Other Movies'))
                    .filter(Boolean)
                    .map(label => label.trim())
            )
        ].sort((a, b) => a.localeCompare(b));
        if (!movieGroups.includes('All Movies')) movieGroups.unshift('All Movies');
        movieBrowseCatalog.genres = movieGroups;
        applyGenreOptions(movieBrowseCatalog, movieGroups);

        const seriesGroups = [
            ...new Set(
                this.series
                    .map(item => getItemGroupLabel(item, 'Other Series'))
                    .filter(Boolean)
                    .map(label => label.trim())
            )
        ].sort((a, b) => a.localeCompare(b));
        if (!seriesGroups.includes('All Series')) seriesGroups.unshift('All Series');
        seriesBrowseCatalog.genres = seriesGroups;
        applyGenreOptions(seriesBrowseCatalog, seriesGroups);

        const movieCatalogs = buildCategoryCatalogs('movie', this.movies, 'Other Movies');
        const seriesCatalogs = buildCategoryCatalogs('series', this.series, 'Other Series');

        previousCatalogs.splice(0, previousCatalogs.length,
            tvCatalog,
            movieBrowseCatalog,
            ...movieCatalogs,
            ...(this.config.includeSeries !== false ? [seriesBrowseCatalog, ...seriesCatalogs] : []),
            searchCatalog
        );

        this.log.debug('Catalog genres built', {
            tvGenres: tvCatalog?.genres?.length || 0,
            movieGenres: movieCatalogs.length,
            seriesGenres: this.config.includeSeries !== false ? seriesCatalogs.length : 0
        });
    }

    shouldFilterGenre(genre) {
        if (!genre) return false;
        return !ALL_GENRE_LABELS.has(normalizeSearchText(genre));
    }

    matchesSearch(item, rawQuery) {
        const nameNorm = normalizeSearchText(item.name);
        const haystack = [item.name, item.category, item.plot, item.attributes?.['group-title'], item.attributes?.['plot']]
            .map(normalizeSearchText).filter(Boolean).join(' ');
        return this.matchesSearchEntry({
            item, name: nameNorm, nameTokens: nameNorm.split(' ').filter(Boolean),
            haystack,
            haystackTokens: haystack.split(' ').filter(Boolean),
            searchTokens: Array.from(new Set([
                ...nameNorm.split(' ').filter(Boolean),
                ...haystack.split(' ').filter(Boolean)
            ]))
        }, normalizeSearchText(rawQuery), normalizeSearchText(rawQuery).split(' ').filter(Boolean));
    }

    matchesSearchEntry(entry, query, queryTerms) {
        if (!queryTerms || !queryTerms.length) return true;
        if (queryTerms.length > 1 && entry.name.includes(query)) return true;
        if (queryTerms.every(term => entry.searchTokens.some(token => tokenMatchesSearchTerm(token, term)))) return true;
        return queryTerms.every(term => tokenMatchesApproximately(term, entry.nameTokens));
    }

    rankSearchResult(item, rawQuery) {
        const nameNorm = normalizeSearchText(item.name);
         const haystack = [item.name, item.category, item.plot, item.attributes?.['group-title'], item.attributes?.['plot']]
            .map(normalizeSearchText).filter(Boolean).join(' ');
        const entry = {
            item, name: nameNorm, nameTokens: nameNorm.split(' ').filter(Boolean),
            haystack, haystackTokens: haystack.split(' ').filter(Boolean)
        };
        const query = normalizeSearchText(rawQuery);
        return this.rankSearchEntry(entry, query, query.split(' ').filter(Boolean));
    }

    rankSearchEntry(entry, query, terms) {
        if (!query || !terms || !terms.length) return 99;
        
        const { name, haystack, nameTokens, haystackTokens } = entry;

        if (name === query) return 0;
        if (haystack === query) return 1;
        if (name.startsWith(query)) return 2;
        
        if (terms.every(term => nameTokens.some(token => tokenMatchesSearchTerm(token, term)))) return 3;
        if (terms.every(term => haystackTokens.some(token => tokenMatchesSearchTerm(token, term)))) return 4;
        if (terms.every(term => name.includes(term))) return 5;
        if (terms.every(term => haystack.includes(term))) return 6;
        
        return 7;
    }

    parseM3U(content) {
        const startTs = Date.now();
        const lines = content.split('\n');
        const items = [];
        let currentItem = null;
        for (const raw of lines) {
            const line = raw.trim();
            if (line.startsWith('#EXTINF:')) {
                const matches = line.match(/#EXTINF:(-?\d+)(?:\s+(.*))?,(.*)/);
                if (matches) {
                    currentItem = {
                        duration: parseInt(matches[1]),
                        attributes: this.parseAttributes(matches[2] || ''),
                        name: (matches[3] || '').trim()
                    };
                }
            } else if (line && !line.startsWith('#') && currentItem) {
                currentItem.url = line;
                currentItem.logo = currentItem.attributes['tvg-logo'];
                currentItem.epg_channel_id = currentItem.attributes['tvg-id'] || currentItem.attributes['tvg-name'];
                currentItem.category = currentItem.attributes['group-title'];

                const group = (currentItem.attributes['group-title'] || '').toLowerCase();
                const lower = currentItem.name.toLowerCase();

                const isMovie =
                    group.includes('movie') ||
                    lower.includes('movie') ||
                    this.isMovieFormat(currentItem.name);

                const isSeries =
                    !isMovie && (
                        group.includes('series') ||
                        group.includes('show') ||
                        /\bS\d{1,2}E\d{1,2}\b/i.test(currentItem.name) ||
                        /\bSeason\s?\d+/i.test(currentItem.name)
                    );

                currentItem.type = isSeries ? 'series' : (isMovie ? 'movie' : 'tv');
                currentItem.id = `iptv_${crypto.createHash('md5').update(currentItem.name + currentItem.url).digest('hex').substring(0, 16)}`;
                items.push(currentItem);
                currentItem = null;
            }
        }
        const ms = Date.now() - startTs;
        this.log.debug('M3U parsed', { lines: lines.length, items: items.length, ms });
        return items;
    }

    parseAttributes(str) {
        const attrs = {};
        const regex = /(\w+(?:-\w+)*)="([^"]*)"/g;
        let m;
        while ((m = regex.exec(str)) !== null) attrs[m[1]] = m[2];
        return attrs;
    }

    isMovieFormat(name) {
        return [/\(\d{4}\)/, /\d{4}\./, /HD$|FHD$|4K$/i].some(p => p.test(name));
    }

    async parseEPG(content) {
        const start = Date.now();
        try {
            const xml2js = require('xml2js');
            const parser = new xml2js.Parser();
            const result = await parser.parseStringPromise(content);
            const epgData = {};
            if (result.tv && result.tv.programme) {
                for (const prog of result.tv.programme) {
                    const ch = prog.$.channel;
                    if (!epgData[ch]) epgData[ch] = [];
                    epgData[ch].push({
                        start: prog.$.start,
                        stop: prog.$.stop,
                        title: prog.title ? prog.title[0]._ || prog.title[0] : 'Unknown',
                        desc: prog.desc ? prog.desc[0]._ || prog.desc[0] : ''
                    });
                }
            }
            this.log.debug('EPG parsed', {
                channels: Object.keys(epgData).length,
                programmes: Object.values(epgData).reduce((a, b) => a + b.length, 0),
                ms: Date.now() - start
            });
            return epgData;
        } catch (e) {
            this.log.warn('EPG parse failed', e.message);
            return {};
        }
    }

    parseEPGTime(s) {
        if (!s) return new Date();
        const m = s.match(/^(\d{14})(?:\s*([+\-]\d{4}))?/);
        if (m) {
            const base = m[1];
            const tz = m[2] || null;
            const year = parseInt(base.slice(0, 4), 10);
            const month = parseInt(base.slice(4, 6), 10) - 1;
            const day = parseInt(base.slice(6, 8), 10);
            const hour = parseInt(base.slice(8, 10), 10);
            const min = parseInt(base.slice(10, 12), 10);
            const sec = parseInt(base.slice(12, 14), 10);
            let date;
            if (tz) {
                const iso = `${year}-${(month + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}T${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}${tz}`;
                const parsed = new Date(iso);
                if (!isNaN(parsed.getTime())) date = parsed;
            }
            if (!date) date = new Date(year, month, day, hour, min, sec);
            if (this.config.epgOffsetHours) {
                date = new Date(date.getTime() + this.config.epgOffsetHours * 3600000);
            }
            return date;
        }
        const d = new Date(s);
        if (this.config.epgOffsetHours && !isNaN(d.getTime()))
            return new Date(d.getTime() + this.config.epgOffsetHours * 3600000);
        return d;
    }

    getCurrentProgram(channelId) {
        if (!channelId || !this.epgData[channelId]) return null;
        const now = new Date();
        for (const p of this.epgData[channelId]) {
            const start = this.parseEPGTime(p.start);
            const stop = this.parseEPGTime(p.stop);
            if (now >= start && now <= stop) {
                return { title: p.title, description: p.desc, start, stop, startTime: start, stopTime: stop };
            }
        }
        return null;
    }

    getUpcomingPrograms(channelId, limit = 5) {
        if (!channelId || !this.epgData[channelId]) return [];
        const now = new Date();
        const upcoming = [];
        for (const p of this.epgData[channelId]) {
            const start = this.parseEPGTime(p.start);
            if (start > now && upcoming.length < limit) {
                upcoming.push({
                    title: p.title,
                    description: p.desc,
                    startTime: start,
                    stopTime: this.parseEPGTime(p.stop)
                });
            }
        }
        return upcoming.sort((a, b) => a.startTime - b.startTime);
    }

    async ensureSeriesInfo(seriesId) {
        if (!seriesId) return null;
        if (this.seriesInfoCache.has(seriesId)) return this.seriesInfoCache.get(seriesId);

        try {
            const providerModule = require(`./src/js/providers/${this.providerName}Provider.js`);
            if (typeof providerModule.fetchSeriesInfo === 'function') {
                const info = await providerModule.fetchSeriesInfo(this, seriesId);
                if (info && (Array.isArray(info.videos) ? info.videos.length > 0 : true)) {
                    this.seriesInfoCache.set(seriesId, info);
                }
                return info;
            }
        } catch (e) {
            this.log.warn('Series info fetch failed', seriesId, e.message);
        }
        // Fallback empty structure
        return { videos: [] };
    }

    async updateData(force = false, throwOnError = false) {
        if (this.updatePromise) return this.updatePromise;

        const now = Date.now();
        if (!force && CACHE_ENABLED) {
            if (this.lastUpdate && now - this.lastUpdate < this.updateInterval) {
                this.log.debug('Skip update (global interval)');
                return;
            }
            if ((this.channels.length || this.movies.length || this.series.length) && now - this.lastUpdate < 900000) {
                this.log.debug('Skip update (recent minor interval)');
                return;
            }
        }
        const previousState = {
            channels: this.channels,
            movies: this.movies,
            series: this.series,
            epgData: this.epgData,
            directSeriesEpisodeIndex: new Map(this.directSeriesEpisodeIndex)
        };

        this.updatePromise = (async () => {
            const start = Date.now();
            try {
                const providerModule = require(`./src/js/providers/${this.providerName}Provider.js`);
                await providerModule.fetchData(this);
                this.lastUpdate = Date.now();
                this.rebuildSearchIndex();
                if (CACHE_ENABLED) await this.saveToCache();
                this.buildGenresInManifest();
                this.log.debug('Data update complete', {
                    channels: this.channels.length,
                    movies: this.movies.length,
                    series: this.series.length,
                    ms: Date.now() - start
                });
            } catch (e) {
                this.channels = previousState.channels;
                this.movies = previousState.movies;
                this.series = previousState.series;
                this.epgData = previousState.epgData;
                this.directSeriesEpisodeIndex = previousState.directSeriesEpisodeIndex;
                this.rebuildSearchIndex();
                this.buildGenresInManifest();
                this.log.error('[UPDATE] Failed:', e.message);
                if (throwOnError) throw e;
            } finally {
                this.updatePromise = null;
            }
        })();

        return this.updatePromise;
    }

    deriveFallbackLogoUrl(item) {
        const logoAttr = item.attributes?.['tvg-logo'];
        if (logoAttr && logoAttr.trim()) return logoAttr;
        const tvgId = item.attributes?.['tvg-id'] || item.attributes?.['tvg-name'];
        if (!tvgId)
            return `https://via.placeholder.com/300x400/333333/FFFFFF?text=${encodeURIComponent(item.name)}`;
        return `logo/${encodeURIComponent(tvgId)}.png`;
    }

    generateMetaPreview(item) {
        const meta = { id: item.id, type: item.type, name: item.name };
        if (item.type === 'tv') {
            const epgId = item.attributes?.['tvg-id'] || item.attributes?.['tvg-name'];
            const current = this.getCurrentProgram(epgId);
            meta.description = current
                ? `📡 Now: ${current.title}${current.description ? `\n${current.description}` : ''}`
                : '📡 Live Channel';
            meta.poster = normalizeAssetUrl(this.deriveFallbackLogoUrl(item));
            meta.genres = item.category
                ? [item.category]
                : (item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Live TV']);
            meta.runtime = 'Live';
        } else if (item.type === 'movie') {
            meta.poster = normalizeAssetUrl(item.poster) ||
                item.attributes?.['tvg-logo'] ||
                `https://via.placeholder.com/300x450/CC6600/FFFFFF?text=${encodeURIComponent(item.name)}`;
            meta.year = item.year;
            if (!meta.year) {
                const m = item.name.match(/\((\d{4})\)/);
                if (m) meta.year = parseInt(m[1]);
            }
            meta.description = item.plot || item.attributes?.['plot'] || `Movie: ${item.name}`;
            meta.genres = item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Movie'];
        } else if (item.type === 'series') {
            meta.poster = normalizeAssetUrl(item.poster) ||
                item.attributes?.['tvg-logo'] ||
                `https://via.placeholder.com/300x450/3366CC/FFFFFF?text=${encodeURIComponent(item.name)}`;
            meta.description = item.plot || item.attributes?.['plot'] || 'Series / Show';
            meta.genres = item.category
                ? [item.category]
                : (item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Series']);
        }
        return stripNullishDeep(meta);
    }

    getStream(id) {
        // Episode streams
        if (id.startsWith('iptv_series_ep_')) {
            const epEntry = this.lookupEpisodeById(id);
            if (!epEntry) return null;
            return {
                url: epEntry.url,
                title: `${epEntry.title || 'Episode'}${epEntry.season ? ` S${epEntry.season}E${epEntry.episode}` : ''}`,
                behaviorHints: { notWebReady: true }
            };
        }
        const all = [...this.channels, ...this.movies];
        const item = all.find(i => i.id === id);
        if (!item) return null;
        return {
            url: item.url,
            title: item.type === 'tv' ? `${item.name} - Live` : item.name,
            behaviorHints: { notWebReady: true }
        };
    }

    lookupEpisodeById(epId) {
        // Check cached series info
        for (const [, info] of this.seriesInfoCache.entries()) {
            if (info && Array.isArray(info.videos)) {
                const found = info.videos.find(v => v.id === epId);
                if (found) return found;
            }
        }
        // Direct provider inline index
        for (const arr of this.directSeriesEpisodeIndex.values()) {
            const found = arr.find(v => v.id === epId);
            if (found) return found;
        }
        return null;
    }

    async buildSeriesMeta(seriesItem) {
        const seriesIdRaw = seriesItem.series_id || seriesItem.id.replace(/^iptv_series_/, '');
        const info = await this.ensureSeriesInfo(seriesIdRaw);
        const seriesInfo = info?.info || {};
        const backdrop = Array.isArray(seriesInfo.backdrop_path)
            ? seriesInfo.backdrop_path.find(Boolean)
            : seriesInfo.backdrop_path;
        const fallbackReleaseYear = seriesInfo.releaseDate || seriesItem.year || seriesItem.name;
        const videos = (info?.videos || []).map(v => ({
            id: v.id,
            title: v.title,
            season: v.season,
            episode: v.episode,
            released: normalizeReleasedValue(v.released, fallbackReleaseYear),
            thumbnail: normalizeAssetUrl(v.thumbnail || seriesItem.poster || seriesItem.attributes?.['tvg-logo'])
        })).map(stripNullishDeep);

        return stripNullishDeep({
            id: seriesItem.id,
            type: 'series',
            name: seriesItem.name,
            poster: normalizeAssetUrl(seriesItem.poster) ||
                normalizeAssetUrl(seriesInfo.cover) ||
                seriesItem.attributes?.['tvg-logo'] ||
                `https://via.placeholder.com/300x450/3366CC/FFFFFF?text=${encodeURIComponent(seriesItem.name)}`,
            background: normalizeAssetUrl(backdrop) || undefined,
            description: seriesItem.plot || seriesInfo.plot || seriesItem.attributes?.['plot'] || 'Series / Show',
            genres: seriesItem.category
                ? [seriesItem.category]
                : (seriesItem.attributes?.['group-title'] ? [seriesItem.attributes['group-title']] : ['Series']),
            releaseInfo: seriesInfo.releaseDate ? String(seriesInfo.releaseDate).slice(0, 4) : undefined,
            videos
        });
    }

    async getDetailedMetaAsync(id, type) {
        if (type === 'series' || id.startsWith('iptv_series_')) {
            const seriesItem = this.series.find(s => s.id === id);
            if (!seriesItem) return null;
            return await this.buildSeriesMeta(seriesItem);
        }
        // fallback sync path
        return this.getDetailedMeta(id);
    }

    getDetailedMeta(id) {
        const all = [...this.channels, ...this.movies];
        const item = all.find(i => i.id === id);
        if (!item) return null;
        if (item.type === 'tv') {
            const epgId = item.attributes?.['tvg-id'] || item.attributes?.['tvg-name'];
            const current = this.getCurrentProgram(epgId);
            const upcoming = this.getUpcomingPrograms(epgId, 3);
            let description = `📺 CHANNEL: ${item.name}`;
            if (current) {
                const start = current.startTime?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || '';
                const end = current.stopTime?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || '';
                description += `\n\n📡 NOW: ${current.title}${start && end ? ` (${start}-${end})` : ''}`;
                if (current.description) description += `\n\n${current.description}`;
            }
            if (upcoming.length) {
                description += '\n\n📅 UPCOMING:\n';
                for (const p of upcoming) {
                    description += `${p.startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${p.title}\n`;
                }
            }
            return {
                id: item.id,
                type: 'tv',
                name: item.name,
                poster: normalizeAssetUrl(this.deriveFallbackLogoUrl(item)),
                description,
                genres: item.category
                    ? [item.category]
                    : (item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Live TV']),
                runtime: 'Live'
            };
        } else {
            let year = item.year;
            if (!year) {
                const m = item.name.match(/\((\d{4})\)/);
                if (m) year = parseInt(m[1]);
            }
            const description = item.plot || item.attributes?.['plot'] || `Movie: ${item.name}`;
            return stripNullishDeep({
                id: item.id,
                type: 'movie',
                name: item.name,
                poster: normalizeAssetUrl(item.poster || item.attributes?.['tvg-logo']) ||
                    `https://via.placeholder.com/300x450/CC6600/FFFFFF?text=${encodeURIComponent(item.name)}`,
                description,
                genres: item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Movie'],
                year
            });
        }
    }
}

async function createAddon(config) {
    const buildCatalogManifest = (type, id, name, { searchOnly = false } = {}) => {
        const extra = searchOnly
            ? [{ name: 'search', isRequired: true }]
            : BASE_CATALOG_EXTRAS.map(extraName => ({ name: extraName }));

        return {
            type,
            id,
            name,
            extra,
            // Compatibility with clients/examples that still look for the legacy fields.
            extraSupported: searchOnly ? ['search'] : BASE_CATALOG_EXTRAS.slice(),
            extraRequired: searchOnly ? ['search'] : [],
            genres: searchOnly ? undefined : []
        };
    };

    const manifest = {
        id: ADDON_ID,
        version: ADDON_VERSION,
        name: ADDON_NAME,
        description: "IPTV addon (M3U / EPG / Xtream) with encrypted configs, caching & series support (Xtream + Direct)",
        resources: ["catalog", "stream", "meta"],
        types: ["tv", "movie", "series"],
        catalogs: [
            buildCatalogManifest('tv', 'iptv_channels', 'IPTV Channels'),
            buildCatalogManifest('movie', 'iptv_movies', 'IPTV Movies'),
            buildCatalogManifest('series', 'iptv_series', 'IPTV Series'),
            buildCatalogManifest('all', 'iptv_movies_search', 'IPTV Search', { searchOnly: true })
        ],
        idPrefixes: ["iptv_"],
        behaviorHints: {
            configurable: true,
            configurationRequired: false
        }
    };

    config.instanceId = config.instanceId ||
        (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString('hex'));

    const cacheKey = createCacheKey(config);
    const debugFlag = !!config.debug || DEBUG_ENV;
    if (debugFlag) {
        console.log('[DEBUG] createAddon start', { cacheKey, provider: config.provider, includeSeries: config.includeSeries !== false });
    } else {
        console.log(`[ADDON] Cache ${CACHE_ENABLED ? 'ENABLED' : 'DISABLED'} for config ${cacheKey}`);
    }

    if (CACHE_ENABLED && buildPromiseCache.has(cacheKey)) {
        if (debugFlag) console.log('[DEBUG] Reusing build promise', cacheKey);
        return buildPromiseCache.get(cacheKey);
    }

    const buildPromise = (async () => {
        const builder = new addonBuilder(manifest);
        const addonInstance = new M3UEPGAddon(config, manifest);
        await addonInstance.loadFromCache();
        addonInstance.buildGenresInManifest();
        if (addonInstance.hasData()) {
            addonInstance.updateData().catch(() => { });
        } else {
            await addonInstance.updateData(true, true);
        }

        builder.defineCatalogHandler(async (args) => {
            const start = Date.now();
            try {
                addonInstance.updateData().catch(() => { });
                let items = [];
                const requestedCatalogId = String(args.id || '');
                const catalogId = requestedCatalogId.endsWith('_search')
                    ? requestedCatalogId.slice(0, -7)
                    : requestedCatalogId;
                const dynamicCatalogMatch = addonInstance.catalogGenreLookup.get(requestedCatalogId);

                if (args.type === 'tv' && catalogId === 'iptv_channels') {
                    items = addonInstance.channels;
                } else if (dynamicCatalogMatch && dynamicCatalogMatch.type === args.type) {
                    const sourceItems = args.type === 'movie'
                        ? addonInstance.movies
                        : addonInstance.series;
                    items = sourceItems.filter(item => getItemGroupLabel(item, '') === dynamicCatalogMatch.genre);
                } else if (args.type === 'movie' && catalogId === 'iptv_movies') {
                    items = addonInstance.movies;
                } else if (args.type === 'series' && catalogId === 'iptv_series') {
                    if (addonInstance.config.includeSeries !== false)
                        items = addonInstance.series;
                }
                const extra = args.extra || {};
                if (addonInstance.shouldFilterGenre(extra.genre) && !extra.search) {
                    items = items.filter(i =>
                        (i.category && i.category === extra.genre) ||
                        (i.attributes && i.attributes['group-title'] === extra.genre)
                    );
                }
                if (extra.search) {
                    const query = normalizeSearchText(extra.search);
                    const terms = query.split(' ').filter(Boolean);
                    const shouldMergeMovieAndSeriesSearch = requestedCatalogId === 'iptv_movies_search';
                    const searchBuckets = shouldMergeMovieAndSeriesSearch
                        ? [
                            addonInstance.searchIndex.movie,
                            ...(addonInstance.config.includeSeries !== false ? [addonInstance.searchIndex.series] : [])
                        ]
                        : [
                            args.type === 'tv'
                                ? addonInstance.searchIndex.tv
                                : args.type === 'movie'
                                    ? addonInstance.searchIndex.movie
                                    : addonInstance.searchIndex.series
                        ];

                    items = searchBuckets
                        .flat()
                        .filter(entry => addonInstance.matchesSearchEntry(entry, query, terms))
                        .map(entry => ({
                            entry,
                            rank: addonInstance.rankSearchEntry(entry, query, terms)
                        }))
                        .sort((a, b) =>
                            a.rank - b.rank ||
                            a.entry.item.type.localeCompare(b.entry.item.type) ||
                            a.entry.item.name.localeCompare(b.entry.item.name)
                        )
                        .map(obj => obj.entry.item);
                }
                const skip = Math.max(parseInt(extra.skip || '0', 10) || 0, 0);
                const metas = items.slice(skip, skip + 100).map(i => {
                    const meta = addonInstance.generateMetaPreview(i);
                    if (requestedCatalogId === 'iptv_movies_search' && meta?.name) {
                        const label = meta.type === 'series' ? 'Series' : meta.type === 'movie' ? 'Movie' : null;
                        if (label) meta.name = `${meta.name} (${label})`;
                    }
                    return meta;
                });
                if (addonInstance.config.debug) {
                    console.log('[DEBUG] Catalog handler', {
                        type: args.type,
                        id: args.id,
                        totalItems: items.length,
                        returned: metas.length,
                        ms: Date.now() - start
                    });
                }
                return { metas };
            } catch (e) {
                console.error('[CATALOG] Error', e);
                return { metas: [] };
            }
        });

        builder.defineStreamHandler(async ({ type, id }) => {
            try {
                if (id.startsWith('iptv_series_ep_')) {
                    const stream = addonInstance.getStream(id);
                    if (!stream) return { streams: [] };
                    if (addonInstance.config.debug) {
                        console.log('[DEBUG] Series Episode Stream request', { id, url: stream.url });
                    }
                    return { streams: [stream] };
                }
                const stream = addonInstance.getStream(id);
                if (!stream) return { streams: [] };
                if (addonInstance.config.debug) {
                    console.log('[DEBUG] Stream request', { id, url: stream.url });
                }
                return { streams: [stream] };
            } catch (e) {
                console.error('[STREAM] Error', e);
                return { streams: [] };
            }
        });

        builder.defineMetaHandler(async ({ type, id }) => {
            try {
                if (type === 'series' || id.startsWith('iptv_series_')) {
                    const meta = await addonInstance.getDetailedMetaAsync(id, 'series');
                    if (addonInstance.config.debug) {
                        console.log('[DEBUG] Series meta request', { id, videos: meta?.videos?.length });
                    }
                    return { meta };
                }
                const meta = addonInstance.getDetailedMeta(id);
                if (addonInstance.config.debug) {
                    console.log('[DEBUG] Meta request', { id, type });
                }
                return { meta };
            } catch (e) {
                console.error('[META] Error', e);
                return { meta: null };
            }
        });

        return builder.getInterface();
    })();

    if (CACHE_ENABLED) buildPromiseCache.set(cacheKey, buildPromise);
    try {
        const iface = await buildPromise;
        return iface;
    } catch (error) {
        if (CACHE_ENABLED) buildPromiseCache.delete(cacheKey);
        throw error;
    } finally {
        // Successful builds stay cached via buildPromiseCache.
    }
}

module.exports = createAddon;
