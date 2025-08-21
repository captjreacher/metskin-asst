// openai_positional_compat.js
// Converts old positional SDK calls to the new object form at runtime.

export function patchOpenAIPositionalCompat(openai) {
  const T = openai?.beta?.threads;
  if (!T) return;

  // messages.create(threadId, {...})  ->  messages.create({ thread_id, ... })
  if (T.messages?.create && !T.messages.__patched) {
    const origCreate = T.messages.create.bind(T.messages);
    T.messages.create = (a, b) => (
      typeof a === "string" ? origCreate({ thread_id: a, ...(b || {}) }) : origCreate(a)
    );

    // messages.list(threadId, {limit}) -> messages.list({ thread_id, limit })
    const origList = T.messages.list.bind(T.messages);
    T.messages.list = (a, b) => (
      typeof a === "string" ? origList({ thread_id: a, ...(b || {}) }) : origList(a)
    );

    T.messages.__patched = true;
  }

  // runs.create(threadId, {...}) -> runs.create({ thread_id, ... })
  if (T.runs?.create && !T.runs.__patched_create) {
    const origRunCreate = T.runs.create.bind(T.runs);
    T.runs.create = (a, b) => (
      typeof a === "string" ? origRunCreate({ thread_id: a, ...(b || {}) }) : origRunCreate(a)
    );
    T.runs.__patched_create = true;
  }

  // runs.retrieve(threadId, runId) -> runs.retrieve({ thread_id, run_id })
  if (T.runs?.retrieve && !T.runs.__patched_retrieve) {
    const origRetrieve = T.runs.retrieve.bind(T.runs);
    T.runs.retrieve = (a, b) => (
      typeof a === "string" ? origRetrieve({ thread_id: a, run_id: b }) : origRetrieve(a)
    );
    T.runs.__patched_retrieve = true;
  }
}
