/**
 * Catalogue of supported question types.
 * `autoGraded: false` means a teacher has to score it by hand.
 * `payload` documents the shape a teacher must supply in question.data.
 */
export const QUESTION_TYPES = {
  mcq_single:      { group: 'choice',   autoGraded: true,  payload: 'options[], answer (index)' },
  mcq_multiple:    { group: 'choice',   autoGraded: true,  payload: 'options[], answer (index[]), partial' },
  true_false:      { group: 'choice',   autoGraded: true,  payload: 'answer (bool)' },
  short_answer:    { group: 'text',     autoGraded: true,  payload: 'accepted[], caseSensitive, regex' },
  numeric:         { group: 'text',     autoGraded: true,  payload: 'answer (number), tolerance' },
  fill_blanks:     { group: 'text',     autoGraded: true,  payload: 'text with {{1}} markers, blanks[]' },
  matching:        { group: 'pairing',  autoGraded: true,  payload: 'left[], right[], answer (map)' },
  ordering:        { group: 'pairing',  autoGraded: true,  payload: 'items[], answer (index order)' },
  categorize:      { group: 'pairing',  autoGraded: true,  payload: 'items[], buckets[], answer (map)' },
  code_output:     { group: 'code',     autoGraded: true,  payload: 'code, language, accepted[]' },
  code_write:      { group: 'code',     autoGraded: true,  payload: 'starter, functionName, tests[]' },
  code_fix:        { group: 'code',     autoGraded: true,  payload: 'code, functionName, tests[]' },
  bug_find:        { group: 'code',     autoGraded: true,  payload: 'code, answer (line number)' },
  sql_query:       { group: 'code',     autoGraded: true,  payload: 'schema, accepted[] (normalised SQL)' },
  terminal:        { group: 'code',     autoGraded: true,  payload: 'accepted[] (shell commands)' },
  base_convert:    { group: 'applied',  autoGraded: true,  payload: 'value, fromBase, toBase' },
  truth_table:     { group: 'applied',  autoGraded: true,  payload: 'inputs[], expression, answer (bool[])' },
  hotspot:         { group: 'applied',  autoGraded: true,  payload: 'image, regions[], answer (region id)' },
  flashcard:       { group: 'study',    autoGraded: true,  payload: 'back — self assessed, always credited' },
  essay:           { group: 'study',    autoGraded: false, payload: 'rubric[], minWords' }
};

export const TYPE_LIST = Object.keys(QUESTION_TYPES);
export const isAutoGraded = t => QUESTION_TYPES[t]?.autoGraded === true;
