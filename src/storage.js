// Persistence adapter for standalone deployment (e.g. Netlify).
// Mirrors the window.storage API (get/set/delete/list) used by App.jsx.
//
// If Supabase credentials are configured (see .env.example), all data is
// read from / written to a shared Supabase table ("kv_store"), so every
// device (admin + all sellers) sees the same live data — real multi-device
// sync, on Supabase's free tier.
//
// If no Supabase credentials are set, the app falls back automatically to
// the browser's localStorage (works, but per-device only — no sync).

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || "").trim();
const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY || "").trim();

function isValidHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

let supabase = null;

if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  if (isValidHttpUrl(SUPABASE_URL)) {
    try {
      supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    } catch (e) {
      console.error("[عطورنا] فشل الاتصال بـ Supabase، سيتم استخدام التخزين المحلي:", e.message);
      supabase = null;
    }
  } else {
    console.error(
      `[عطورنا] قيمة VITE_SUPABASE_URL غير صالحة كرابط ("${SUPABASE_URL}"). تأكد أنها تبدأ بـ https:// ولم يتم عكسها مع anon key. سيتم استخدام التخزين المحلي مؤقتاً.`
    );
  }
}

if (!supabase) {
  console.warn(
    "[عطورنا] لم يتم ضبط بيانات Supabase بشكل صحيح — سيتم استخدام تخزين محلي (localStorage) بدون مزامنة بين الأجهزة. راجع ملف .env.example."
  );
}

/* ---------- localStorage fallback (used only if Supabase isn't configured) ---------- */

const NS = "atourna";
const localKey = (key, shared) => `${NS}:${shared ? "shared" : "private"}:${key}`;

const localAdapter = {
  async get(key, shared) {
    const raw = localStorage.getItem(localKey(key, shared));
    if (raw === null) return null;
    return { key, value: raw, shared };
  },
  async set(key, value, shared) {
    localStorage.setItem(localKey(key, shared), value);
    return { key, value, shared };
  },
  async delete(key, shared) {
    localStorage.removeItem(localKey(key, shared));
    return { key, deleted: true, shared };
  },
  async list(prefix, shared) {
    const full = localKey(prefix, shared);
    const nsPrefix = `${NS}:${shared ? "shared" : "private"}:`;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(full)) keys.push(k.slice(nsPrefix.length));
    }
    return { keys, prefix, shared };
  },
};

/* ---------- Supabase-backed adapter (used when configured) ---------- */

const supabaseAdapter = {
  async get(key) {
    const { data, error } = await supabase.from("kv_store").select("value").eq("key", key).maybeSingle();
    if (error || !data) return null;
    return { key, value: data.value, shared: true };
  },
  async set(key, value) {
    const { error } = await supabase
      .from("kv_store")
      .upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) {
      console.error("[عطورنا] فشل حفظ البيانات على Supabase:", error.message);
      return null;
    }
    return { key, value, shared: true };
  },
  async delete(key) {
    const { error } = await supabase.from("kv_store").delete().eq("key", key);
    if (error) return null;
    return { key, deleted: true, shared: true };
  },
  async list(prefix = "") {
    const { data, error } = await supabase.from("kv_store").select("key").ilike("key", `${prefix}%`);
    if (error) return { keys: [], prefix, shared: true };
    return { keys: (data || []).map((d) => d.key), prefix, shared: true };
  },
};

window.storage = supabase ? supabaseAdapter : localAdapter;
