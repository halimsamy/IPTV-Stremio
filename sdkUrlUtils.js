const SUPPORTED_SDK_RESOURCES = new Set(['catalog', 'meta', 'stream', 'subtitles']);

function splitExtraParts(value) {
    return (value || '')
        .split('/')
        .flatMap(part => part.split('&'))
        .map(part => part.trim())
        .filter(Boolean);
}

function normalizeSdkResourceUrl(url) {
    if (!url || typeof url !== 'string') return url;

    const [pathPart, queryPart = ''] = url.split('?');
    const match = pathPart.match(/^\/(catalog|meta|stream|subtitles)\/([^/]+)\/([^/]+?)(?:\/(.*))?\.json$/);
    if (!match) return url;

    const [, resource, type, id, rawExtra = ''] = match;
    if (!SUPPORTED_SDK_RESOURCES.has(resource)) return url;

    const normalizedExtraParts = splitExtraParts(rawExtra);

    // Catalog search/filter requests are sometimes sent as plain query params.
    if (resource === 'catalog' && queryPart) {
        normalizedExtraParts.push(...splitExtraParts(queryPart));
    } else if (rawExtra && queryPart) {
        // When an addon client adds cache-busting query params to a request that
        // already has extra props, fold them into the extra segment so the SDK
        // doesn't misparse `*.json?x=1` as part of the last extra value.
        normalizedExtraParts.push(...splitExtraParts(queryPart));
    }

    const normalizedExtra = normalizedExtraParts.join('&');
    if (!normalizedExtra) return `/${resource}/${type}/${id}.json`;
    return `/${resource}/${type}/${id}/${normalizedExtra}.json`;
}

module.exports = {
    normalizeSdkResourceUrl
};
