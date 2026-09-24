/**
 * What one click on "保存岗位到桌面端" should show next.
 *
 * A reliable company and title is ready for the user to review. Anything less opens the
 * same form with a note saying what is uncertain; the plugin does not guess. Either way
 * the desktop write happens only after the user confirms the form. The URL is copied from
 * the local redaction result.
 */

export function nextSaveStep(extraction) {
  const fields = publicFields(extraction);
  if (extraction?.reliable && fields.company && fields.title) {
    return { action: 'commit', fields };
  }
  return { action: 'form', fields, reason: extraction?.assistReasons?.[0] || 'manual' };
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
