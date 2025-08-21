// Minimal, framework-agnostic helpers

const API_BASE = import.meta?.env?.VITE_API_BASE || process.env.API_BASE || "/api";

const THREAD_KEY = "assistant_thread_id";

export function getSavedThreadId(): string | null {
  const v = localStorage.getItem(THREAD_KEY);
  return v && v !== "undefined" && v !== "null" ? v : null;
}

export function saveThreadId(id: string) {
  localStorage.setItem(THREAD_KEY, id);
}

// Create-or-reuse thread before runs
export async function getOrCreateThreadId(): Promise<string> {
  const existing = getSavedThreadId();
  if (existing) return existing;

  const res = await fetch(`${API_BASE}/threads`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to create thread: ${res.status}`);
  const data = await res.json();
  if (!data?.id) throw new Error("Thread create returned no id");
  saveThreadId(data.id);
  return data.id;
}

// Start a run safely
export async function startRun(input: string, extra?: Record<string, unknown>) {
  const threadId = await getOrCreateThreadId(); // <-- guarantees not undefined
  const url = `${API_BASE}/threads/${encodeURIComponent(threadId)}/runs`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, ...extra }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Run failed: ${res.status} ${txt}`);
  }
  return res.json();
}
