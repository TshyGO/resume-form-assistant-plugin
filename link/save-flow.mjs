/**
 * What one click on "保存岗位到桌面端" should show next.
 *
 * A reliable company and title is ready for the user to review. The desktop write happens
 * only after they confirm the form. Anything less may ask the
 * plugin's own model, using only the fragments extraction already selected. The URL is
 * copied from the local redaction result and is never produced by the model.
 */

export function nextSaveStep(extraction) {
  const fields = publicFields(extraction);
  if (extraction?.reliable && fields.company && fields.title) {
    return { action: 'commit', fields };
  }
  const fragments = Array.isArray(extraction?.fragments) ? extraction.fragments : [];
  if (fragments.length) {
    return { action: 'assist', fields, fragments, reasons: extraction?.assistReasons || [] };
  }
  return { action: 'form', fields, reason: extraction?.assistReasons?.[0] || 'no_fragments' };
}

export function assistDisclosure(aiConfig, fragments) {
  let origin = '已配置的接口';
  try {
    origin = new URL(String(aiConfig?.apiUrl ?? '')).origin;
  } catch {
    // The raw address can carry a query. The panel shows the origin, or this fallback.
  }
  return {
    origin,
    model: String(aiConfig?.model ?? '').trim(),
    fragments: (fragments || []).map(fragment => ({
      id: fragment.id,
      source: fragment.source,
      text: fragment.text
    }))
  };
}

export function afterAssist(result, fallback) {
  const base = publicFields(fallback);
  if (result?.status === 'ok' && result.reliable && result.fields?.company && result.fields?.title) {
    const fields = {
      company: clean(result.fields.company),
      title: clean(result.fields.title),
      location: clean(result.fields.location),
      sourceUrl: base.sourceUrl,
      dedupeUrl: base.dedupeUrl
    };
    if (fields.company && fields.title && fields.company !== fields.title) {
      return { action: 'commit', fields };
    }
  }
  const suggested = result?.fields || {};
  const fields = {
    company: clean(suggested.company) || base.company,
    title: clean(suggested.title) || base.title,
    location: clean(suggested.location) || base.location,
    sourceUrl: base.sourceUrl,
    dedupeUrl: base.dedupeUrl
  };
  if (fields.title && fields.title === fields.company) fields.title = '';
  return { action: 'form', fields, reason: result?.reason || 'manual' };
}

function publicFields(source) {
  return {
    company: clean(source?.company),
    title: clean(source?.title),
    location: clean(source?.location),
    sourceUrl: typeof source?.sourceUrl === 'string' ? source.sourceUrl : '',
    dedupeUrl: typeof source?.dedupeUrl === 'string' ? source.dedupeUrl : ''
  };
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}
