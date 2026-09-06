/**
 * Catalogue of supported question types.
 * `autoGraded: false` means a teacher has to score it by hand.
 * `payload` documents the shape a teacher must supply in question.data.
 *
 * Every type also accepts an optional `question.media` ({ url, type, alt } or a
 * bare URL string) that is shown above the prompt — an image, a diagram, a
 * short video or an audio clip to reason about.
 */
export const QUESTION_TYPES = {
  mcq_single:      { group: 'choice',   autoGraded: true,  payload: 'options[], answer (index)' },
  mcq_multiple:    { group: 'choice',   autoGraded: true,  payload: 'options[], answer (index[]), partial' },
  true_false:      { group: 'choice',   autoGraded: true,  payload: 'answer (bool)' },
  short_answer:    { group: 'text',     autoGraded: true,  payload: 'accepted[], caseSensitive, regex' },
  numeric:         { group: 'text',     autoGraded: true,  payload: 'answer (number), tolerance' },
  fill_blanks:     { group: 'text',     autoGraded: true,  payload: 'text with {{1}} markers, blanks[]' },
  matching:        { group: 'pairing',  autoGraded: true,  payload: 'left[], right[], answer (map)' },
  ordering:        { group: 'pairing',  autoGraded: true,  payload: 'items[], answer (ordered items)' },
  categorize:      { group: 'pairing',  autoGraded: true,  payload: 'items[], buckets[], answer (map)' },

  /* ---------------------------------------------------------------- image */
  image_choice:    { group: 'image',    autoGraded: true,  payload: 'options[{url,label}], answer (index | index[]), multiple' },
  image_hotspot:   { group: 'image',    autoGraded: true,  payload: 'image, zones[{id,x,y,w,h}] in %, answer (zone id[])' },
  image_label:     { group: 'image',    autoGraded: true,  payload: 'image, markers[{id,x,y}] in %, labels[], answer (map)' },
  image_order:     { group: 'image',    autoGraded: true,  payload: 'items[{id,url,caption}], answer (ordered ids)' },

  code_output:     { group: 'code',     autoGraded: true,  payload: 'code, language, accepted[]' },
  code_write:      { group: 'code',     autoGraded: true,  payload: 'starter, functionName, tests[]' },
  code_fix:        { group: 'code',     autoGraded: true,  payload: 'code, functionName, tests[]' },
  bug_find:        { group: 'code',     autoGraded: true,  payload: 'code, answer (line number)' },
  sql_query:       { group: 'code',     autoGraded: true,  payload: 'schema, accepted[] (normalised SQL)' },
  terminal:        { group: 'code',     autoGraded: true,  payload: 'accepted[] (shell commands)' },
  base_convert:    { group: 'applied',  autoGraded: true,  payload: 'value, fromBase, toBase' },
  truth_table:     { group: 'applied',  autoGraded: true,  payload: 'inputs[], expression, answer (bool[])' },
  hotspot:         { group: 'applied',  autoGraded: true,  payload: 'regions[{id,label}], answer (region id[])' },
  flashcard:       { group: 'study',    autoGraded: true,  payload: 'back — self assessed, always credited' },
  essay:           { group: 'study',    autoGraded: false, payload: 'rubric[], minWords' }
};

export const TYPE_LIST = Object.keys(QUESTION_TYPES);
export const isAutoGraded = t => QUESTION_TYPES[t]?.autoGraded === true;

/** Types grouped for the authoring UI, in the order teachers should see them. */
export const TYPE_GROUPS = ['choice', 'text', 'pairing', 'image', 'code', 'applied', 'study'];
export const typesByGroup = () => TYPE_GROUPS.map(group => ({
  group,
  types: TYPE_LIST.filter(t => QUESTION_TYPES[t].group === group)
}));

/** Normalises `media` to { url, kind, alt } so callers never branch on shape. */
export function normaliseMedia(media) {
  if (!media) return null;
  const raw = typeof media === 'string' ? { url: media } : media;
  if (!raw.url) return null;
  const kind = raw.kind || raw.type ||
    (/\.(mp4|webm|ogv)(\?|$)/i.test(raw.url) ? 'video'
      : /\.(mp3|wav|ogg|m4a)(\?|$)/i.test(raw.url) ? 'audio' : 'image');
  return { url: raw.url, kind, alt: raw.alt || '' };
}
