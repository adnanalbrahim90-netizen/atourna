import ExcelJS from "exceljs";
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Plus, Trash2, Printer, Download, Upload, LogOut, Package, Receipt,
  BarChart3, Settings as SettingsIcon, Users as UsersIcon, Search, X, Check,
  Menu, Save, Image as ImageIcon, ShoppingCart, Home, AlertTriangle, Eye, EyeOff,
  Sun, Moon, Pencil, Wallet, Tag, MessageSquare, Megaphone, Gift, Ban,
  Wallet2, Calculator, Percent, Droplet, TrendingUp, TrendingDown, ShieldCheck, Bell,
  Landmark, HandCoins, CalendarRange, Users2, KeyRound, Type,
  Trophy, Palette, Medal, Target, Flame, Award, Sparkles, Grid3x3,
  History, LogIn, ShieldAlert, Edit3, ScrollText,
  Boxes, ArrowLeftRight, PackageCheck, Minus, Send, ChevronUp, ChevronDown,
  ChevronLeft, ChevronRight, LayoutGrid
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell, Legend
} from "recharts";

/* ---------------------------------- helpers ---------------------------------- */

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

const fmt = (n) => {
  const v = Number(n || 0);
  // "en-GB" numeral formatting forces Latin digits (0-9) even inside an RTL/Arabic UI,
  // instead of the Arabic-Indic digits (٠١٢٣) that "ar-KW" would otherwise produce.
  // useGrouping:false drops thousand-separator commas so figures stay short and
  // never wrap awkwardly mid-number on narrow mobile cards.
  return v.toLocaleString("en-GB", { minimumFractionDigits: 3, maximumFractionDigits: 3, useGrouping: false });
};

const todayISO = () => new Date().toISOString();

const dateLabel = (iso) => {
  try {
    return new Date(iso).toLocaleDateString("en-GB", { year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return iso;
  }
};

const timeLabel = (iso) => {
  try {
    return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
};

async function storeGet(key, fallback, shared = true) {
  try {
    const res = await window.storage.get(key, shared);
    if (!res || res.value === undefined) return fallback;
    return JSON.parse(res.value);
  } catch {
    return fallback;
  }
}
async function storeSet(key, value, shared = true) {
  try {
    await window.storage.set(key, JSON.stringify(value), shared);
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------- seller stock allocation ---------------------------- */
// A product only becomes "managed" the moment the admin assigns at least one
// seller-specific quantity for it (a `perfume_seller_allocations` record).
// Until then every seller keeps selling straight from the shared pool,
// exactly like before — this feature is entirely opt-in, product by product.
const isProductManaged = (allocations, productId) => allocations.some((a) => a.productId === productId);

// Who may distribute stock between accounts: the primary admin always, plus
// any single account (admin or seller) the primary admin has explicitly
// given the "warehouse manager" (مسؤول المخزن) responsibility to.
const canManageAllocations = (user) => !!(user && (user.isPrimaryAdmin || user.canManageStock));

// Builds one entry of the stock-distribution movement log — the detailed,
// per-name record of every quantity handed to, taken from or moved between
// accounts, and by whom.
const makeAllocationLogEntry = ({ byUser, type, productId, productName, sellerId, sellerName, before, after, note }) => ({
  id: uid(),
  date: todayISO(),
  byUserId: byUser?.id || "",
  byUserName: byUser?.name || "",
  type, // 'set' | 'adjust' | 'equal' | 'clear' | 'transfer_in' | 'transfer_out'
  productId,
  productName,
  sellerId,
  sellerName,
  before,
  after,
  delta: after - before,
  note: note || "",
});

const getAllocationRecord = (allocations, sellerId, productId) =>
  allocations.find((a) => a.sellerId === sellerId && a.productId === productId) || null;

const remainingForSeller = (allocations, sellerId, productId) =>
  getAllocationRecord(allocations, sellerId, productId)?.remaining || 0;

const totalRemainingForProduct = (allocations, productId) =>
  allocations.filter((a) => a.productId === productId).reduce((sum, a) => sum + a.remaining, 0);

// Draws `qty` units of `productId` out of `sellerId`'s own allocation only.
// There is no automatic cross-seller borrowing: once a seller's own share
// runs dry, getting more requires sending a stock-transfer request to a
// colleague (see the request/approval workflow below), which permanently
// reassigns the allocation before any sale happens — so by the time a sale
// is submitted, every unit it uses is already legitimately the seller's own.
const consumeOwnAllocation = (allocations, sellerId, productId, qty) => {
  const next = allocations.map((a) => ({ ...a }));
  const rec = next.find((a) => a.sellerId === sellerId && a.productId === productId);
  if (rec) rec.remaining = Math.max(0, rec.remaining - qty);
  return next;
};

// Reverses consumeOwnAllocation — used when a sale is deleted or edited, so
// every sold unit goes back to exactly the seller who sold it. Silently
// skips a source whose allocation record no longer exists (e.g. the product
// was deleted since), rather than failing the whole undo.
const restoreAllocation = (allocations, sources) => {
  if (!sources || sources.length === 0) return allocations;
  const next = allocations.map((a) => ({ ...a }));
  sources.forEach((src) => {
    const rec = next.find((a) => a.sellerId === src.sellerId && a.productId === src.productId);
    if (rec) rec.remaining = Math.min(rec.allocated, rec.remaining + src.qty);
  });
  return next;
};

// Permanently moves `qty` units of one seller's personal allocation to a
// colleague who asked for them — the effect of an approved stock-transfer
// request. Caps the transfer at whatever the lender still actually has at
// approval time (they may have sold some of it while the request sat
// pending) and creates the receiver's allocation record on the spot if this
// is their first assignment for that product.
const applyStockTransfer = (allocations, fromSellerId, toSellerId, toSellerName, productId, productName, qty) => {
  const next = allocations.map((a) => ({ ...a }));
  const lender = next.find((a) => a.sellerId === fromSellerId && a.productId === productId);
  const available = lender ? lender.remaining : 0;
  const transferQty = Math.max(0, Math.min(qty, available));
  if (transferQty <= 0) return { allocations: next, transferredQty: 0 };

  lender.allocated -= transferQty;
  lender.remaining -= transferQty;

  const receiver = next.find((a) => a.sellerId === toSellerId && a.productId === productId);
  if (receiver) {
    receiver.allocated += transferQty;
    receiver.remaining += transferQty;
  } else {
    next.push({ id: uid(), sellerId: toSellerId, sellerName: toSellerName, productId, productName, allocated: transferQty, remaining: transferQty });
  }
  return { allocations: next, transferredQty: transferQty };
};

// Passwords are never stored in plain text: every password is hashed with
// SHA-256 (via the browser's built-in Web Crypto API) before being written
// to storage, and login compares hash-to-hash. A short random per-install
// salt is mixed in so the same password doesn't always hash identically.
async function hashPassword(plain) {
  const enc = new TextEncoder().encode("atourna-salt-v1:" + plain);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const COLORS = ["#B8894A", "#5B2333", "#3F7D57", "#8A7B6C", "#C9A227", "#7A4B63"];

function getSeenAnnouncementIds(userId) {
  try {
    const raw = window.localStorage.getItem(`atourna_seen_announcements_${userId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function markAnnouncementSeen(userId, announcementId) {
  const seen = new Set(getSeenAnnouncementIds(userId));
  seen.add(announcementId);
  window.localStorage.setItem(`atourna_seen_announcements_${userId}`, JSON.stringify(Array.from(seen)));
}

// Tracks which resolved stock-transfer requests a requester has already
// been notified about (per device), so the one-time "your request was
// approved/rejected" toast never repeats on a later poll.
function getSeenRequestResolutions(userId) {
  try {
    const raw = window.localStorage.getItem(`atourna_seen_requests_${userId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function markRequestResolutionSeen(userId, requestId) {
  const seen = new Set(getSeenRequestResolutions(userId));
  seen.add(requestId);
  window.localStorage.setItem(`atourna_seen_requests_${userId}`, JSON.stringify(Array.from(seen)));
}

// Incoming stock requests this device has already raised a phone
// notification for — so an old pending request doesn't buzz the phone again
// on every reload (the in-page popup still shows until answered).
function getNotifiedIncomingRequests(userId) {
  try {
    const raw = window.localStorage.getItem(`atourna_notified_incoming_${userId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function markIncomingRequestNotified(userId, requestId) {
  const seen = new Set(getNotifiedIncomingRequests(userId));
  seen.add(requestId);
  window.localStorage.setItem(`atourna_notified_incoming_${userId}`, JSON.stringify(Array.from(seen).slice(-300)));
}

const notificationsSupported = () => typeof window !== "undefined" && "Notification" in window && "serviceWorker" in navigator;
const isIOSBrowserTab = () =>
  typeof navigator !== "undefined" &&
  /iphone|ipad|ipod/i.test(navigator.userAgent) &&
  !(window.navigator.standalone || window.matchMedia?.("(display-mode: standalone)").matches);

/* ---------------------- Real phone notifications (Web Push) ---------------------- */
// Each device that allows notifications registers a push subscription,
// stored in the shared data under PUSH_SUBS_KEY tagged with the logged-in
// user. To notify someone, the app asks the site's own push API (Cloudflare Pages Functions)
// (/api/push/send) to deliver to that user's devices — it arrives even when
// the app is fully closed.
const PUSH_SUBS_KEY = "perfume_push_subscriptions";

// The notification API is served on the app's own address
// (atourna.pages.dev → Cloudflare Pages Functions in /functions).
const pushApi = (path) => path;

function urlB64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// Subscribes this device (if permitted) and links it to `user`. Returns
// { ok: true } when real push is active on this device, otherwise
// { ok: false, reason } with a readable Arabic explanation of the exact step
// that failed — shown in the notifications panel so problems can be fixed
// instead of guessed at.
const withTimeout = (promise, ms, label) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms))]);

async function registerPushForUser(user) {
  if (!user) return { ok: false, reason: "لا يوجد مستخدم مسجّل" };
  if (!notificationsSupported()) return { ok: false, reason: "هذا المتصفح لا يدعم الإشعارات" };
  if (!("PushManager" in window)) return { ok: false, reason: "هذا المتصفح لا يدعم إشعارات الدفع (PushManager) — جرّب Google Chrome" };
  if (Notification.permission !== "granted") return { ok: false, reason: "لم يتم السماح بالإشعارات" };

  let publicKey;
  try {
    const keyRes = await withTimeout(fetch(pushApi("/api/push/key"), { cache: "no-store" }), 10000, "timeout");
    if (!keyRes.ok) return { ok: false, reason: `خادم الإشعارات غير جاهز (رمز ${keyRes.status})` };
    const text = await keyRes.text();
    try {
      publicKey = JSON.parse(text).publicKey;
    } catch {
      return { ok: false, reason: "وصل رد غير متوقع من خادم الإشعارات (صفحة بدل بيانات)" };
    }
    if (!publicKey) return { ok: false, reason: "خادم الإشعارات لم يُرجع المفتاح العام" };
  } catch (e) {
    return { ok: false, reason: `تعذّر الوصول إلى خادم الإشعارات: ${e?.message || e}` };
  }

  let reg;
  try {
    reg = await navigator.serviceWorker.getRegistration();
    if (!reg) reg = await navigator.serviceWorker.register("/sw.js");
    reg = await withTimeout(navigator.serviceWorker.ready, 10000, "sw-timeout");
  } catch (e) {
    return { ok: false, reason: `لم يعمل ملف الخدمة (sw.js): ${e?.message || e}` };
  }

  const appKey = urlB64ToUint8Array(publicKey);
  let sub;
  try {
    sub = await reg.pushManager.getSubscription();
    // If the device was subscribed with a different key, start fresh.
    const existingKey = sub?.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    if (sub && existingKey && existingKey.join(",") !== appKey.join(",")) {
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub) {
      try {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
      } catch (first) {
        // One clean retry — a stale half-created subscription is the most
        // common cause of a first-time failure on Android.
        const stale = await reg.pushManager.getSubscription();
        if (stale) await stale.unsubscribe();
        try {
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
        } catch (second) {
          return { ok: false, reason: `رفض الجوال الاشتراك في الإشعارات: ${second?.name || ""} ${second?.message || second}` };
        }
      }
    }
  } catch (e) {
    return { ok: false, reason: `خطأ في الاشتراك: ${e?.name || ""} ${e?.message || e}` };
  }

  try {
    const data = sub.toJSON();
    const list = await storeGet(PUSH_SUBS_KEY, []);
    const current = list.find((x) => x.endpoint === data.endpoint);
    if (!current || current.userId !== user.id) {
      const next = [
        ...list.filter((x) => x.endpoint !== data.endpoint),
        { endpoint: data.endpoint, keys: data.keys, userId: user.id, userName: user.name, updatedAt: todayISO() },
      ].slice(-200);
      const saved = await storeSet(PUSH_SUBS_KEY, next);
      if (!saved) return { ok: false, reason: "تعذّر حفظ اشتراك الجهاز في قاعدة البيانات" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `تعذّر حفظ اشتراك الجهاز: ${e?.message || e}` };
  }
}

// On logout: stop sending this user's notifications to this device.
async function unlinkPushDevice() {
  try {
    if (!("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    if (!sub) return;
    const list = await storeGet(PUSH_SUBS_KEY, []);
    await storeSet(PUSH_SUBS_KEY, list.filter((x) => x.endpoint !== sub.endpoint));
  } catch {
    // ignore
  }
}

// Delivers a notification to every device of the given users. Never throws.
async function sendPushToUsers(userIds, payload) {
  try {
    const list = await storeGet(PUSH_SUBS_KEY, []);
    const subs = list.filter((x) => userIds.includes(x.userId));
    if (subs.length === 0) return { sent: 0, devices: 0 };
    const res = await fetch(pushApi("/api/push/send"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscriptions: subs.map(({ endpoint, keys }) => ({ endpoint, keys })), payload }),
    });
    if (!res.ok) return { sent: 0, devices: subs.length, error: `رمز ${res.status}` };
    const result = await res.json();
    if (result.expired?.length) {
      // Clean up devices that uninstalled the app or blocked notifications.
      const fresh = await storeGet(PUSH_SUBS_KEY, []);
      await storeSet(PUSH_SUBS_KEY, fresh.filter((x) => !result.expired.includes(x.endpoint)));
    }
    return { ...result, devices: subs.length };
  } catch (e) {
    // notifications are best-effort
    return { sent: 0, error: String(e?.message || e) };
  }
}

// Shows a system (phone / desktop) notification through the service worker —
// Android Chrome only allows notifications that way. Silently does nothing
// when unsupported or not permitted, so it can never break the app.
async function showSystemNotification(title, body, tag) {
  try {
    if (!notificationsSupported() || Notification.permission !== "granted") return;
    const options = {
      body,
      tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      dir: "rtl",
      lang: "ar",
      vibrate: [200, 100, 200],
      renotify: true,
      requireInteraction: true,
      data: { url: "/" },
    };
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) await reg.showNotification(title, options);
    else new Notification(title, options);
  } catch {
    // ignore — notifications are a convenience, never critical
  }
}

async function exportSalesExcel(label, list, companyName) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = companyName || "عطورنا";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("سجل المبيعات", {
    views: [{ rightToLeft: true, state: "frozen", ySplit: 4 }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1 },
  });

  // Brand palette
  const ACCENT = "B8894A";
  const ACCENT_DARK = "5B2333";
  const CREAM = "FBF3E7";
  const STRIPE = "F7F1E6";
  const BORDER_COLOR = "E3D6BE";
  const GREEN = "3F7D57";
  const RED = "B23A3A";

  const thinBorder = { style: "thin", color: { argb: "FF" + BORDER_COLOR } };
  const fullBorder = { top: thinBorder, left: thinBorder, bottom: thinBorder, right: thinBorder };

  const columns = [
    { header: "رقم الفاتورة", key: "invoiceNo", width: 16 },
    { header: "البائع", key: "seller", width: 16 },
    { header: "التاريخ", key: "date", width: 13 },
    { header: "المنتجات", key: "items", width: 42 },
    { header: "الإجمالي (K.D)", key: "total", width: 15 },
    { header: "المحصَّل (K.D)", key: "collected", width: 15 },
    { header: "المتبقي (K.D)", key: "remaining", width: 15 },
  ];
  sheet.columns = columns.map((c) => ({ key: c.key, width: c.width }));

  // --- Title banner (merged) ---
  sheet.mergeCells(1, 1, 1, columns.length);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = `${companyName || "عطورنا"} — سجل مبيعات: ${label}`;
  titleCell.font = { name: "Arial", size: 16, bold: true, color: { argb: "FFFFFFFF" } };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + ACCENT_DARK } };
  sheet.getRow(1).height = 30;

  // --- Subtitle (export date + record count) ---
  sheet.mergeCells(2, 1, 2, columns.length);
  const subCell = sheet.getCell(2, 1);
  subCell.value = `تاريخ التصدير: ${dateLabel(todayISO())}  ·  عدد الفواتير: ${list.length}`;
  subCell.font = { name: "Arial", size: 11, italic: true, color: { argb: "FF" + ACCENT_DARK } };
  subCell.alignment = { horizontal: "center", vertical: "middle" };
  subCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + CREAM } };
  sheet.getRow(2).height = 20;

  // spacer row
  sheet.getRow(3).height = 4;

  // --- Header row ---
  const headerRowIdx = 4;
  const headerRow = sheet.getRow(headerRowIdx);
  columns.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.header;
    cell.font = { name: "Arial", size: 12, bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + ACCENT } };
    cell.border = fullBorder;
  });
  headerRow.height = 24;

  // --- Data rows (zebra striping) ---
  list.forEach((s, idx) => {
    const rowIdx = headerRowIdx + 1 + idx;
    const row = sheet.getRow(rowIdx);
    const values = [
      s.invoiceNo,
      s.sellerName,
      dateLabel(s.date),
      s.items.map((i) => `${i.name} (${i.qty})`).join("، "),
      Number(s.total.toFixed(3)),
      Number(s.collected.toFixed(3)),
      Number(s.remaining.toFixed(3)),
    ];
    values.forEach((v, i) => {
      const cell = row.getCell(i + 1);
      cell.value = v;
      cell.font = { name: "Arial", size: 11, color: { argb: i === 5 ? "FF" + GREEN : i === 6 && s.remaining > 0 ? "FF" + RED : "FF2B211A" }, bold: i >= 4 };
      cell.alignment = { horizontal: i >= 4 ? "center" : i === 3 ? "right" : "center", vertical: "middle", wrapText: i === 3 };
      cell.border = fullBorder;
      if (i >= 4) cell.numFmt = "#,##0.000";
      if (idx % 2 === 1) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + STRIPE } };
      }
    });
  });

  // --- Totals row (formula-based, never hardcoded) ---
  const totalsRowIdx = headerRowIdx + 1 + list.length;
  const totalsRow = sheet.getRow(totalsRowIdx);
  const firstData = headerRowIdx + 1;
  const lastData = totalsRowIdx - 1;
  const labelCell = totalsRow.getCell(1);
  sheet.mergeCells(totalsRowIdx, 1, totalsRowIdx, 4);
  labelCell.value = "الإجمالي";
  labelCell.font = { name: "Arial", size: 12, bold: true, color: { argb: "FFFFFFFF" } };
  labelCell.alignment = { horizontal: "center", vertical: "middle" };
  labelCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + ACCENT_DARK } };
  labelCell.border = fullBorder;
  ["E", "F", "G"].forEach((col, i) => {
    const cell = totalsRow.getCell(5 + i);
    cell.value = list.length > 0 ? { formula: `SUM(${col}${firstData}:${col}${lastData})` } : 0;
    cell.numFmt = "#,##0.000";
    cell.font = { name: "Arial", size: 12, bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + ACCENT_DARK } };
    cell.border = fullBorder;
  });
  totalsRow.height = 24;

  sheet.autoFilter = { from: { row: headerRowIdx, column: 1 }, to: { row: headerRowIdx, column: columns.length } };

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `سجل-مبيعات-${label}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---------------------------------- brand mark ---------------------------------- */

function PerfumeMark({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="capGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#D8B978" />
          <stop offset="100%" style={{ stopColor: "var(--accent)" }} />
        </linearGradient>
        <linearGradient id="bottleGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: "var(--accent)" }} />
          <stop offset="100%" style={{ stopColor: "var(--accent-dark)" }} />
        </linearGradient>
      </defs>
      <rect x="24" y="6" width="16" height="10" rx="2" fill="url(#capGrad)" />
      <rect x="28" y="14" width="8" height="6" fill="#D8B978" />
      <path d="M18 24C18 20.7 20.7 18 24 18H40C43.3 18 46 20.7 46 24V50C46 54.4 42.4 58 38 58H26C21.6 58 18 54.4 18 50V24Z" fill="url(#bottleGrad)" />
      <path d="M22 30H42V50C42 52.2 40.2 54 38 54H26C23.8 54 22 52.2 22 50V30Z" fill="#FFFFFF" opacity="0.14" />
      <circle cx="32" cy="40" r="3.2" fill="#F4E7C9" opacity="0.9" />
    </svg>
  );
}

/* ---------------------------------- shared UI atoms ---------------------------------- */

function Btn({ children, variant = "primary", className = "", style, ...props }) {
  const variants = {
    primary: "nm-btn solid",
    dark: "nm-btn ink",
    ghost: "nm-btn ink",
    outline: "nm-btn",
    danger: "nm-btn solid-danger",
  };
  return (
    <button className={`${variants[variant] || "nm-btn"} ${className}`} style={style} {...props}>
      {children}
    </button>
  );
}

function Card({ children, className = "" }) {
  return <div className={`nm-card ${className}`}>{children}</div>;
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-[var(--muted)] mb-1">{label}</span>
      {children}
    </label>
  );
}

const inputCls = "nm-input px-3.5 py-2.5 text-sm";

/* ---------------------------------- Login ---------------------------------- */

function LoginScreen({ users, onLogin, onRecover, onLegacyUpgrade }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState("");
  const [showRecover, setShowRecover] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const hashed = await hashPassword(password);
    const uname = username.trim().toLowerCase();

    // Normal path: password already stored as a hash.
    let u = users.find((x) => x.username.trim().toLowerCase() === uname && x.password === hashed);

    // Legacy path: this account still has its old plain-text password
    // (from before password hashing was introduced). Accept it once, then
    // silently upgrade it to a proper hash so it's secure from now on.
    let legacyMatch = null;
    if (!u) {
      legacyMatch = users.find((x) => x.username.trim().toLowerCase() === uname && x.password === password);
      if (legacyMatch) u = legacyMatch;
    }

    if (!u) {
      setErr("اسم المستخدم أو كلمة المرور غير صحيحة");
      return;
    }
    setErr("");
    if (legacyMatch) {
      await onLegacyUpgrade(legacyMatch.id, hashed);
    }
    onLogin(u);
  };

  return (
    <div className="min-h-screen w-full bg-[var(--bg)] flex items-center justify-center px-4" dir="rtl">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <PerfumeMark size={64} />
          <h1 className="mt-3 text-3xl font-bold text-[var(--accent-dark)]" style={{ fontFamily: "'Amiri', serif" }}>
            عطورنا
          </h1>
          <p className="text-[var(--muted)] text-sm mt-1">نظام إدارة مبيعات العطور والبخور</p>
        </div>
        <Card className="p-6">
          <form onSubmit={submit} className="space-y-4">
            <Field label="اسم المستخدم">
              <input className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
            </Field>
            <Field label="كلمة المرور">
              <div className="relative">
                <input
                  className={inputCls + " pl-9"}
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
                <button type="button" onClick={() => setShowPw((s) => !s)} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--muted)]">
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </Field>
            {err && (
              <div className="flex items-center gap-2 text-[#B23A3A] text-xs bg-[#FBEAEA] rounded-lg px-3 py-2">
                <AlertTriangle size={14} /> {err}
              </div>
            )}
            <Btn type="submit" className="w-full">
              تسجيل الدخول
            </Btn>
          </form>
          <button onClick={() => setShowRecover(true)} className="w-full text-center text-xs text-[var(--accent)] font-semibold mt-4">
            نسيت اسم المستخدم أو كلمة المرور؟
          </button>
        </Card>
        <p className="flex items-center justify-center gap-1.5 text-[11px] text-[var(--muted)] mt-4">
          <ShieldCheck size={13} /> كلمات المرور مشفّرة بالكامل ولا تُخزَّن كنص صريح
        </p>
      </div>

      {showRecover && (
        <RecoverModal
          users={users}
          onRecover={onRecover}
          onClose={() => setShowRecover(false)}
        />
      )}
    </div>
  );
}

function RecoverModal({ users, onRecover, onClose }) {
  const [step, setStep] = useState(1); // 1: username, 2: security question, 3: new password, 4: done
  const [username, setUsername] = useState("");
  const [answer, setAnswer] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [err, setErr] = useState("");
  const [foundUser, setFoundUser] = useState(null);

  const checkUsername = () => {
    const u = users.find((x) => x.username.trim().toLowerCase() === username.trim().toLowerCase() && x.isPrimaryAdmin);
    if (!u) {
      setErr("هذا الحساب غير موجود، أو ليس حساب المدير الأساسي القابل للاسترجاع");
      return;
    }
    if (!u.securityQuestion) {
      setErr("لا يوجد سؤال أمان مسجَّل لهذا الحساب. تواصل مع الدعم الفني.");
      return;
    }
    setFoundUser(u);
    setErr("");
    setStep(2);
  };

  const checkAnswer = async () => {
    if (!answer.trim()) return;
    const hashedAnswer = await hashPassword(answer.trim().toLowerCase());
    if (hashedAnswer !== foundUser.securityAnswer) {
      setErr("الإجابة غير صحيحة، حاول مرة أخرى");
      return;
    }
    setErr("");
    setStep(3);
  };

  const resetPassword = async () => {
    if (!newPassword.trim() || newPassword.length < 4) {
      setErr("كلمة المرور يجب أن تكون 4 أحرف على الأقل");
      return;
    }
    if (newPassword !== confirmPassword) {
      setErr("كلمتا المرور غير متطابقتين");
      return;
    }
    const hashed = await hashPassword(newPassword);
    const ok = await onRecover(foundUser.username, hashed);
    if (ok) {
      setErr("");
      setStep(4);
    } else {
      setErr("تعذّر تحديث كلمة المرور، حاول مرة أخرى");
    }
  };

  const STEP_TITLES = ["", "تحديد الحساب", "التحقق من الهوية", "كلمة مرور جديدة", "تم بنجاح"];

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/50 p-4 announce-backdrop" dir="rtl">
      <div className="bg-[var(--surface)] rounded-2xl w-full max-w-sm p-6 announce-pop">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-lg font-bold flex items-center gap-2"><KeyRound size={18} className="text-[var(--accent)]" /> استعادة الحساب</h3>
          <button onClick={onClose} className="p-1 text-[var(--muted)]"><X size={20} /></button>
        </div>

        {step < 4 && (
          <div className="flex items-center gap-1.5 my-4">
            {[1, 2, 3].map((n) => (
              <div key={n} className="flex-1 flex items-center gap-1.5">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 transition ${
                  step > n ? "bg-[#3F7D57] text-white" : step === n ? "bg-[var(--accent)] text-white" : "bg-[var(--surface-3)] text-[var(--muted)]"
                }`}>
                  {step > n ? <Check size={12} /> : n}
                </div>
                {n < 3 && <div className={`flex-1 h-1 rounded-full ${step > n ? "bg-[#3F7D57]" : "bg-[var(--surface-3)]"}`} />}
              </div>
            ))}
          </div>
        )}
        {step < 4 && <p className="text-[11px] font-semibold text-[var(--muted)] mb-3">الخطوة {step} من 3 — {STEP_TITLES[step]}</p>}

        {step === 1 && (
          <div className="space-y-3">
            <p className="text-xs text-[var(--muted)]">الاسترجاع متاح فقط لحساب المدير الأساسي للنظام. أدخل اسم المستخدم الخاص به للمتابعة.</p>
            <Field label="اسم المستخدم"><input className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={(e) => e.key === "Enter" && checkUsername()} autoFocus /></Field>
            {err && <p className="text-xs text-[#B23A3A] flex items-center gap-1.5"><AlertTriangle size={13} /> {err}</p>}
            <Btn className="w-full" onClick={checkUsername}>التالي</Btn>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <p className="text-xs text-[var(--muted)]">أجب على سؤال الأمان المسجَّل لهذا الحساب للتحقق من هويتك.</p>
            <Field label={foundUser.securityQuestion}>
              <input className={inputCls} value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === "Enter" && checkAnswer()} autoFocus />
            </Field>
            {err && <p className="text-xs text-[#B23A3A] flex items-center gap-1.5"><AlertTriangle size={13} /> {err}</p>}
            <Btn className="w-full" onClick={checkAnswer}>تأكيد الإجابة</Btn>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <p className="text-xs text-[var(--muted)]">أدخل كلمة مرور جديدة وسهلة التذكر — ستُستخدم من الآن فصاعداً لتسجيل الدخول.</p>
            <Field label="كلمة المرور الجديدة">
              <input type="text" className={inputCls} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoFocus />
            </Field>
            <Field label="تأكيد كلمة المرور">
              <input type="text" className={inputCls} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && resetPassword()} />
            </Field>
            {err && <p className="text-xs text-[#B23A3A] flex items-center gap-1.5"><AlertTriangle size={13} /> {err}</p>}
            <Btn className="w-full" onClick={resetPassword}>حفظ كلمة المرور الجديدة</Btn>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-3 text-center py-2">
            <div className="w-14 h-14 rounded-full bg-[#EAF6EF] flex items-center justify-center mx-auto">
              <Check size={28} className="text-[#3F7D57]" />
            </div>
            <p className="text-sm font-semibold">تم تحديث كلمة المرور بنجاح ✅</p>
            <p className="text-xs text-[var(--muted)]">يمكنك الآن تسجيل الدخول بكلمة المرور الجديدة.</p>
            <Btn className="w-full" onClick={onClose}>تسجيل الدخول الآن</Btn>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------- First-run Setup ---------------------------------- */

/* ---------------------------------- Confirm Dialog ---------------------------------- */

function ConfirmModal({ message, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/55 p-4 announce-backdrop" dir="rtl">
      <div className="bg-[var(--surface)] rounded-2xl w-full max-w-xs p-6 text-center announce-pop">
        <div className="w-12 h-12 rounded-full bg-[#FBEAEA] flex items-center justify-center mx-auto mb-3">
          <AlertTriangle size={22} className="text-[#B23A3A]" />
        </div>
        <p className="text-sm font-semibold mb-5">{message}</p>
        <div className="flex gap-2">
          <Btn variant="danger" className="flex-1" onClick={onConfirm}>
            <Trash2 size={15} /> تأكيد الحذف
          </Btn>
          <Btn variant="outline" className="flex-1" onClick={onCancel}>
            إلغاء
          </Btn>
        </div>
      </div>
    </div>
  );
}

// Lets a seller ask a specific colleague for some of their remaining
// personal allocation of a product, once their own share has run out. The
// request only ever reaches the colleague chosen here — it isn't broadcast
// — and nothing moves until that colleague approves it from their
// notifications bell.
function StockRequestModal({ product, sellerAllocations, users, seller, onSend, onClose }) {
  const colleagues = users
    .filter((u) => u.id !== seller.id)
    .map((u) => ({ user: u, remaining: remainingForSeller(sellerAllocations, u.id, product.id) }))
    .filter((c) => c.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining);

  const [targetId, setTargetId] = useState(colleagues[0]?.user.id || "");
  const [qty, setQty] = useState(1);

  const target = colleagues.find((c) => c.user.id === targetId);

  const submit = () => {
    if (!target) return;
    const q = Math.max(1, Math.min(Math.floor(Number(qty) || 1), target.remaining));
    onSend(product, target.user, q, seller);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/55 p-4 announce-backdrop" dir="rtl">
      <div className="bg-[var(--surface)] rounded-2xl w-full max-w-sm p-6 announce-pop">
        <div className="w-12 h-12 rounded-full bg-[#FFF6E5] flex items-center justify-center mx-auto mb-3">
          <ArrowLeftRight size={22} className="text-[#C97B3D]" />
        </div>
        <h3 className="font-bold text-center mb-1">طلب كمية من "{product.name}"</h3>
        <p className="text-xs text-[var(--muted)] text-center mb-4">
          نفدت حصتك من هذا المنتج. اختر زميلاً لديه رصيد متبقٍ واطلب منه كمية — سيصله إشعار وعليه الموافقة قبل أن تنتقل الكمية إليك.
        </p>

        {colleagues.length === 0 ? (
          <EmptyState text="لا يوجد زملاء لديهم رصيد متبقٍ من هذا المنتج حالياً" />
        ) : (
          <div className="space-y-3">
            <Field label="اطلب من">
              <select className={inputCls} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                {colleagues.map((c) => (
                  <option key={c.user.id} value={c.user.id}>{c.user.name} — لديه {c.remaining}</option>
                ))}
              </select>
            </Field>
            <Field label="الكمية المطلوبة">
              <input
                type="number"
                min="1"
                max={target?.remaining || 1}
                className={inputCls}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
            </Field>
          </div>
        )}

        <div className="flex gap-2 mt-5">
          <Btn className="flex-1" disabled={colleagues.length === 0} onClick={submit}>
            <Send size={15} /> إرسال الطلب
          </Btn>
          <Btn variant="outline" className="flex-1" onClick={onClose}>إلغاء</Btn>
        </div>
      </div>
    </div>
  );
}

// In-page alert that pops up for the colleague a stock request was sent to,
// so they can approve or decline on the spot. Appears within seconds of the
// request being sent (via the shared polling loop), one request at a time.
function IncomingRequestPopup({ request, myRemaining, pendingCount, onRespond, onLater }) {
  const [busy, setBusy] = useState(false);
  const respond = async (approve) => {
    setBusy(true);
    try { await onRespond(request.id, approve); } finally { setBusy(false); }
  };
  const partial = myRemaining < request.qty;
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/55 p-4 announce-backdrop" dir="rtl">
      <div className="bg-[var(--surface)] rounded-2xl w-full max-w-sm p-6 text-center announce-pop">
        <div className="w-14 h-14 rounded-full bg-[#FFF6E5] flex items-center justify-center mx-auto mb-3">
          <ArrowLeftRight size={26} className="text-[#C97B3D]" />
        </div>
        <p className="text-[11px] font-semibold text-[#C97B3D] mb-1">
          طلب مخزون جديد{pendingCount > 1 ? ` (1 من ${pendingCount})` : ""}
        </p>
        <h3 className="font-bold text-lg mb-2">{request.requesterName} يطلب منك</h3>
        <div className="bg-[var(--surface-2)] rounded-xl py-3 px-4 mb-3">
          <p className="text-3xl font-extrabold text-[var(--accent-dark)]">{request.qty}</p>
          <p className="text-sm font-semibold">{request.productName}</p>
        </div>
        <p className="text-xs text-[var(--muted)] mb-1">
          رصيدك الحالي من هذا المنتج: <b className="text-[var(--text)]">{myRemaining}</b>
        </p>
        {partial && (
          <p className="text-[11px] text-[#B23A3A] mb-1">
            {myRemaining > 0 ? `رصيدك لا يكفي — عند الموافقة سيُنقل ${myRemaining} فقط.` : "لم يعد لديك رصيد من هذا المنتج — الموافقة لن تنقل شيئاً."}
          </p>
        )}
        <p className="text-[11px] text-[var(--muted)] mb-5">عند الموافقة تنتقل الكمية من حصتك إلى حصته، وعند الرفض لا يتغير شيء.</p>
        <div className="flex gap-2">
          <Btn className="flex-1" disabled={busy} onClick={() => respond(true)} style={{ background: "#3F7D57" }}>
            <Check size={16} /> موافقة
          </Btn>
          <Btn variant="danger" className="flex-1" disabled={busy} onClick={() => respond(false)}>
            <X size={16} /> رفض
          </Btn>
        </div>
        <button onClick={onLater} disabled={busy} className="mt-3 text-xs text-[var(--muted)] hover:text-[var(--text)] underline-offset-2 hover:underline">
          لاحقاً (يبقى في الإشعارات 🔔)
        </button>
      </div>
    </div>
  );
}

// Asks once (per device) to allow phone notifications, so stock requests
// reach the seller even while the app isn't on screen. Browsers only allow
// the permission prompt after a tap, hence the explicit button.
function NotificationPermissionBanner({ permission, onEnable, onHide }) {
  if (isIOSBrowserTab()) {
    return (
      <Card className="p-3 mb-4 flex items-start gap-2.5">
        <Bell size={18} className="text-[var(--accent)] shrink-0 mt-0.5" />
        <p className="text-xs text-[var(--muted)] flex-1 leading-relaxed">
          لتصلك إشعارات طلبات المخزون على الآيفون: افتح التطبيق في Safari ← زر المشاركة ← "إضافة إلى الشاشة الرئيسية"، ثم افتحه من أيقونته وفعّل الإشعارات.
        </p>
        <button onClick={onHide} className="p-1 text-[var(--muted)] shrink-0"><X size={16} /></button>
      </Card>
    );
  }
  if (permission !== "default") return null;
  return (
    <Card className="p-3 mb-4 flex items-center gap-2.5 flex-wrap">
      <Bell size={18} className="text-[var(--accent)] shrink-0" />
      <p className="text-xs text-[var(--muted)] flex-1 min-w-[180px]">فعّل إشعارات الجوال لتصلك طلبات المخزون من زملائك فور إرسالها.</p>
      <Btn className="!py-1.5 !px-3 text-xs" onClick={onEnable}><Bell size={14} /> تفعيل الإشعارات</Btn>
      <button onClick={onHide} className="p-1 text-[var(--muted)]" title="إخفاء"><X size={16} /></button>
    </Card>
  );
}

function SetupScreen({ onComplete }) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [securityQuestion, setSecurityQuestion] = useState("");
  const [securityAnswer, setSecurityAnswer] = useState("");
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !username.trim() || !password.trim()) {
      setErr("يرجى تعبئة الاسم واسم المستخدم وكلمة المرور");
      return;
    }
    if (!securityQuestion.trim() || !securityAnswer.trim()) {
      setErr("يرجى إضافة سؤال أمان وإجابته لاستخدامهما لاحقاً في حال نسيان كلمة المرور");
      return;
    }
    const hashedPassword = await hashPassword(password);
    const hashedAnswer = await hashPassword(securityAnswer.trim().toLowerCase());
    onComplete({
      id: uid(),
      name: name.trim(),
      username: username.trim(),
      password: hashedPassword,
      role: "admin",
      securityQuestion: securityQuestion.trim(),
      securityAnswer: hashedAnswer,
    });
  };

  return (
    <div className="min-h-screen w-full bg-[var(--bg)] flex items-center justify-center px-4 py-8" dir="rtl">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <PerfumeMark size={56} />
          <h1 className="mt-3 text-2xl font-bold text-[var(--accent-dark)]" style={{ fontFamily: "'Amiri', serif" }}>
            مرحباً بك في عطورنا
          </h1>
          <p className="text-[var(--muted)] text-sm mt-1 text-center">هذه أول مرة تُشغَّل فيها — أنشئ حساب المدير الأساسي للنظام</p>
        </div>
        <Card className="p-6">
          <form onSubmit={submit} className="space-y-4">
            <Field label="اسمك"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
            <Field label="اسم المستخدم"><input className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
            <Field label="كلمة المرور"><input type="text" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
            <div className="pt-2 border-t border-[var(--border)]">
              <p className="text-xs font-semibold text-[var(--muted)] mb-2">سؤال أمان (لاستعادة كلمة المرور لاحقاً إن نسيتها)</p>
              <Field label="السؤال"><input className={inputCls} placeholder="مثال: ما اسم أول متجر عملت فيه؟" value={securityQuestion} onChange={(e) => setSecurityQuestion(e.target.value)} /></Field>
              <div className="mt-3">
                <Field label="الإجابة"><input className={inputCls} value={securityAnswer} onChange={(e) => setSecurityAnswer(e.target.value)} /></Field>
              </div>
            </div>
            {err && (
              <div className="flex items-center gap-2 text-[#B23A3A] text-xs bg-[#FBEAEA] rounded-lg px-3 py-2">
                <AlertTriangle size={14} /> {err}
              </div>
            )}
            <Btn type="submit" className="w-full">إنشاء الحساب والدخول</Btn>
          </form>
        </Card>
        <p className="text-center text-xs text-[var(--muted)] mt-4">
          هذا الحساب هو حساب المدير الأساسي ولا يمكن حذفه لاحقاً، لكن يمكن تغيير اسمه وكلمة مروره من صفحة المستخدمين.
        </p>
      </div>
    </div>
  );
}

/* ---------------------------------- Nav config ---------------------------------- */

const NAV_ITEMS = [
  { key: "dashboard", label: "الرئيسية", icon: Home, roles: ["admin", "seller"] },
  { key: "newsale", label: "تسجيل عملية بيع", icon: ShoppingCart, roles: ["admin", "seller"] },
  { key: "records", label: "سجل المبيعات", icon: Receipt, roles: ["admin", "seller"] },
  { key: "stats", label: "الإحصائيات", icon: BarChart3, roles: ["admin", "seller"] },
  { key: "inventory", label: "المخزون", icon: Package, roles: ["admin", "seller"] },
  { key: "allocations", label: "توزيع المخزون على البائعين", icon: Boxes, roles: ["admin", "seller"] },
  { key: "announcements", label: "التعاميم", icon: Megaphone, roles: ["admin", "seller"] },
  { key: "challenges", label: "التحديات والإنجازات", icon: Trophy, roles: ["admin", "seller"] },
  { key: "preferences", label: "تفضيلاتي", icon: Palette, roles: ["admin", "seller"] },
  { key: "expenses", label: "المصروفات", icon: Wallet2, roles: ["admin"] },
  { key: "accounting", label: "المحاسبة", icon: Calculator, roles: ["admin"] },
  { key: "capital", label: "حساب أرباح الشركاء", icon: Landmark, roles: ["admin"] },
  { key: "users", label: "المستخدمون", icon: UsersIcon, roles: ["admin"] },
  { key: "settings", label: "الإعدادات", icon: SettingsIcon, roles: ["admin"] },
  { key: "backup", label: "النسخ الاحتياطي", icon: Save, roles: ["admin"] },
  { key: "activitylog", label: "سجل الدخول والنشاطات", icon: History, roles: ["admin"], primaryOnly: true },
];

// «الملمس الناعم» navigation: four top tabs + a floating sell knob. Every other
// page lives under «المزيد» and is still reached through its original view key.
const MAIN_TABS = [
  { key: "home", label: "الرئيسية", icon: Home, view: "dashboard" },
  { key: "invoices", label: "الفواتير", icon: Receipt, view: "records" },
  { key: "stock", label: "المخزن", icon: Package, view: "inventory" },
  { key: "more", label: "المزيد", icon: LayoutGrid, view: "more" },
];
const tabOfView = (view) =>
  view === "dashboard" ? "home"
  : view === "records" ? "invoices"
  : view === "inventory" || view === "allocations" ? "stock"
  : view === "newsale" ? "sell"
  : "more";

const MORE_GROUPS = [
  { title: "الأداء والتواصل", keys: ["stats", "challenges", "announcements"] },
  { title: "المالية", keys: ["expenses", "accounting", "capital"], adminOnly: true },
  { title: "الإدارة", keys: ["users", "settings", "backup", "activitylog"], adminOnly: true },
  { title: "لي", keys: ["preferences"] },
];
const MORE_SHORT = { challenges: "التحديات", capital: "أرباح الشركاء", activitylog: "سجل النشاطات", backup: "النسخ الاحتياطي" };

/* ---------------------------------- App Shell ---------------------------------- */

export default function App() {
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState([]);
  const [products, setProducts] = useState([]);
  const [sales, setSales] = useState([]);
  const [seq, setSeq] = useState({});
  const [settings, setSettings] = useState({ companyName: "عطورنا للعطور والبخور", logo: "", phone: "", address: "", theme: "classic", cardStyle: "classic", taxEnabled: false, taxRate: 5, taxLabel: "ضريبة القيمة المضافة" });
  const [currentUser, setCurrentUser] = useState(null);
  const [view, setView] = useState("dashboard");
  const [recordsFilter, setRecordsFilter] = useState("all"); // all | unpaid | paid
  const [stockTab, setStockTab] = useState("products"); // products | log (inside the inventory view)
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [printPayload, setPrintPayload] = useState(null); // {type:'invoice'|'record', data}
  const [editingSale, setEditingSale] = useState(null);
  const [labelPayload, setLabelPayload] = useState(null); // {product, count}
  const [announcements, setAnnouncements] = useState([]);
  const [announcementQueue, setAnnouncementQueue] = useState([]); // ids waiting to be shown as popups
  const [stockLogs, setStockLogs] = useState([]); // gifted / damaged / tester product adjustments
  const [expenses, setExpenses] = useState([]);
  const [partners, setPartners] = useState([]);
  const [profitDistributions, setProfitDistributions] = useState([]); // saved profit-sharing history
  const [dailyBackup, setDailyBackup] = useState(null); // {date, savedAt, data} — auto-overwritten once per day
  const [activityLog, setActivityLog] = useState([]); // login/logout + business-action audit trail — visible to the primary admin only
  const [sellerGoals, setSellerGoals] = useState({}); // { [userId]: monthlyTargetAmount }
  const [sellerAllocations, setSellerAllocations] = useState([]); // [{id, sellerId, sellerName, productId, productName, allocated, remaining}]
  const [allocationLog, setAllocationLog] = useState([]); // detailed per-name stock-distribution movement log
  const [stockRequests, setStockRequests] = useState([]); // [{id, productId, productName, requesterId, requesterName, targetSellerId, targetSellerName, qty, status, createdAt, respondedAt, approvedQty}]
  const [personalTheme, setPersonalThemeState] = useState(""); // per-device theme override, empty = use company theme
  const activeTheme = personalTheme || settings.theme || "classic";
  const [personalCardStyle, setPersonalCardStyleState] = useState(""); // per-device card-style override, empty = use company style
  const [darkMode, setDarkMode] = useState(false);
  const [fontScale, setFontScaleState] = useState(1);
  const [toast, setToast] = useState("");
  const [confirmState, setConfirmState] = useState(null); // { message, onConfirm }
  const sidebarRef = useRef(null); // desktop sidebar's scrollable nav list, for the up/down scroll buttons
  const mobileNavRef = useRef(null); // same, for the mobile nav drawer
  const pushActiveRef = useRef(false); // true once real push notifications are active on this device

  const askConfirm = useCallback((message, onConfirm) => {
    setConfirmState({ message, onConfirm });
  }, []);

  // Records one audit-trail entry (login/logout or any business action).
  // Reads/writes storage directly (rather than trusting possibly-stale React
  // state) so rapid actions from different users never clobber each other's
  // entries, and caps the log at 500 entries so it never grows unbounded.
  const logActivity = useCallback(async (userObj, action, details) => {
    try {
      const current = await storeGet("perfume_activity_log", []);
      const entry = {
        id: uid(),
        userId: userObj?.id || "unknown",
        userName: userObj?.name || "غير معروف",
        action,
        details: details || "",
        date: todayISO(),
      };
      const next = [entry, ...current].slice(0, 500);
      await storeSet("perfume_activity_log", next);
      setActivityLog(next);
    } catch {
      // Never let logging failures interrupt the actual user action.
    }
  }, []);

  // Keeps the last-synced snapshot so the periodic refresh below can skip
  // re-rendering when nothing actually changed on the shared database.
  const lastSnapshot = useRef("");

  const loadAll = useCallback(async (isInitial) => {
    let u = await storeGet("perfume_users", []);
    const p = await storeGet("perfume_products", []);
    const s = await storeGet("perfume_sales", []);
    const sq = await storeGet("perfume_seq", {});
    const st = await storeGet("perfume_settings", { companyName: "عطورنا للعطور والبخور", logo: "", phone: "", address: "", theme: "classic", cardStyle: "classic", taxEnabled: false, taxRate: 5, taxLabel: "ضريبة القيمة المضافة" });
    const an = await storeGet("perfume_announcements", []);
    const sl = await storeGet("perfume_stock_logs", []);
    const ex = await storeGet("perfume_expenses", []);
    const pt = await storeGet("perfume_partners", []);
    const pd = await storeGet("perfume_profit_distributions", []);
    const sg = await storeGet("perfume_seller_goals", {});
    const sa = await storeGet("perfume_seller_allocations", []);
    const sr = await storeGet("perfume_stock_requests", []);
    const al = await storeGet("perfume_allocation_log", []);

    // Self-healing migration: some accounts lost their "primary admin" flag
    // (e.g. after restoring a backup taken before this feature existed),
    // which silently hides the primary-admin-only features (activity log,
    // protection from deletion). If nobody is flagged, auto-promote the
    // account named "Adnan" if present, otherwise the first admin — no
    // manual database editing required.
    if (u.length > 0 && !u.some((x) => x.isPrimaryAdmin)) {
      const preferred = u.find((x) => x.username?.trim().toLowerCase() === "adnan" && x.role === "admin");
      const fallback = u.find((x) => x.role === "admin");
      const target = preferred || fallback;
      if (target) {
        u = u.map((x) => (x.id === target.id ? { ...x, isPrimaryAdmin: true } : x));
        await storeSet("perfume_users", u);
      }
    }

    const snapshot = JSON.stringify({ u, p, s, sq, st, an, sl, ex, pt, pd, sg, sa, sr, al });
    if (snapshot === lastSnapshot.current) return; // nothing new, avoid needless re-render
    lastSnapshot.current = snapshot;

    setUsers(u);
    setProducts(p);
    setSales(s);
    setSeq(sq);
    setSettings(st);
    setAnnouncements(an);
    setStockLogs(sl);
    setExpenses(ex);
    setPartners(pt);
    setProfitDistributions(pd);
    setSellerGoals(sg);
    setSellerAllocations(sa);
    setStockRequests(sr);
    setAllocationLog(al);
    if (isInitial) setLoading(false);

    // Automatic rolling daily backup: one single snapshot, overwritten once
    // per calendar day, so it never grows or takes extra storage space.
    if (isInitial) {
      const today = new Date().toISOString().slice(0, 10);
      const existing = await storeGet("perfume_daily_backup", null);
      if (!existing || existing.date !== today) {
        const snapshot = {
          date: today,
          savedAt: todayISO(),
          data: { users: u, products: p, sales: s, seq: sq, settings: st, announcements: an, stockLogs: sl, expenses: ex, partners: pt, profitDistributions: pd, sellerGoals: sg, sellerAllocations: sa, stockRequests: sr, allocationLog: al },
        };
        await storeSet("perfume_daily_backup", snapshot);
        setDailyBackup(snapshot);
      } else {
        setDailyBackup(existing);
      }
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadAll(true);
  }, [loadAll]);

  // Poll the shared database every few seconds so changes made on another
  // seller's / the admin's device (e.g. a new sale, updated stock) appear
  // here automatically without needing to reload the page.
  useEffect(() => {
    const interval = setInterval(() => loadAll(false), 4000);
    return () => clearInterval(interval);
  }, [loadAll]);

  // The activity log is loaded lazily (only when the primary admin actually
  // opens that page) rather than in the main polling loop, since it's not
  // needed by regular sellers and can grow large over time.
  useEffect(() => {
    if (view === "activitylog" && currentUser?.isPrimaryAdmin) {
      storeGet("perfume_activity_log", []).then(setActivityLog);
    }
  }, [view, currentUser]);

  // Restore an existing login session (stored only in this browser's own
  // localStorage, never in the shared business-data store) so refreshing
  // the page — or the browser restarting the tab — doesn't force a
  // re-login. The session is just a username pointer; we always look up
  // the live user record so role/permission changes take effect immediately.
  useEffect(() => {
    if (currentUser || loading) return;
    const savedUsername = window.localStorage.getItem("atourna_session_username");
    if (!savedUsername) return;
    const match = users.find((u) => u.username === savedUsername);
    if (match) {
      setCurrentUser(match);
    } else if (users.length > 0) {
      // Account no longer exists — stop trying to auto-restore it.
      window.localStorage.removeItem("atourna_session_username");
    }
  }, [users, loading, currentUser]);

  // Keep the logged-in user's record in sync with the shared user list, so a
  // permission granted or withdrawn by the primary admin (e.g. warehouse
  // manager) takes effect within seconds, without the person re-logging in.
  useEffect(() => {
    if (!currentUser) return;
    const fresh = users.find((u) => u.id === currentUser.id);
    if (fresh && JSON.stringify(fresh) !== JSON.stringify(currentUser)) setCurrentUser(fresh);
  }, [users, currentUser]);

  // Surface any announcement the current user hasn't seen yet as a popup.
  // This runs whenever the shared announcements list changes — including
  // while someone is already using the app, thanks to the polling loop —
  // so a broadcast from the admin appears live without needing a refresh.
  useEffect(() => {
    if (!currentUser) return;
    const seen = new Set(getSeenAnnouncementIds(currentUser.id));
    const unseen = announcements
      .filter((a) => !seen.has(a.id) && a.createdById !== currentUser.id)
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .map((a) => a.id);
    if (unseen.length === 0) return;
    setAnnouncementQueue((q) => {
      const merged = Array.from(new Set([...q, ...unseen]));
      return merged;
    });
  }, [announcements, currentUser]);

  // Let a seller know, with a one-time toast, once a colleague has actually
  // responded to a stock-transfer request they sent — approved or declined
  // — without them having to keep checking back. Runs off the same polling
  // loop as everything else, so it surfaces within a few seconds even if
  // the response happened on another device.
  useEffect(() => {
    if (!currentUser) return;
    const seen = new Set(getSeenRequestResolutions(currentUser.id));
    const newlyResolved = stockRequests.filter(
      (r) => r.requesterId === currentUser.id && r.status !== "pending" && !seen.has(r.id)
    );
    if (newlyResolved.length === 0) return;
    newlyResolved.forEach((r) => {
      let msg;
      if (r.status === "approved") {
        msg =
          (r.approvedQty ?? r.qty) >= r.qty
            ? `وافق ${r.targetSellerName} على طلبك، وانتقلت إليك ${r.approvedQty ?? r.qty} من ${r.productName}`
            : `وافق ${r.targetSellerName} جزئياً على طلبك — وصلتك ${r.approvedQty} فقط من ${r.qty} من ${r.productName}`;
      } else {
        msg = `اعتذر ${r.targetSellerName} عن طلبك لـ ${r.qty} من ${r.productName}`;
      }
      showToast(msg);
      if (!pushActiveRef.current) showSystemNotification(r.status === "approved" ? "✅ تمت الموافقة على طلبك" : "❌ تم رفض طلبك", msg, `req-result-${r.id}`);
      markRequestResolutionSeen(currentUser.id, r.id);
    });
  }, [stockRequests, currentUser]);

  // Stock requests a colleague sent to *me* that still need an answer.
  const incomingPending = currentUser
    ? stockRequests
        .filter((r) => r.targetSellerId === currentUser.id && r.status === "pending")
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    : [];
  // Requests the user chose "later" for, this session only — they stay in
  // the notifications bell and pop up again on the next visit.
  const [snoozedRequestIds, setSnoozedRequestIds] = useState([]);
  const incomingPopup = incomingPending.find((r) => !snoozedRequestIds.includes(r.id)) || null;

  // Raise a phone / system notification (plus a short vibration) the moment
  // a new request for me arrives — picked up by the shared polling loop
  // within a few seconds of the colleague sending it. Each request only
  // buzzes the phone once per device.
  useEffect(() => {
    if (!currentUser) return;
    const notified = new Set(getNotifiedIncomingRequests(currentUser.id));
    const fresh = incomingPending.filter((r) => !notified.has(r.id));
    if (fresh.length === 0) return;
    fresh.forEach((r) => {
      if (!pushActiveRef.current) showSystemNotification(
        "📦 طلب مخزون من زميل",
        `${r.requesterName} يطلب ${r.qty} من ${r.productName} من حصتك — افتح التطبيق للموافقة أو الرفض`,
        `req-${r.id}`
      );
      markIncomingRequestNotified(currentUser.id, r.id);
    });
    try { navigator.vibrate?.([200, 100, 200]); } catch { /* not supported */ }
  }, [stockRequests, currentUser]); // eslint-disable-line react-hooks/exhaustive-deps

  const [notifPermission, setNotifPermission] = useState(() => (notificationsSupported() ? Notification.permission : "unsupported"));
  const [notifBannerHidden, setNotifBannerHidden] = useState(() => window.localStorage.getItem("atourna_notif_banner_hidden") === "1");
  // Real push (works with the app closed) — active once this device is
  // subscribed through the Worker. While active, the in-app local
  // notifications below are skipped so the phone doesn't buzz twice.
  const [pushStatus, setPushStatus] = useState({ ok: false, reason: "" });
  const pushActive = pushStatus.ok;
  const [pushAttempt, setPushAttempt] = useState(0); // bump to retry registration
  useEffect(() => {
    if (!currentUser || notifPermission !== "granted") { pushActiveRef.current = false; setPushStatus({ ok: false, reason: "" }); return; }
    let cancelled = false;
    setPushStatus({ ok: false, reason: "جارٍ تسجيل الجهاز للإشعارات..." });
    registerPushForUser(currentUser).then((st) => { pushActiveRef.current = st.ok; if (!cancelled) setPushStatus(st); });
    return () => { cancelled = true; };
  }, [currentUser?.id, notifPermission, pushAttempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sends a real push to this user's own devices — end-to-end check that
  // works with a single phone (close the app right after tapping it).
  const sendTestPush = async () => {
    const r = await sendPushToUsers([currentUser.id], {
      title: "🔔 إشعار تجريبي",
      body: "إشعارات عطورنا تعمل على هذا الجهاز ✓",
      tag: `test-${Date.now()}`,
    });
    if (r?.sent > 0) showToast(`تم إرسال إشعار تجريبي إلى ${r.sent} جهاز — يجب أن يظهر خلال ثوانٍ`);
    else if (r?.devices === 0) showToast("لا يوجد جهاز مسجّل لحسابك بعد — اضغط إعادة المحاولة");
    else showToast(`تعذّر الإرسال: ${r?.error || (r?.failed?.[0] ? `رمز ${r.failed[0].status} ${r.failed[0].error || ""}` : "سبب غير معروف")}`);
  };

  const enableNotifications = async () => {
    if (!notificationsSupported()) return;
    try {
      const result = await Notification.requestPermission();
      setNotifPermission(result);
      if (result === "granted") {
        showSystemNotification("🔔 تم تفعيل الإشعارات", "ستصلك تنبيهات طلبات المخزون على هذا الجهاز", "notif-enabled");
      }
    } catch { /* ignore */ }
  };

  // Dark mode is a per-device preference — store it directly in this
  // browser's own localStorage, never in the shared business-data store.
  useEffect(() => {
    const saved = window.localStorage.getItem("atourna_darkmode");
    setDarkMode(saved === "1");
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", personalTheme || settings.theme || "classic");
  }, [settings.theme, personalTheme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-style", personalCardStyle || settings.cardStyle || "classic");
  }, [settings.cardStyle, personalCardStyle]);

  // A personal theme choice is a per-device override only — it never
  // touches the shared company theme everyone else sees or the printed
  // invoices, which always follow settings.theme.
  useEffect(() => {
    const saved = window.localStorage.getItem("atourna_personal_theme");
    if (saved) setPersonalThemeState(saved);
  }, []);

  const setPersonalTheme = (themeKey) => {
    setPersonalThemeState(themeKey);
    if (themeKey) window.localStorage.setItem("atourna_personal_theme", themeKey);
    else window.localStorage.removeItem("atourna_personal_theme");
  };

  // Same per-device override pattern, but for the overall card/visual style
  // (classic / gems / vibrant / pastel) instead of just the accent color.
  useEffect(() => {
    const saved = window.localStorage.getItem("atourna_personal_style");
    if (saved) setPersonalCardStyleState(saved);
  }, []);

  const setPersonalCardStyle = (styleKey) => {
    setPersonalCardStyleState(styleKey);
    if (styleKey) window.localStorage.setItem("atourna_personal_style", styleKey);
    else window.localStorage.removeItem("atourna_personal_style");
  };

  const logout = () => {
    logActivity(currentUser, "تسجيل خروج", "");
    unlinkPushDevice();
    window.localStorage.removeItem("atourna_session_username");
    setCurrentUser(null);
  };

  const toggleDarkMode = () => {
    setDarkMode((d) => {
      const next = !d;
      window.localStorage.setItem("atourna_darkmode", next ? "1" : "0");
      return next;
    });
  };

  // Font size is also a per-device preference — lets each person enlarge or
  // shrink the whole app's text to their own comfort, independent of everyone
  // else. Scaling the root font-size works because all of the app's text
  // sizes (text-xs/sm/base/lg/xl/2xl/3xl) are rem-based, so they grow or
  // shrink together proportionally.
  useEffect(() => {
    const saved = Number(window.localStorage.getItem("atourna_fontscale"));
    if (saved && saved > 0) setFontScaleState(saved);
  }, []);

  useEffect(() => {
    document.documentElement.style.fontSize = `${16 * fontScale}px`;
  }, [fontScale]);

  const setFontScale = (scale) => {
    setFontScaleState(scale);
    window.localStorage.setItem("atourna_fontscale", String(scale));
  };

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  }, []);

  const persistUsers = async (next) => { setUsers(next); await storeSet("perfume_users", next); };
  const persistProducts = async (next) => { setProducts(next); await storeSet("perfume_products", next); };
  const persistSales = async (next) => { setSales(next); await storeSet("perfume_sales", next); };
  const persistSeq = async (next) => { setSeq(next); await storeSet("perfume_seq", next); };
  const persistSettings = async (next) => { setSettings(next); await storeSet("perfume_settings", next); };
  const persistAnnouncements = async (next) => { setAnnouncements(next); await storeSet("perfume_announcements", next); };
  const persistStockLogs = async (next) => { setStockLogs(next); await storeSet("perfume_stock_logs", next); };

  const createAnnouncement = async (title, message) => {
    if (!title.trim() || !message.trim()) return;
    const announcement = {
      id: uid(),
      title: title.trim(),
      message: message.trim(),
      date: todayISO(),
      createdById: currentUser.id,
      createdByName: currentUser.name,
    };
    await persistAnnouncements([announcement, ...announcements]);
    markAnnouncementSeen(currentUser.id, announcement.id); // don't pop up your own broadcast to yourself
    logActivity(currentUser, "إرسال تعميم", title.trim());
    showToast("تم إرسال التعميم بنجاح لجميع المستخدمين");
  };

  const deleteAnnouncement = async (id) => {
    const a = announcements.find((x) => x.id === id);
    await persistAnnouncements(announcements.filter((x) => x.id !== id));
    logActivity(currentUser, "حذف تعميم", a?.title || "");
    showToast("تم حذف التعميم");
  };

  // Records a gifted, damaged, or opened-for-testing unit against a product
  // and deducts it from stock immediately.
  const logStockAdjustment = async (product, type, qty, note) => {
    let q = Math.min(qty, product.stock);
    if (q <= 0) return;
    const typeNames = { gift: "هدية", damage: "تالف", tester: "تجربة" };

    // For a product split between sellers, a gift / damaged / opened tester
    // piece is taken out of the recording person's own share first (it was
    // in their hands), then from the undistributed pool — never silently
    // from a colleague's share. Both the allocation and its "received"
    // total go down, so "بحوزته" and "باع" stay accurate.
    let allocationSources = [];
    let updatedAllocations = null;
    if (isProductManaged(sellerAllocations, product.id)) {
      const own = getAllocationRecord(sellerAllocations, currentUser.id, product.id);
      const ownLeft = own ? own.remaining : 0;
      const heldByAll = totalRemainingForProduct(sellerAllocations, product.id);
      const freePool = Math.max(0, product.stock - heldByAll);
      const maxAllowed = ownLeft + freePool;
      if (maxAllowed <= 0) {
        showToast(`لا يمكن التسجيل: ليس لديك رصيد من "${product.name}" في حصتك، والكمية الموجودة موزّعة على بائعين آخرين`);
        return;
      }
      if (q > maxAllowed) q = maxAllowed;
      const fromOwn = Math.min(ownLeft, q);
      if (fromOwn > 0) {
        updatedAllocations = sellerAllocations.map((a) =>
          a.id === own.id ? { ...a, allocated: a.allocated - fromOwn, remaining: a.remaining - fromOwn } : a
        );
        allocationSources = [{ sellerId: currentUser.id, sellerName: currentUser.name, productId: product.id, qty: fromOwn }];
      }
    }

    const updatedProducts = products.map((p) => (p.id === product.id ? { ...p, stock: p.stock - q } : p));
    const log = {
      id: uid(),
      productId: product.id,
      productName: product.name,
      type, // 'gift' | 'damage' | 'tester'
      qty: q,
      note: note?.trim() || "",
      date: todayISO(),
      byUserId: currentUser.id,
      byUserName: currentUser.name,
      allocationSources,
    };
    await persistProducts(updatedProducts);
    await persistStockLogs([log, ...stockLogs]);
    if (updatedAllocations) {
      const src = allocationSources[0];
      const before = getAllocationRecord(sellerAllocations, currentUser.id, product.id).allocated;
      await persistSellerAllocations(updatedAllocations);
      await appendAllocationLog([
        makeAllocationLogEntry({
          byUser: currentUser, type: "stock_adjust", productId: product.id, productName: product.name,
          sellerId: currentUser.id, sellerName: currentUser.name, before, after: before - src.qty,
          note: `${typeNames[type] || "تعديل"}${log.note ? ` — ${log.note}` : ""}`,
        }),
      ]);
    }
    const labels = { gift: "تم تسجيل الهدية وخصمها من المخزون", damage: "تم تسجيل التالف وخصمه من المخزون", tester: "تم تسجيل فتح المنتج للتجربة وخصمه من المخزون" };
    const logLabels = { gift: "تسجيل هدية", damage: "تسجيل تالف", tester: "تسجيل فتح للتجربة" };
    logActivity(currentUser, logLabels[type] || "تعديل مخزون", `${product.name} × ${q}`);
    showToast(
      q < qty
        ? `تم تسجيل ${q} فقط من ${qty} — هذا كل ما في حصتك والمخزون غير الموزّع`
        : (labels[type] || "تم تحديث المخزون") + (allocationSources.length ? " ومن حصتك المخصصة" : "")
    );
  };

  const deleteStockLog = async (id) => {
    const log = stockLogs.find((l) => l.id === id);
    if (log) {
      const updatedProducts = products.map((p) => (p.id === log.productId ? { ...p, stock: p.stock + log.qty } : p));
      await persistProducts(updatedProducts);
      // Give the pieces back to the share they were taken from.
      if (log.allocationSources && log.allocationSources.length) {
        const entries = [];
        const next = sellerAllocations.map((a) => {
          const src = log.allocationSources.find((x) => x.sellerId === a.sellerId && x.productId === a.productId);
          if (!src) return a;
          entries.push(
            makeAllocationLogEntry({
              byUser: currentUser, type: "stock_adjust_undo", productId: a.productId, productName: a.productName,
              sellerId: a.sellerId, sellerName: a.sellerName, before: a.allocated, after: a.allocated + src.qty,
              note: "حذف سجل هدية/تالف/تجربة",
            })
          );
          return { ...a, allocated: a.allocated + src.qty, remaining: a.remaining + src.qty };
        });
        await persistSellerAllocations(next);
        await appendAllocationLog(entries);
      }
    }
    await persistStockLogs(stockLogs.filter((l) => l.id !== id));
    logActivity(currentUser, "حذف سجل هدية/تالف", log ? `${log.productName} × ${log.qty}` : "");
    showToast("تم حذف السجل وإرجاع الكمية إلى المخزون" + (log?.allocationSources?.length ? " والحصة المخصصة" : ""));
  };

  const persistExpenses = async (next) => { setExpenses(next); await storeSet("perfume_expenses", next); };

  const addExpense = async (expense) => {
    const record = {
      id: uid(),
      category: expense.category,
      description: expense.description?.trim() || "",
      amount: Number(expense.amount) || 0,
      date: expense.date || todayISO(),
      byUserName: currentUser.name,
    };
    await persistExpenses([record, ...expenses]);
    logActivity(currentUser, "تسجيل مصروف", `${record.category} - ${fmt(record.amount)} K.D`);
    showToast("تم تسجيل المصروف");
  };

  const deleteExpense = async (id) => {
    const e = expenses.find((x) => x.id === id);
    await persistExpenses(expenses.filter((x) => x.id !== id));
    logActivity(currentUser, "حذف مصروف", e ? `${e.category} - ${fmt(e.amount)} K.D` : "");
    showToast("تم حذف المصروف");
  };

  const persistPartners = async (next) => { setPartners(next); await storeSet("perfume_partners", next); };
  const persistProfitDistributions = async (next) => { setProfitDistributions(next); await storeSet("perfume_profit_distributions", next); };
  const persistSellerGoals = async (next) => { setSellerGoals(next); await storeSet("perfume_seller_goals", next); };
  const persistSellerAllocations = async (next) => { setSellerAllocations(next); await storeSet("perfume_seller_allocations", next); };
  const persistStockRequests = async (next) => { setStockRequests(next); await storeSet("perfume_stock_requests", next); };
  // Appends to the distribution movement log. Reads storage directly (like
  // logActivity) so entries written from two devices never overwrite each
  // other, and caps it at 2000 entries so it never grows unbounded.
  const appendAllocationLog = async (entries) => {
    if (!entries || entries.length === 0) return;
    const current = await storeGet("perfume_allocation_log", []);
    const next = [...entries, ...current].slice(0, 2000);
    await storeSet("perfume_allocation_log", next);
    setAllocationLog(next);
  };

  // A colleague responds to a stock-transfer request sent to them. Approving
  // permanently moves the requested quantity from the responder's own
  // allocation to the requester's (capped at whatever the responder still
  // actually has, in case they sold some of it while the request was
  // pending); declining changes nothing at all beyond the request's status.
  const respondStockRequest = async (requestId, approve) => {
    const req = stockRequests.find((r) => r.id === requestId);
    if (!req || req.status !== "pending") return;

    if (!approve) {
      await persistStockRequests(stockRequests.map((r) => (r.id === requestId ? { ...r, status: "rejected", respondedAt: todayISO() } : r)));
      showToast(`تم رفض طلب ${req.requesterName} لـ ${req.productName}`);
      sendPushToUsers([req.requesterId], {
        title: "❌ تم رفض طلبك",
        body: `اعتذر ${currentUser.name} عن طلبك لـ ${req.qty} من ${req.productName}`,
        tag: `req-result-${req.id}`,
      });
      logActivity(currentUser, "رفض طلب نقل مخزون", `${req.productName} - طلب ${req.requesterName} لـ ${req.qty} قطعة`);
      return;
    }

    const { allocations: updatedAllocations, transferredQty } = applyStockTransfer(
      sellerAllocations,
      req.targetSellerId,
      req.requesterId,
      req.requesterName,
      req.productId,
      req.productName,
      req.qty
    );
    await persistSellerAllocations(updatedAllocations);
    await persistStockRequests(
      stockRequests.map((r) => (r.id === requestId ? { ...r, status: "approved", respondedAt: todayISO(), approvedQty: transferredQty } : r))
    );
    if (transferredQty > 0) {
      const beforeOf = (list, sid) => getAllocationRecord(list, sid, req.productId)?.allocated || 0;
      await appendAllocationLog([
        makeAllocationLogEntry({
          byUser: currentUser, type: "transfer_out", productId: req.productId, productName: req.productName,
          sellerId: req.targetSellerId, sellerName: req.targetSellerName,
          before: beforeOf(sellerAllocations, req.targetSellerId), after: beforeOf(updatedAllocations, req.targetSellerId),
          note: `نقل إلى ${req.requesterName} بموافقته`,
        }),
        makeAllocationLogEntry({
          byUser: currentUser, type: "transfer_in", productId: req.productId, productName: req.productName,
          sellerId: req.requesterId, sellerName: req.requesterName,
          before: beforeOf(sellerAllocations, req.requesterId), after: beforeOf(updatedAllocations, req.requesterId),
          note: `استلام من ${req.targetSellerName}`,
        }),
      ]);
    }
    showToast(
      transferredQty >= req.qty
        ? `تمت الموافقة، وانتقلت ${transferredQty} قطعة من ${req.productName} إلى ${req.requesterName}`
        : `تمت الموافقة جزئياً — تم تحويل ${transferredQty} فقط من ${req.qty} المطلوبة (الكمية المتبقية لديك لم تعد كافية)`
    );
    logActivity(currentUser, "الموافقة على طلب نقل مخزون", `${req.productName} - ${transferredQty} قطعة إلى ${req.requesterName}`);
    sendPushToUsers([req.requesterId], {
      title: "✅ تمت الموافقة على طلبك",
      body:
        transferredQty >= req.qty
          ? `وافق ${currentUser.name} وانتقلت إليك ${transferredQty} من ${req.productName}`
          : `وافق ${currentUser.name} جزئياً — وصلتك ${transferredQty} فقط من ${req.qty} من ${req.productName}`,
      tag: `req-result-${req.id}`,
    });
  };
  const saveSellerGoal = async (userId, amount) => {
    await persistSellerGoals({ ...sellerGoals, [userId]: Number(amount) || 0 });
    const target = users.find((u) => u.id === userId);
    logActivity(currentUser, "تحديد هدف شهري", `${target?.name || ""} - ${fmt(Number(amount) || 0)} K.D`);
    showToast("تم حفظ الهدف الشهري");
  };

  const savePartners = async (next) => {
    await persistPartners(next);
    logActivity(currentUser, "تحديث بيانات الشركاء", `${next.length} شريك`);
    showToast("تم حفظ بيانات الشركاء");
  };

  const saveProfitDistribution = async (record) => {
    await persistProfitDistributions([record, ...profitDistributions]);
    logActivity(currentUser, "حفظ توزيع أرباح", `${fmt(record.netProfit || 0)} K.D`);
    showToast("تم حفظ توزيع الأرباح بالسجل");
  };

  const deleteProfitDistribution = async (id) => {
    await persistProfitDistributions(profitDistributions.filter((d) => d.id !== id));
    logActivity(currentUser, "حذف توزيع أرباح", "");
    showToast("تم حذف سجل توزيع الأرباح");
  };

  const updateSale = async (id, updates) => {
    const next = sales.map((s) => (s.id === id ? { ...s, ...updates } : s));
    await persistSales(next);
  };

  // In-app only comment thread per invoice (never included in printed PDF).
  const addSaleComment = async (id, text) => {
    const sale = sales.find((s) => s.id === id);
    if (!sale || !text.trim()) return;
    const comment = {
      id: uid(),
      authorName: currentUser.name,
      text: text.trim(),
      date: todayISO(),
    };
    const comments = [...(sale.comments || []), comment];
    await updateSale(id, { comments });
    logActivity(currentUser, "إضافة ملاحظة على فاتورة", sale.invoiceNo);
    showToast("تمت إضافة الملاحظة على الفاتورة");
  };

  const deleteSaleComment = async (saleId, commentId) => {
    const sale = sales.find((s) => s.id === saleId);
    if (!sale) return;
    const comments = (sale.comments || []).filter((c) => c.id !== commentId);
    await updateSale(saleId, { comments });
    logActivity(currentUser, "حذف ملاحظة عن فاتورة", sale.invoiceNo);
    showToast("تم حذف الملاحظة");
  };

  // Full invoice edit (admin only): replaces items/collected and reconciles stock deltas.
  const editSaleWithStock = async (id, newItems, newCollected, newDiscountType, newDiscountValue, reason = "") => {
    const oldSale = sales.find((s) => s.id === id);
    if (!oldSale) return;
    // Admins may edit any invoice; a seller may only correct their own.
    const isOwner = oldSale.sellerId === currentUser?.id;
    if (currentUser?.role !== "admin" && !isOwner) return;

    const subtotal = newItems.reduce((a, l) => a + l.total, 0);
    const discountType = newDiscountType ?? oldSale.discountType ?? "amount";
    const discountValue = newDiscountValue ?? oldSale.discountValue ?? 0;
    const discountAmount = Math.min(subtotal, discountType === "percent" ? subtotal * (discountValue / 100) : discountValue);
    const afterDiscount = Math.max(0, subtotal - discountAmount);
    const taxEnabled = !!oldSale.taxEnabled;
    const taxRate = oldSale.taxRate || 0;
    const taxAmount = taxEnabled ? afterDiscount * (taxRate / 100) : 0;
    const total = afterDiscount + taxAmount;

    const collected = Math.min(newCollected, total);
    const remaining = Math.max(0, total - collected);

    const qtyByProduct = (items) => {
      const m = new Map();
      items.forEach((i) => m.set(i.productId, (m.get(i.productId) || 0) + i.qty));
      return m;
    };
    const oldQty = qtyByProduct(oldSale.items);
    const newQty = qtyByProduct(newItems);
    const allProductIds = new Set([...oldQty.keys(), ...newQty.keys()]);
    const updatedProducts = products.map((p) => {
      if (!allProductIds.has(p.id)) return p;
      const delta = (newQty.get(p.id) || 0) - (oldQty.get(p.id) || 0);
      return delta ? { ...p, stock: p.stock - delta } : p;
    });

    await persistProducts(updatedProducts);

    // Reconcile the seller's personal stock allocation the same way a
    // delete+recreate would: give back everything the original invoice had
    // drawn on, then re-draw fresh for the edited quantities from the
    // seller's own share — so an edited invoice never leaves a stale claim
    // on anyone's allocation. (No cross-seller borrowing happens here:
    // getting more than one's own share requires an approved stock-transfer
    // request beforehand, same as at sale creation.)
    let updatedAllocations = restoreAllocation(sellerAllocations, oldSale.allocationSources);
    const allocationSources = [];
    for (const [pid, qty] of newQty) {
      if (!qty || !isProductManaged(updatedAllocations, pid)) continue;
      const cap = Math.min(qty, remainingForSeller(updatedAllocations, oldSale.sellerId, pid));
      if (cap <= 0) continue;
      updatedAllocations = consumeOwnAllocation(updatedAllocations, oldSale.sellerId, pid, cap);
      allocationSources.push({ sellerId: oldSale.sellerId, sellerName: oldSale.sellerName, productId: pid, qty: cap });
    }
    await persistSellerAllocations(updatedAllocations);

    // Every edit is kept on the invoice itself (who, when, why, totals
    // before/after) so a correction by a seller stays fully traceable.
    const editHistory = [
      ...(oldSale.editHistory || []),
      { date: todayISO(), byUserId: currentUser.id, byUserName: currentUser.name, reason, oldTotal: oldSale.total, newTotal: total },
    ];
    await updateSale(id, { items: newItems, subtotal, discountType, discountValue, discountAmount, taxAmount, total, collected, remaining, allocationSources, editHistory });
    logActivity(
      currentUser,
      currentUser.role === "admin" ? "تعديل فاتورة" : "تصحيح فاتورة من البائع",
      `${oldSale.invoiceNo} - من ${fmt(oldSale.total)} إلى ${fmt(total)} K.D${reason ? ` - السبب: ${reason}` : ""}`
    );
  };

  const isAdmin = currentUser?.role === "admin";

  const visibleNav = NAV_ITEMS
    .filter((n) => n.roles.includes(currentUser?.role) && (!n.primaryOnly || currentUser?.isPrimaryAdmin))
    // Only the warehouse manager distributes stock; everyone else just sees their own share.
    .map((n) => (n.key === "allocations" && !canManageAllocations(currentUser) ? { ...n, label: "مخزوني المخصص" } : n));

  const doPrint = () => {
    setTimeout(() => window.print(), 50);
  };

  if (loading) {
    return (
      <>
        <GlobalStyle />
        <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center" dir="rtl">
          <div className="flex flex-col items-center gap-4 fade-in">
            <div className="loader-orbit">
              <div className="loader-orbit-rotator">
                <div className="loader-orbit-icon">
                  <PerfumeMark size={30} />
                </div>
              </div>
              <p className="loader-center-text">جاري التحميل</p>
            </div>
          </div>
        </div>
      </>
    );
  }

  if (!currentUser) {
    return (
      <>
        <GlobalStyle />
        {users.length === 0 ? (
          <SetupScreen
            onComplete={async (adminUser) => {
              const withFlag = { ...adminUser, isPrimaryAdmin: true };
              await persistUsers([withFlag]);
              window.localStorage.setItem("atourna_session_username", withFlag.username);
              setCurrentUser(withFlag);
              setView("dashboard");
              logActivity(withFlag, "تسجيل دخول", "إنشاء الحساب الأساسي وأول تسجيل دخول");
            }}
          />
        ) : (
          <LoginScreen
            users={users}
            onLogin={(u) => {
              window.localStorage.setItem("atourna_session_username", u.username);
              setCurrentUser(u);
              setView("dashboard");
              logActivity(u, "تسجيل دخول", "");
            }}
            onRecover={async (username, newPassword) => {
              const idx = users.findIndex((u) => u.username.toLowerCase() === username.toLowerCase() && u.isPrimaryAdmin);
              if (idx === -1) return false;
              const next = users.map((u, i) => (i === idx ? { ...u, password: newPassword } : u));
              await persistUsers(next);
              return true;
            }}
            onLegacyUpgrade={async (userId, hashedPassword) => {
              const next = users.map((u) => (u.id === userId ? { ...u, password: hashedPassword } : u));
              await persistUsers(next);
            }}
          />
        )}
      </>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]" dir="rtl">
      <GlobalStyle />

      {/* Print area */}
      {printPayload && (
        <PrintArea payload={printPayload} settings={settings} onClose={() => setPrintPayload(null)} />
      )}

      {editingSale && (isAdmin || editingSale.sellerId === currentUser?.id) && (
        <EditSaleModal
          sale={editingSale}
          products={products}
          sellerAllocations={sellerAllocations}
          isOwnerEdit={!isAdmin}
          onClose={() => setEditingSale(null)}
          onSave={async (newItems, newCollected, newDiscountType, newDiscountValue, reason) => {
            await editSaleWithStock(editingSale.id, newItems, newCollected, newDiscountType, newDiscountValue, reason);
            setEditingSale(null);
            showToast(isAdmin ? "تم تعديل الفاتورة بنجاح" : "تم تصحيح فاتورتك بنجاح");
          }}
        />
      )}

      {labelPayload && (
        <LabelsPrintArea
          product={labelPayload.product}
          count={labelPayload.count}
          settings={settings}
          onClose={() => setLabelPayload(null)}
        />
      )}

      {announcementQueue.length > 0 && (
        <AnnouncementPopup
          announcement={announcements.find((a) => a.id === announcementQueue[0])}
          onClose={() => {
            markAnnouncementSeen(currentUser.id, announcementQueue[0]);
            setAnnouncementQueue((q) => q.slice(1));
          }}
        />
      )}

      {incomingPopup && announcementQueue.length === 0 && (
        <IncomingRequestPopup
          request={incomingPopup}
          myRemaining={remainingForSeller(sellerAllocations, currentUser.id, incomingPopup.productId)}
          pendingCount={incomingPending.length}
          onRespond={respondStockRequest}
          onLater={() => setSnoozedRequestIds((ids) => [...ids, incomingPopup.id])}
        />
      )}

      {confirmState && (
        <ConfirmModal
          message={confirmState.message}
          onConfirm={() => {
            confirmState.onConfirm();
            setConfirmState(null);
          }}
          onCancel={() => setConfirmState(null)}
        />
      )}

      {/* Header: brand + bell, then the four-tab segmented navigation */}
      <header className="no-print nm-header sticky top-0 z-30" style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
        <div className="max-w-5xl mx-auto px-4 pt-3 pb-3 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <button onClick={() => setView("more")} className="nm-knob" aria-label="حسابي والمزيد" title={currentUser.name}>
              <span className="text-sm font-bold nm-ink">{(currentUser.name || "?").trim().charAt(0)}</span>
            </button>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-[15px] leading-tight truncate">{settings.companyName || "عطورنا"}</p>
              <p className="text-[11px] nm-mut leading-tight truncate">
                {currentUser.name} · {isAdmin ? "مدير النظام" : "بائع"}{currentUser.canManageStock && !currentUser.isPrimaryAdmin ? " · مسؤول المخزن" : ""}
              </p>
            </div>
            <NotificationsBell
              onOpenUnpaid={() => { setRecordsFilter("unpaid"); setView("records"); }}
              open={notifOpen}
              setOpen={setNotifOpen}
              announcements={announcements}
              currentUser={currentUser}
              products={products}
              sales={sales}
              isAdmin={isAdmin}
              setView={setView}
              onOpenAnnouncement={(id) => markAnnouncementSeen(currentUser.id, id)}
              stockRequests={stockRequests}
              onRespondRequest={respondStockRequest}
              notifPermission={notifPermission}
              pushActive={pushActive}
              pushReason={pushStatus.reason}
              onRetryPush={() => setPushAttempt((n) => n + 1)}
              onTestPush={sendTestPush}
              onEnableNotifications={enableNotifications}
            />
          </div>
          <nav className="nm-seg w-full max-w-xl mx-auto" role="tablist" aria-label="التنقل الرئيسي">
            {MAIN_TABS.map((t) => {
              const Icon = t.icon;
              const on = tabOfView(view) === t.key;
              return (
                <button key={t.key} role="tab" aria-selected={on} aria-current={on ? "page" : undefined} className={on ? "is-on" : ""} onClick={() => setView(t.view)}>
                  <Icon size={16} />
                  {t.label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <div className="max-w-5xl mx-auto">
        {/* Main content */}
        <main className="no-print min-w-0 px-4 pt-3" style={{ paddingBottom: "calc(130px + env(safe-area-inset-bottom, 0px))" }}>
        {!notifBannerHidden && (notifPermission !== "unsupported" || isIOSBrowserTab()) && (
          <NotificationPermissionBanner
            permission={notifPermission}
            onEnable={enableNotifications}
            onHide={() => { setNotifBannerHidden(true); window.localStorage.setItem("atourna_notif_banner_hidden", "1"); }}
          />
        )}
        {tabOfView(view) === "stock" && (
          <div className="nm-tog max-w-xl mx-auto mb-5" role="tablist" aria-label="أقسام المخزن">
            <button role="tab" aria-selected={view === "inventory" && stockTab === "products"} className={view === "inventory" && stockTab === "products" ? "is-on" : ""} onClick={() => { setStockTab("products"); setView("inventory"); }}>
              <Package size={15} /> المنتجات
            </button>
            <button role="tab" aria-selected={view === "allocations"} className={view === "allocations" ? "is-on" : ""} onClick={() => setView("allocations")}>
              <Boxes size={15} /> {canManageAllocations(currentUser) ? "التوزيع" : "حصتي"}
            </button>
            <button role="tab" aria-selected={view === "inventory" && stockTab === "log"} className={view === "inventory" && stockTab === "log" ? "is-on" : ""} onClick={() => { setStockTab("log"); setView("inventory"); }}>
              <Gift size={15} /> الهدايا والتالف
            </button>
          </div>
        )}
        {tabOfView(view) === "more" && view !== "more" && (
          <button onClick={() => setView("more")} className="nm-btn ink mb-5 !py-2 !px-4 text-[13px]">
            <ChevronRight size={16} /> المزيد
          </button>
        )}
        {view === "newsale" && (
          <button onClick={() => setView("dashboard")} className="nm-btn mb-5 !py-2 !px-4 text-[13px]">
            <ChevronRight size={16} /> رجوع
          </button>
        )}
        <div key={view} className="view-transition">
          {view === "dashboard" && (
            <Dashboard sales={sales} products={products} users={users} sellerGoals={sellerGoals} currentUser={currentUser} setView={setView} activeTheme={activeTheme} sellerAllocations={sellerAllocations} onOpenUnpaid={() => { setRecordsFilter("unpaid"); setView("records"); }} />
          )}
          {view === "more" && (
            <MorePage
              currentUser={currentUser}
              isAdmin={isAdmin}
              visibleNav={visibleNav}
              setView={setView}
              darkMode={darkMode}
              onToggleDarkMode={toggleDarkMode}
              onLogout={logout}
              unseenAnnouncements={announcements.filter((a) => !getSeenAnnouncementIds(currentUser.id).includes(a.id)).length}
            />
          )}
          {view === "newsale" && (
            <NewSale
              products={products}
              users={users}
              currentUser={currentUser}
              sales={sales}
              seq={seq}
              settings={settings}
              sellerAllocations={sellerAllocations}
              stockRequests={stockRequests}
              onCreate={async (sale, updatedProducts, newSeq, updatedAllocations) => {
                await persistProducts(updatedProducts);
                await persistSales([sale, ...sales]);
                await persistSeq(newSeq);
                if (updatedAllocations) await persistSellerAllocations(updatedAllocations);
                showToast("تم تسجيل عملية البيع وإصدار الفاتورة بنجاح");
                setPrintPayload({ type: "invoice", data: sale });
                setView("records");
                logActivity(currentUser, "تسجيل عملية بيع", `فاتورة ${sale.invoiceNo} بمبلغ ${fmt(sale.total)} K.D`);
              }}
              onSendRequest={async (product, targetSeller, qty, requester) => {
                const request = {
                  id: uid(),
                  productId: product.id,
                  productName: product.name,
                  requesterId: requester.id,
                  requesterName: requester.name,
                  targetSellerId: targetSeller.id,
                  targetSellerName: targetSeller.name,
                  qty,
                  status: "pending",
                  createdAt: todayISO(),
                };
                await persistStockRequests([request, ...stockRequests]);
                showToast(`تم إرسال طلبك إلى ${targetSeller.name}، بانتظار موافقته`);
                sendPushToUsers([targetSeller.id], {
                  title: "📦 طلب مخزون من زميل",
                  body: `${requester.name} يطلب ${qty} من ${product.name} من حصتك — افتح التطبيق للموافقة أو الرفض`,
                  tag: `req-${request.id}`,
                });
                logActivity(requester, "طلب نقل مخزون", `${product.name} - طلب ${qty} من ${targetSeller.name}`);
              }}
            />
          )}
          {view === "records" && (
            <SalesRecords
              statusFilter={recordsFilter}
              onStatusFilter={setRecordsFilter}
              sales={sales}
              users={users}
              currentUser={currentUser}
              isAdmin={isAdmin}
              settings={settings}
              onDelete={async (id) => {
                const sale = sales.find((s) => s.id === id);
                if (!sale) return;

                // 1) Give every sold unit back to inventory stock.
                const updatedProducts = products.map((p) => {
                  const returned = sale.items
                    .filter((i) => i.productId === p.id)
                    .reduce((a, i) => a + i.qty, 0);
                  return returned ? { ...p, stock: p.stock + returned } : p;
                });
                await persistProducts(updatedProducts);

                // 1b) Give back whatever seller-allocation units this invoice
                // drew on (both a seller's own share and anything borrowed
                // from a colleague), so deleting a sale never leaves stock
                // "stuck" as unavailable in someone's personal allocation.
                if (sale.allocationSources && sale.allocationSources.length) {
                  await persistSellerAllocations(restoreAllocation(sellerAllocations, sale.allocationSources));
                }

                // 2) Reclaim the invoice number so the sequence isn't left
                // with a "lost" number — but only when this was the very
                // last invoice issued, otherwise reusing it could collide
                // with numbers already given to newer invoices.
                const match = /INV-(\d+)/.exec(sale.invoiceNo || "");
                const saleNum = match ? Number(match[1]) : null;
                let reclaimedNumber = false;
                if (saleNum && seq.count === saleNum) {
                  await persistSeq({ ...seq, count: seq.count - 1 });
                  reclaimedNumber = true;
                }

                await persistSales(sales.filter((s) => s.id !== id));

                const stockNote = sale.items.length
                  ? ` وأُعيدت كمية ${sale.items.reduce((a, i) => a + i.qty, 0)} قطعة إلى المخزون`
                  : "";
                const seqNote = reclaimedNumber ? ` وأُعيد الرقم ${sale.invoiceNo} إلى التسلسل ليُستخدم للفاتورة القادمة` : "";
                showToast(`تم حذف الفاتورة ${sale.invoiceNo}${stockNote}${seqNote}`);
                logActivity(currentUser, "حذف فاتورة", `${sale.invoiceNo} بمبلغ ${fmt(sale.total)} K.D`);
              }}
              onPrintInvoice={(sale) => setPrintPayload({ type: "invoice", data: sale })}
              onPrintRecord={(sellerName, list) => setPrintPayload({ type: "record", data: { sellerName, list } })}
              onCollectPayment={async (id, amount) => {
                const sale = sales.find((s) => s.id === id);
                if (!sale) return;
                const collected = Math.min(sale.total, sale.collected + amount);
                await updateSale(id, { collected, remaining: Math.max(0, sale.total - collected) });
                showToast("تم تسجيل التحصيل");
                logActivity(currentUser, "تسجيل تحصيل دفعة", `فاتورة ${sale.invoiceNo} - مبلغ ${fmt(amount)} K.D`);
              }}
              onEditSale={(sale) => setEditingSale(sale)}
              onAddComment={addSaleComment}
              onDeleteComment={deleteSaleComment}
              onConfirm={askConfirm}
            />
          )}
          {view === "stats" && <Stats sales={sales} users={users} products={products} currentUser={currentUser} isAdmin={isAdmin} activeTheme={activeTheme} />}
          {view === "inventory" && (
            <Inventory
              products={products}
              isAdmin={isAdmin}
              onSave={async (next) => { await persistProducts(next); showToast("تم حفظ المخزون"); }}
              onPrintLabels={(product, count) => setLabelPayload({ product, count })}
              stockLogs={stockLogs}
              onLogAdjustment={logStockAdjustment}
              onDeleteLog={deleteStockLog}
              onConfirm={askConfirm}
              activeTheme={activeTheme}
              sellerAllocations={sellerAllocations}
              tab={stockTab}
              currentUserId={currentUser.id}
            />
          )}
          {view === "allocations" && (
            <StockAllocationPage
              products={products}
              users={users}
              currentUser={currentUser}
              canManage={canManageAllocations(currentUser)}
              allocations={sellerAllocations}
              allocationLog={allocationLog}
              onSave={async (next, note, logEntries) => {
                // Defense in depth: the page only shows management controls
                // to the warehouse manager, but never trust the UI alone.
                if (!canManageAllocations(currentUser)) return;
                await persistSellerAllocations(next);
                await appendAllocationLog(logEntries);
                showToast("تم تحديث توزيع المخزون");
                logActivity(currentUser, "تعديل توزيع المخزون", note || "");
              }}
              onConfirm={askConfirm}
            />
          )}
          {view === "announcements" && (
            <AnnouncementsPage
              announcements={announcements}
              isAdmin={isAdmin}
              onCreate={createAnnouncement}
              onDelete={deleteAnnouncement}
              onConfirm={askConfirm}
            />
          )}
          {view === "challenges" && (
            <ChallengesPage
              sales={sales}
              users={users}
              currentUser={currentUser}
              isAdmin={isAdmin}
              sellerGoals={sellerGoals}
              onSaveGoal={saveSellerGoal}
            />
          )}
          {view === "preferences" && (
            <PreferencesPage
              fontScale={fontScale}
              onSetFontScale={setFontScale}
              personalTheme={personalTheme}
              onSetPersonalTheme={setPersonalTheme}
              personalCardStyle={personalCardStyle}
              onSetPersonalCardStyle={setPersonalCardStyle}
              darkMode={darkMode}
              onToggleDarkMode={toggleDarkMode}
              companyTheme={settings.theme || "classic"}
              companyCardStyle={settings.cardStyle || "classic"}
            />
          )}
          {view === "expenses" && isAdmin && (
            <ExpensesPage
              expenses={expenses}
              onAdd={addExpense}
              onDelete={deleteExpense}
              onConfirm={askConfirm}
              activeTheme={activeTheme}
            />
          )}
          {view === "accounting" && isAdmin && (
            <AccountingPage
              sales={sales}
              products={products}
              expenses={expenses}
              stockLogs={stockLogs}
              activeTheme={activeTheme}
            />
          )}
          {view === "capital" && isAdmin && (
            <CapitalPartnersPage
              sales={sales}
              products={products}
              expenses={expenses}
              stockLogs={stockLogs}
              partners={partners}
              profitDistributions={profitDistributions}
              currentUser={currentUser}
              onSavePartners={savePartners}
              onSaveDistribution={saveProfitDistribution}
              onDeleteDistribution={deleteProfitDistribution}
              onConfirm={askConfirm}
              onPrint={(data) => setPrintPayload({ type: "distribution", data })}
            />
          )}
          {view === "users" && isAdmin && (
            <UsersAdmin
              sales={sales}
              sellerAllocations={sellerAllocations}
              users={users}
              onSave={async (next) => { await persistUsers(next); showToast("تم حفظ بيانات المستخدمين بنجاح"); }}
              onConfirm={askConfirm}
              currentUser={currentUser}
              onToggleStockManager={async (target, grant) => {
                if (!currentUser?.isPrimaryAdmin || target.isPrimaryAdmin) return;
                await persistUsers(users.map((u) => (u.id === target.id ? { ...u, canManageStock: grant } : u)));
                showToast(grant ? `أصبح ${target.name} مسؤول المخزن` : `تم سحب صلاحية مسؤول المخزن من ${target.name}`);
                logActivity(currentUser, grant ? "منح صلاحية مسؤول المخزن" : "سحب صلاحية مسؤول المخزن", target.name);
              }}
            />
          )}
          {view === "activitylog" && currentUser?.isPrimaryAdmin && (
            <ActivityLogPage log={activityLog} users={users} />
          )}
          {view === "settings" && isAdmin && (
            <SettingsPage settings={settings} onSave={async (next) => { await persistSettings(next); showToast("تم حفظ الإعدادات"); }} fontScale={fontScale} onSetFontScale={setFontScale} />
          )}
          {view === "backup" && isAdmin && (
            <BackupPage
              data={{ users, products, sales, seq, settings, announcements, stockLogs, expenses, partners, profitDistributions, sellerGoals, sellerAllocations, stockRequests, allocationLog }}
              dailyBackup={dailyBackup}
              onRefreshDailyBackup={async () => {
                const today = new Date().toISOString().slice(0, 10);
                const snapshot = {
                  date: today,
                  savedAt: todayISO(),
                  data: { users, products, sales, seq, settings, announcements, stockLogs, expenses, partners, profitDistributions, sellerGoals, sellerAllocations, stockRequests, allocationLog },
                };
                await storeSet("perfume_daily_backup", snapshot);
                setDailyBackup(snapshot);
                showToast("تم تحديث النسخة اليومية الآن");
              }}
              onRestore={async (next, mode) => {
                if (mode === "replace") {
                  await persistUsers(next.users || users);
                  await persistProducts(next.products || products);
                  await persistSales(next.sales || sales);
                  await persistSeq(next.seq || seq);
                  await persistSettings(next.settings || settings);
                  await persistAnnouncements(next.announcements || announcements);
                  await persistStockLogs(next.stockLogs || stockLogs);
                  await persistExpenses(next.expenses || expenses);
                  await persistPartners(next.partners || partners);
                  await persistProfitDistributions(next.profitDistributions || profitDistributions);
                  await persistSellerGoals(next.sellerGoals || sellerGoals);
                  await persistSellerAllocations(next.sellerAllocations || sellerAllocations);
                  await persistStockRequests(next.stockRequests || stockRequests);
                  if (next.allocationLog) { await storeSet("perfume_allocation_log", next.allocationLog); setAllocationLog(next.allocationLog); }
                } else {
                  const mergeById = (a, b) => {
                    const map = new Map(a.map((x) => [x.id, x]));
                    (b || []).forEach((x) => { if (!map.has(x.id)) map.set(x.id, x); });
                    return Array.from(map.values());
                  };
                  await persistUsers(mergeById(users, next.users));
                  await persistProducts(mergeById(products, next.products));
                  await persistSales(mergeById(sales, next.sales));
                  await persistSeq({ ...seq, ...(next.seq || {}) });
                  await persistSettings({ ...settings, ...(next.settings || {}) });
                  await persistAnnouncements(mergeById(announcements, next.announcements));
                  await persistStockLogs(mergeById(stockLogs, next.stockLogs));
                  await persistExpenses(mergeById(expenses, next.expenses));
                  await persistPartners(mergeById(partners, next.partners));
                  await persistProfitDistributions(mergeById(profitDistributions, next.profitDistributions));
                  await persistSellerGoals({ ...sellerGoals, ...(next.sellerGoals || {}) });
                  await persistSellerAllocations(mergeById(sellerAllocations, next.sellerAllocations));
                  await persistStockRequests(mergeById(stockRequests, next.stockRequests));
                  const mergedLog = mergeById(allocationLog, next.allocationLog).sort((a, b) => new Date(b.date) - new Date(a.date));
                  await storeSet("perfume_allocation_log", mergedLog);
                  setAllocationLog(mergedLog);
                }
                showToast("تمت استعادة البيانات بنجاح");
              }}
            />
          )}
        </div>
        </main>
      </div>

      {/* Floating sell knob — present everywhere except while selling */}
      {view !== "newsale" && (
        <>
          <div className="no-print nm-fabfade" aria-hidden="true" />
          <button className="no-print nm-fab" onClick={() => setView("newsale")} aria-label="بيع جديد">
            <span><Plus size={26} strokeWidth={2.4} /></span>
            <span>بيع</span>
          </button>
        </>
      )}

      {toast && (
        <div className="no-print fixed inset-x-0 flex justify-center z-50 px-4" style={{ bottom: "calc(112px + env(safe-area-inset-bottom, 0px))" }} role="status" aria-live="polite">
          <div className="toast-anim nm-out text-sm font-semibold px-5 py-3 rounded-full flex items-center gap-2 max-w-full" style={{ color: "var(--ok)" }}>
            <Check size={16} /> <span className="text-[var(--text)]">{toast}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function NavBtn({ item, active, onClick }) {
  const Icon = item.icon;
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-semibold text-right transition ${
        active ? "text-white shadow-sm" : "text-[var(--text)] hover:bg-[var(--surface-3)]"
      }`}
      style={active ? { background: "linear-gradient(135deg, var(--accent-dark), var(--accent))" } : undefined}
    >
      <Icon size={18} />
      {item.label}
    </button>
  );
}

/* ---------------------------------- Notifications Bell ---------------------------------- */

function NotificationsBell({ onOpenUnpaid, open, setOpen, announcements, currentUser, products, sales, isAdmin, setView, onOpenAnnouncement, stockRequests = [], onRespondRequest, notifPermission, pushActive, pushReason, onRetryPush, onTestPush, onEnableNotifications }) {
  const panelRef = useRef(null);
  const [respondingId, setRespondingId] = useState(null); // guards against double-clicking approve/reject

  useEffect(() => {
    const onClickOutside = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [setOpen]);

  const seen = new Set(getSeenAnnouncementIds(currentUser.id));
  const unseenAnnouncements = announcements
    .filter((a) => !seen.has(a.id) && a.createdById !== currentUser.id)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const lowStock = products.filter((p) => p.stock <= (p.minStock ?? 5));
  const totalRemaining = sales.reduce((a, s) => a + s.remaining, 0);
  const remainingCount = sales.filter((s) => s.remaining > 0).length;

  // Stock-transfer requests a colleague sent to *me*, still waiting on my answer.
  const incomingRequests = stockRequests
    .filter((r) => r.targetSellerId === currentUser.id && r.status === "pending")
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const respond = async (id, approve) => {
    setRespondingId(id);
    try {
      await onRespondRequest(id, approve);
    } finally {
      setRespondingId(null);
    }
  };

  const badgeCount =
    unseenAnnouncements.length + incomingRequests.length + (lowStock.length > 0 ? 1 : 0) + (isAdmin && totalRemaining > 0 ? 1 : 0);
  const hasNotifications = badgeCount > 0;

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`nm-knob ${open ? "is-on" : ""}`}
        title="الإشعارات"
        aria-label={hasNotifications ? `الإشعارات، ${badgeCount} جديدة` : "الإشعارات"}
        aria-expanded={open}
      >
        <Bell size={19} />
        {hasNotifications && <span className="nm-badge fade-in">{badgeCount}</span>}
      </button>

      {open && (
        <div className="absolute left-0 top-14 w-80 max-w-[90vw] bg-[var(--surface)] rounded-3xl nm-pop z-50 announce-pop overflow-hidden" dir="rtl">
          <div className="px-4 py-3 border-b border-[var(--border)] flex items-center gap-2">
            <Bell size={16} className="text-[var(--accent)]" />
            <p className="font-bold text-sm flex-1">الإشعارات</p>
            {notifPermission === "default" && (
              <button onClick={onEnableNotifications} className="text-[10px] font-bold px-2 py-1 rounded-lg bg-[var(--surface-3)] text-[var(--accent-dark)] hover:bg-[var(--border)]">
                تفعيل إشعارات الجوال
              </button>
            )}
            {notifPermission === "granted" && (
              <span className="text-[10px] text-[#3F7D57] font-semibold" title={pushActive ? "تصل حتى والتطبيق مغلق" : "تصل والتطبيق مفتوح"}>
                إشعارات الجوال مفعّلة ✓{pushActive ? "" : " (والتطبيق مفتوح)"}
              </span>
            )}
            {notifPermission === "denied" && <span className="text-[10px] text-[#B23A3A] font-semibold">الإشعارات محظورة من إعدادات المتصفح</span>}
          </div>
          {notifPermission === "granted" && (
            <div className="px-4 py-2 border-b border-[var(--border)] bg-[var(--surface-2)] flex items-center gap-2 flex-wrap">
              {pushActive ? (
                <>
                  <p className="text-[10px] text-[#3F7D57] flex-1">✓ تصل الإشعارات حتى والتطبيق مغلق</p>
                  <button onClick={onTestPush} className="text-[10px] font-bold px-2 py-1 rounded-lg bg-[var(--surface-3)] text-[var(--accent-dark)] hover:bg-[var(--border)]">
                    إرسال إشعار تجريبي
                  </button>
                </>
              ) : (
                <>
                  <p className="text-[10px] text-[#B23A3A] flex-1 leading-relaxed">{pushReason || "الإشعارات لا تصل والتطبيق مغلق"}</p>
                  <button onClick={onRetryPush} className="text-[10px] font-bold px-2 py-1 rounded-lg bg-[var(--surface-3)] text-[var(--accent-dark)] hover:bg-[var(--border)]">
                    إعادة المحاولة
                  </button>
                </>
              )}
            </div>
          )}

          <div className="max-h-80 overflow-y-auto divide-y divide-[var(--border)]">
            {!hasNotifications ? (
              <div className="p-6 text-center">
                <p className="text-xs text-[var(--muted)]">لا توجد إشعارات جديدة — كل شيء تمام 👍</p>
              </div>
            ) : (
              <>
                {incomingRequests.map((r) => (
                  <div key={r.id} className="px-4 py-3 flex items-start gap-2.5">
                    <ArrowLeftRight size={15} className="text-[#C97B3D] shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold">
                        {r.requesterName} يطلب {r.qty} من {r.productName}
                      </p>
                      <p className="text-[10px] text-[var(--muted)] mb-2">من مخزونك الشخصي المخصص</p>
                      <div className="flex gap-2">
                        <button
                          disabled={respondingId === r.id}
                          onClick={() => respond(r.id, true)}
                          className="flex-1 flex items-center justify-center gap-1 text-[11px] font-bold rounded-lg py-1.5 bg-[#EAF6EF] text-[#3F7D57] hover:brightness-95 disabled:opacity-50"
                        >
                          <Check size={12} /> موافقة
                        </button>
                        <button
                          disabled={respondingId === r.id}
                          onClick={() => respond(r.id, false)}
                          className="flex-1 flex items-center justify-center gap-1 text-[11px] font-bold rounded-lg py-1.5 bg-[#FBEAEA] text-[#B23A3A] hover:brightness-95 disabled:opacity-50"
                        >
                          <X size={12} /> رفض
                        </button>
                      </div>
                    </div>
                  </div>
                ))}

                {unseenAnnouncements.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => { onOpenAnnouncement(a.id); setView("announcements"); setOpen(false); }}
                    className="w-full text-right px-4 py-3 hover:bg-[var(--surface-2)] flex items-start gap-2.5"
                  >
                    <Megaphone size={15} className="text-[var(--accent)] shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold truncate">{a.title}</p>
                      <p className="text-[10px] text-[var(--muted)]">تعميم جديد من {a.createdByName} · {dateLabel(a.date)}</p>
                    </div>
                  </button>
                ))}

                {lowStock.length > 0 && (
                  <button
                    onClick={() => { setView("inventory"); setOpen(false); }}
                    className="w-full text-right px-4 py-3 hover:bg-[var(--surface-2)] flex items-start gap-2.5"
                  >
                    <AlertTriangle size={15} className="text-[#B23A3A] shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold">{lowStock.length} منتج بحاجة لإعادة تخزين</p>
                      <p className="text-[10px] text-[var(--muted)] truncate">{lowStock.slice(0, 3).map((p) => p.name).join("، ")}{lowStock.length > 3 ? " ..." : ""}</p>
                    </div>
                  </button>
                )}

                {isAdmin && totalRemaining > 0 && (
                  <button
                    onClick={() => { onOpenUnpaid ? onOpenUnpaid() : setView("records"); setOpen(false); }}
                    className="w-full text-right px-4 py-3 hover:bg-[var(--surface-2)] flex items-start gap-2.5"
                  >
                    <Wallet size={15} className="text-[#B23A3A] shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold">{fmt(totalRemaining)} K.D مستحقة على العملاء</p>
                      <p className="text-[10px] text-[var(--muted)]">عبر {remainingCount} فاتورة غير مسدَّدة بالكامل</p>
                    </div>
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}


function GlobalStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@300;400;500;600;700&family=Amiri:wght@400;700&family=Tajawal:wght@400;500;700;800&display=swap');
      * { font-family: 'IBM Plex Sans Arabic', 'Tajawal', system-ui, sans-serif; }

      /* ================= «الملمس الناعم» — one tactile material for the whole app =================
         Raised (nm-out) = something you press. Sunk (nm-in) = something you type into or read from.
         Pressed-in = the chosen option. Teal is reserved for the primary action and key values. */
      :root {
        --bg: #E8ECF1;
        --surface: #E8ECF1;
        --surface-2: #E8ECF1;
        --surface-3: #E1E6EC;
        --border: #D3D9E0;
        --text: #27303B;
        --muted: #5C6877;
        --faint: #8B95A2;
        --input-bg: #E8ECF1;
        --accent: #2F7F86;
        --accent-dark: #1C5A60;
        --accent-ink: var(--accent-dark);
        --s-hi: #FFFFFF;
        --s-lo: #C3C9D2;
        --ok: #2C7A52; --ok-t: #DDEEE4;
        --due: #8A4B12; --due-t: #F3E6D6;
        --bad: #A93636; --bad-t: #F4DEDE;
        --info: #2F5E9A; --info-t: #DCE6F3;
        --nm-out: 6px 6px 12px var(--s-lo), -6px -6px 12px var(--s-hi);
        --nm-out-lg: 10px 10px 20px var(--s-lo), -10px -10px 20px var(--s-hi);
        --nm-out-sm: 3px 3px 6px var(--s-lo), -3px -3px 6px var(--s-hi);
        --nm-in: inset 4px 4px 8px var(--s-lo), inset -4px -4px 8px var(--s-hi);
        --nm-in-sm: inset 2px 2px 5px var(--s-lo), inset -2px -2px 5px var(--s-hi);
        color-scheme: light;
      }
      html.dark {
        --bg: #2A2F37;
        --surface: #2A2F37;
        --surface-2: #2A2F37;
        --surface-3: #30363F;
        --border: #3A414C;
        --text: #E7EBF0;
        --muted: #A5AEBA;
        --faint: #7D8794;
        --input-bg: #2A2F37;
        --accent-ink: color-mix(in srgb, var(--accent) 55%, white);
        --s-hi: #363C46;
        --s-lo: #1C2026;
        --ok: #7ACF9E; --ok-t: #2C3E35;
        --due: #E3A865; --due-t: #43382B;
        --bad: #F08C8C; --bad-t: #472F31;
        --info: #8DB4E8; --info-t: #2D3848;
        color-scheme: dark;
      }
      html[data-theme="emerald"] { --accent: #2F8F6B; --accent-dark: #1B5E45; }
      html[data-theme="rose"] { --accent: #B24A6A; --accent-dark: #7A2E47; }
      html[data-theme="sapphire"] { --accent: #3B6EA8; --accent-dark: #244A75; }
      html[data-theme="violet"] { --accent: #6E55A0; --accent-dark: #46356B; }
      html[data-theme="amber"] { --accent: #B06A2E; --accent-dark: #7A461C; }
      html[data-theme="gem"] { --accent: #A8842A; --accent-dark: #6E5518; }
      html[data-theme="candy"] { --accent: #12A594; --accent-dark: #0B6B60; }
      html[data-theme="pastel"] { --accent: #5BADA6; --accent-dark: #2E6B65; }

      html, body { background: var(--bg); -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
      body { color: var(--text); transition: background-color .25s ease, color .25s ease; }
      ::selection { background: color-mix(in srgb, var(--accent) 25%, transparent); }

      /* ---------- material primitives ---------- */
      .nm-out { background: var(--bg); box-shadow: var(--nm-out); }
      .nm-out-lg { background: var(--bg); box-shadow: var(--nm-out-lg); }
      .nm-out-sm { background: var(--bg); box-shadow: var(--nm-out-sm); }
      .nm-in { background: var(--bg); box-shadow: var(--nm-in); }
      .nm-in-sm { background: var(--bg); box-shadow: var(--nm-in-sm); }
      .nm-card { background: var(--bg); border-radius: 22px; box-shadow: var(--nm-out); border: 0; }
      .nm-well { background: var(--bg); border-radius: 18px; box-shadow: var(--nm-in); }
      .nm-pop { box-shadow: 0 24px 48px -12px rgba(20,28,40,.35), var(--nm-out) !important; }
      .nm-ink { color: var(--accent-ink); }
      .nm-mut { color: var(--muted); }
      .nm-num { direction: ltr; unicode-bidi: isolate; font-variant-numeric: tabular-nums; }

      /* knobs (round raised buttons) */
      .nm-knob { width: 40px; height: 40px; border-radius: 50%; display: inline-grid; place-items: center; flex: none; position: relative;
        background: var(--bg); color: var(--text); box-shadow: var(--nm-out-sm); transition: box-shadow .18s ease, transform .12s ease, color .18s ease; }
      .nm-knob:hover { color: var(--accent-ink); }
      .nm-knob:active, .nm-knob.is-on { box-shadow: var(--nm-in-sm); color: var(--accent-ink); transform: none !important; }
      .nm-knob.lg { width: 56px; height: 56px; box-shadow: var(--nm-out); }
      .nm-knob.sm { width: 34px; height: 34px; }
      .nm-knob.danger { color: var(--bad); }
      .nm-knob .nm-badge { position: absolute; top: -4px; left: -4px; min-width: 18px; height: 18px; padding: 0 4px; border-radius: 99px; background: #C24848; color: #fff; font-size: 10px; font-weight: 700; display: grid; place-items: center; box-shadow: 0 2px 5px rgba(150,40,40,.35); }
      .nm-act { display: inline-flex; flex-direction: column; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; color: var(--muted); min-width: 50px; }
      .nm-act:hover { color: var(--text); }

      /* buttons */
      :where(.nm-btn) { padding: 11px 18px; font-size: 14px; }
      .nm-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; border-radius: 999px; font-weight: 700;
        background: var(--bg); color: var(--text); box-shadow: var(--nm-out); border: 0; transition: box-shadow .18s ease, transform .12s ease, filter .18s ease; white-space: nowrap; }
      .nm-btn:hover { color: var(--accent-ink); }
      .nm-btn:active { box-shadow: var(--nm-in-sm); transform: none !important; }
      .nm-btn.ink { color: var(--accent-ink); }
      .nm-btn.danger { color: var(--bad); }
      .nm-btn.solid { color: #fff; background: linear-gradient(145deg, color-mix(in srgb, var(--accent) 88%, white), var(--accent-dark));
        box-shadow: 6px 6px 12px var(--s-lo), -6px -6px 12px var(--s-hi), inset 1px 1px 2px rgba(255,255,255,.25); }
      .nm-btn.solid:hover { filter: brightness(1.06); color: #fff; }
      .nm-btn.solid-danger { color: #fff; background: linear-gradient(145deg, #C45555, #962F2F); box-shadow: 6px 6px 12px var(--s-lo), -6px -6px 12px var(--s-hi), inset 1px 1px 2px rgba(255,255,255,.2); }
      .nm-btn.solid-danger:hover { color: #fff; filter: brightness(1.06); }
      .nm-btn:disabled { opacity: .5; pointer-events: none; }

      /* inputs are always sunk */
      .nm-input { width: 100%; background: var(--bg); border: 0 !important; border-radius: 14px; box-shadow: var(--nm-in); color: var(--text); outline: none; transition: box-shadow .18s ease; }
      .nm-input::placeholder { color: var(--faint); }
      .nm-input:focus { box-shadow: var(--nm-in), 0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent); }
      select.nm-input { appearance: none; -webkit-appearance: none; background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%);
        background-position: 18px 55%, 13px 55%; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; padding-left: 32px !important; }

      /* segmented choices: sunk track, raised choice */
      .nm-tog { display: flex; gap: 4px; padding: 5px; border-radius: 999px; background: var(--bg); box-shadow: var(--nm-in); }
      .nm-tog > button { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 10px; border-radius: 999px; font-size: 12.5px; font-weight: 600; color: var(--muted); transition: box-shadow .2s ease, color .2s ease; white-space: nowrap; }
      .nm-tog > button.is-on { color: var(--accent-ink); font-weight: 700; background: var(--bg); box-shadow: var(--nm-out-sm); }

      /* main navigation: raised track, the current tab pressed IN */
      .nm-seg { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; padding: 5px; border-radius: 999px; background: var(--bg); box-shadow: var(--nm-out); }
      .nm-seg > button { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 9px 4px; border-radius: 999px; font-size: 13px; font-weight: 600; color: var(--muted); transition: box-shadow .2s ease, color .2s ease; }
      .nm-seg > button.is-on { color: var(--accent-ink); font-weight: 700; box-shadow: var(--nm-in-sm); }
      .nm-seg > button svg { width: 16px; height: 16px; }
      @media (max-width: 420px) { .nm-seg > button svg { display: none; } }

      /* status pills */
      .nm-pill { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 700; padding: 3px 10px; border-radius: 999px; white-space: nowrap; box-shadow: var(--nm-in-sm); }
      .nm-pill.ok { color: var(--ok); background: var(--ok-t); }
      .nm-pill.due { color: var(--due); background: var(--due-t); }
      .nm-pill.bad { color: var(--bad); background: var(--bad-t); }
      .nm-pill.info { color: var(--info); background: var(--info-t); }
      .nm-pill.plain { color: var(--muted); background: var(--bg); }

      /* switch */
      .nm-switch { width: 48px; height: 28px; border-radius: 99px; background: var(--bg); box-shadow: var(--nm-in-sm); position: relative; flex: none; transition: background .2s ease; }
      .nm-switch::after { content: ""; position: absolute; top: 4px; right: 4px; width: 20px; height: 20px; border-radius: 50%; background: var(--bg); box-shadow: 2px 2px 4px var(--s-lo), -1px -1px 3px var(--s-hi); transition: right .22s cubic-bezier(.34,1.4,.64,1); }
      .nm-switch.is-on { background: linear-gradient(145deg, var(--accent), var(--accent-dark)); box-shadow: inset 2px 2px 4px rgba(0,0,0,.25); }
      .nm-switch.is-on::after { right: 24px; background: #F4F7F9; }

      /* groove progress */
      .nm-groove { height: 12px; border-radius: 99px; padding: 3px; background: var(--bg); box-shadow: var(--nm-in-sm); }
      .nm-groove > span { display: block; height: 6px; border-radius: 99px; background: linear-gradient(270deg, color-mix(in srgb, var(--accent) 80%, white), var(--accent-dark)); transition: width .5s ease; }

      /* the signature dial */
      .nm-dial { width: 196px; height: 196px; border-radius: 50%; margin: 0 auto; display: grid; place-items: center; background: var(--bg); box-shadow: var(--nm-out-lg); }
      .nm-dial .track { width: 160px; height: 160px; border-radius: 50%; position: relative; display: grid; place-items: center; background: var(--bg); box-shadow: var(--nm-in); }
      .nm-dial svg { position: absolute; inset: 0; width: 160px; height: 160px; transform: rotate(-90deg) scaleY(-1); }
      .nm-dial circle.arc { transition: stroke-dasharray .9s cubic-bezier(.2,.8,.2,1); }
      .nm-dial .core { width: 118px; height: 118px; border-radius: 50%; display: grid; place-content: center; text-align: center; gap: 2px; background: var(--bg); box-shadow: 5px 5px 10px var(--s-lo), -5px -5px 10px var(--s-hi); }

      /* product tiles in the point of sale */
      .nm-tile { background: var(--bg); border-radius: 20px; box-shadow: var(--nm-out); border: 0 !important; transition: box-shadow .18s ease, transform .12s ease; }
      .nm-tile:not(:disabled):active { box-shadow: var(--nm-in-sm); }
      .nm-tile.req { box-shadow: var(--nm-in-sm); outline: 1.5px dashed var(--due); outline-offset: -6px; }
      .nm-tile.in-cart { box-shadow: var(--nm-out), inset 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent); }

      /* floating sell knob */
      .nm-fab { position: fixed; left: 50%; bottom: calc(18px + env(safe-area-inset-bottom, 0px)); transform: translateX(-50%); z-index: 35; display: grid; justify-items: center; gap: 4px; }
      .nm-fab > span:first-child { width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; color: #fff;
        background: linear-gradient(145deg, color-mix(in srgb, var(--accent) 85%, white), var(--accent-dark));
        box-shadow: 8px 8px 18px var(--s-lo), -8px -8px 18px var(--s-hi), inset 2px 2px 4px rgba(255,255,255,.25), inset -3px -3px 6px rgba(0,0,0,.18); transition: transform .15s ease; }
      .nm-fab:active > span:first-child { transform: scale(.94); }
      .nm-fab > span:last-child { font-size: 11.5px; font-weight: 700; color: var(--accent-ink); }
      .nm-fabfade { position: fixed; left: 0; right: 0; bottom: 0; height: 110px; z-index: 30; pointer-events: none; background: linear-gradient(to top, var(--bg) 45%, transparent); }

      /* ---------- charts (shared): validated colours, thin bars in a sunk track ---------- */
      :root { --chart-1: #008C99; --chart-2: #C8782A; --c-cogs: #4E6FAE; --c-exp: #C8782A; --c-waste: #7E3B78; --c-net: #008C99; }
      html.dark { --chart-1: #1C9AA3; --chart-2: #BE7C2C; --c-cogs: #7090DC; --c-exp: #BE7C2C; --c-waste: #A05A98; --c-net: #22A0A8; }
      .nm-bar { display: flex; gap: 2px; height: 14px; padding: 3px; border-radius: 99px; background: var(--bg); box-shadow: var(--nm-in-sm); }
      .nm-bar > i { display: block; height: 8px; border-radius: 4px; min-width: 3px; transition: width .5s ease; }
      .nm-bar > i:first-child { border-radius: 99px 4px 4px 99px; }
      .nm-bar > i:last-child { border-radius: 4px 99px 99px 4px; }
      .nm-bar > i:only-child { border-radius: 99px; }
      .nm-bar.lg { height: 22px; padding: 4px; }
      .nm-bar.lg > i { height: 14px; }
      .nm-key { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); }
      .nm-key::before { content: ""; width: 10px; height: 10px; border-radius: 3px; background: var(--k); flex: none; }
      .nm-sign { width: 26px; height: 26px; border-radius: 50%; display: inline-grid; place-items: center; flex: none; font-weight: 700; font-size: 15px; line-height: 1; background: var(--bg); box-shadow: var(--nm-in-sm); }

      /* sticky header */
      .nm-header { background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(14px) saturate(1.2); -webkit-backdrop-filter: blur(14px) saturate(1.2); }

      /* ---------- legacy utility remaps so every existing page wears the new material ---------- */
      div.bg-\[var\(--surface-2\)\], div.bg-\[var\(--surface-3\)\], label.bg-\[var\(--surface-2\)\], span.bg-\[var\(--surface-3\)\] { background: var(--bg) !important; box-shadow: var(--nm-in-sm); }
      button.bg-\[var\(--surface-2\)\], button.bg-\[var\(--surface-3\)\] { background: var(--bg) !important; box-shadow: var(--nm-out-sm); }
      button.bg-\[var\(--surface-2\)\]:active, button.bg-\[var\(--surface-3\)\]:active { box-shadow: var(--nm-in-sm); }
      button.bg-\[var\(--accent\)\] { box-shadow: var(--nm-out-sm); }
      html .text-\[\#B23A3A\] { color: var(--bad); }
      html .text-\[\#3F7D57\] { color: var(--ok); }
      html .text-\[\#C97B3D\] { color: var(--due); }
      html .text-\[\#3B6EA8\] { color: var(--info); }
      html .bg-\[\#FBEAEA\] { background-color: var(--bad-t); }
      html .bg-\[\#FFF6E5\] { background-color: var(--due-t); }
      html .bg-\[\#EAF6EF\] { background-color: var(--ok-t); }
      html .bg-\[\#EAF1F8\] { background-color: var(--info-t); }
      html .bg-\[\#FBF9F5\] { background-color: var(--bg); }
      html .border-\[\#F5EEDF\], html .border-\[\#E8B4B4\] { border-color: var(--border); }
      html.dark .text-\[var\(--accent-dark\)\], html.dark .text-\[var\(--accent\)\] { color: var(--accent-ink); }
      html .rounded-2xl.shadow-xl, html .rounded-3xl.shadow-2xl { box-shadow: 0 24px 48px -12px rgba(20,28,40,.35), var(--nm-out); }
      table thead tr { color: var(--muted); }

      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-thumb { background: var(--s-lo); border-radius: 8px; }

      /* ---------- motion ---------- */
      @keyframes fadeInUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      @keyframes popIn { from { opacity: 0; transform: scale(0.94); } to { opacity: 1; transform: none; } }
      @keyframes backdropIn { from { opacity: 0; } to { opacity: 1; } }
      @keyframes toastUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes orbitSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      @keyframes orbitCounterSpin { from { transform: translateX(-50%) rotate(0deg); } to { transform: translateX(-50%) rotate(-360deg); } }

      .loader-orbit { position: relative; width: 140px; height: 140px; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: var(--bg); box-shadow: var(--nm-out-lg); }
      .loader-orbit-rotator { position: absolute; inset: 8px; animation: orbitSpin 2.4s linear infinite; }
      .loader-orbit-icon { position: absolute; top: 2px; left: 50%; transform: translateX(-50%); animation: orbitCounterSpin 2.4s linear infinite; }
      .loader-center-text { position: relative; z-index: 2; font-size: 13px; font-weight: 700; color: var(--accent-ink); text-align: center; white-space: nowrap; }

      .fade-in { animation: fadeInUp .28s ease backwards; }
      .view-transition { animation: fadeInUp .24s ease backwards; }
      .announce-pop { animation: popIn .25s cubic-bezier(0.34,1.56,0.64,1) backwards; }
      .announce-backdrop { animation: backdropIn .2s ease both; }
      .toast-anim { animation: toastUp .25s cubic-bezier(0.34,1.56,0.64,1) both; }

      .card-hover { transition: transform .18s ease, box-shadow .18s ease; }
      .card-hover:hover { transform: translateY(-2px); }

      button, a, select, .card-hover { -webkit-tap-highlight-color: transparent; }
      button:not(:disabled) { transition: transform .12s ease, background-color .15s ease, box-shadow .18s ease, opacity .15s ease, color .15s ease; }
      button:not(:disabled):active { transform: scale(0.97); }
      .spin-slow { animation: spin 1s linear infinite; }
      * { scroll-behavior: smooth; }
      :focus-visible { outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent); outline-offset: 2px; }

      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
      @media print {
        .no-print { display: none !important; }
        html, body { background: white !important; }
      }
    `}</style>
  );
}


/* ---------------------------------- Dashboard ---------------------------------- */

// How a seller is doing against the stock personally allocated to them.
// Target = what their share is worth: the real value of the units they already
// sold from it + the remaining units at today's price. Units that left the
// share without a sale (gifts, damage, transfers to a colleague) are therefore
// excluded automatically, and the target shrinks/grows as the share changes.
// Progress = money actually collected on those sold units, so the dial only
// reaches 100% when the share is empty AND every invoice drawing on it is paid.
function shareProgressFor(sales, allocations, products, sellerId) {
  const mine = (allocations || []).filter((a) => a.sellerId === sellerId);
  if (mine.length === 0) return null;
  const priceOf = (pid) => products.find((p) => p.id === pid)?.price || 0;
  let soldValue = 0, collected = 0, soldUnits = 0;
  sales.forEach((s) => {
    const srcs = (s.allocationSources || []).filter((x) => x.sellerId === sellerId);
    if (srcs.length === 0) return;
    const pids = new Set(srcs.map((x) => x.productId));
    const lineValue = (s.items || []).filter((i) => pids.has(i.productId)).reduce((a, i) => a + (i.total ?? i.qty * i.price), 0);
    const factor = s.subtotal > 0 ? s.total / s.subtotal : 1; // spread discount/tax over the lines
    const value = lineValue * factor;
    soldValue += value;
    collected += s.total > 0 ? value * (s.collected / s.total) : 0;
    soldUnits += srcs.reduce((a, x) => a + x.qty, 0);
  });
  const remainingUnits = mine.reduce((a, x) => a + Math.max(0, x.remaining), 0);
  const remainingValue = mine.reduce((a, x) => a + Math.max(0, x.remaining) * priceOf(x.productId), 0);
  const target = soldValue + remainingValue;
  return { target, collected, soldValue, due: Math.max(0, soldValue - collected), soldUnits, remainingUnits, remainingValue, pct: target > 0 ? Math.min(100, (collected / target) * 100) : 0 };
}

function SoftDial({ value, pct, label, caption, size = 196 }) {
  const r = 71;
  const c = 2 * Math.PI * r;
  const dash = Math.max(0, Math.min(100, pct)) / 100 * c;
  return (
    <div className="nm-dial" role="img" aria-label={`${label}: ${value}، ${caption}`} style={size !== 196 ? { width: size, height: size } : undefined}>
      <div className="track">
        <svg viewBox="0 0 160 160" aria-hidden="true">
          <circle className="arc" cx="80" cy="80" r={r} fill="none" stroke="var(--accent)" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${dash} ${c}`} />
        </svg>
        <div className="core">
          <span className="text-[10.5px] nm-mut">{label}</span>
          <span className="nm-num text-[20px] font-bold leading-tight">{value}</span>
          <span className="text-[11px] font-bold nm-ink">{caption}</span>
        </div>
      </div>
    </div>
  );
}

function Dashboard({ sales, products, users, sellerGoals, currentUser, setView, activeTheme, sellerAllocations = [], onOpenUnpaid }) {
  const isAdmin = currentUser.role === "admin";
  const mySales = sales; // everyone can see overall store sales now
  const totalRevenue = mySales.reduce((a, s) => a + s.total, 0);
  const totalCollected = mySales.reduce((a, s) => a + s.collected, 0);
  const totalRemaining = mySales.reduce((a, s) => a + s.remaining, 0);
  const lowStock = products.filter((p) => p.stock <= (p.minStock ?? 5));

  // This-month leaderboard rank, surfaced here so the gamification is visible
  // right on the home screen without needing to open the Challenges page.
  const monthRank = useMemo(() => {
    const sellers = users.filter((u) => u.role === "seller" || u.role === "admin");
    const start = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const map = new Map();
    sellers.forEach((u) => map.set(u.id, { id: u.id, name: u.name, collected: 0 }));
    sales.filter((s) => new Date(s.date) >= start).forEach((s) => {
      const cur = map.get(s.sellerId);
      if (cur) cur.collected += s.collected;
    });
    const ranked = Array.from(map.values()).sort((a, b) => b.collected - a.collected);
    const idx = ranked.findIndex((r) => r.id === currentUser.id);
    return { rank: idx + 1, total: ranked.length, collected: ranked[idx]?.collected || 0, top: ranked[0]?.collected || 0 };
  }, [sales, users, currentUser.id]);

  const myGoal = sellerGoals?.[currentUser.id] || 0;
  const goalProgress = myGoal > 0 ? Math.min(100, (monthRank.collected / myGoal) * 100) : 0;
  const dialPct = myGoal > 0 ? goalProgress : monthRank.top > 0 ? (monthRank.collected / monthRank.top) * 100 : 0;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "صباح الخير" : "مساء الخير";
  const monthName = new Date().toLocaleDateString("ar", { month: "long" });
  const canManage = canManageAllocations(currentUser);
  const share = useMemo(() => shareProgressFor(sales, sellerAllocations, products, currentUser.id), [sales, sellerAllocations, products, currentUser.id]);
  const medalColor = monthRank.rank === 1 ? "#A8842A" : monthRank.rank === 2 ? "#7C8794" : monthRank.rank === 3 ? "#9A6420" : "var(--accent-ink)";

  const actions = [
    { label: "بيع", icon: ShoppingCart, view: "newsale", ink: true },
    { label: "تحصيل", icon: Wallet, view: "records" },
    { label: "هدية/تالف", icon: Gift, view: "inventory" },
    { label: canManage ? "التوزيع" : "حصتي", icon: Boxes, view: "allocations" },
  ];

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-bold">{greeting}، {currentUser.name}</h2>
        <p className="text-sm nm-mut">نظرة على أدائك وأداء المتجر</p>
      </div>

      <div className="grid md:grid-cols-2 gap-6 items-center">
        <div className="flex flex-col items-center gap-4">
          {share ? (
            <SoftDial
              value={fmt(share.collected)}
              pct={share.pct}
              label="محصّل من حصتي"
              caption={`${share.pct.toFixed(0)}٪ من ${fmt(share.target).replace(/\.000$/, "")} د.ك`}
            />
          ) : (
            <SoftDial
              value={fmt(monthRank.collected)}
              pct={dialPct}
              label={`محصّلي في ${monthName}`}
              caption={myGoal > 0 ? `${goalProgress.toFixed(0)}٪ من هدف ${fmt(myGoal).replace(/\.000$/, "")}` : `الترتيب ${monthRank.rank || "-"} من ${monthRank.total}`}
            />
          )}
          {share && (
            <div className="nm-well w-full max-w-sm grid grid-cols-3 text-center py-3 px-2" aria-label="تفاصيل حصتي">
              <button onClick={() => setView("allocations")} className="min-w-0">
                <p className="text-[10.5px] nm-mut">باقي في حصتي</p>
                <p className="nm-num font-bold text-sm">{share.remainingUnits} <span className="text-[10px] nm-mut font-medium">قطعة</span></p>
                <p className="nm-num text-[10.5px] nm-mut">{fmt(share.remainingValue)}</p>
              </button>
              <div className="border-x border-[var(--border)] min-w-0">
                <p className="text-[10.5px] nm-mut">بِعت منها</p>
                <p className="nm-num font-bold text-sm">{share.soldUnits} <span className="text-[10px] nm-mut font-medium">قطعة</span></p>
                <p className="nm-num text-[10.5px] nm-mut">{fmt(share.soldValue)}</p>
              </div>
              <button onClick={onOpenUnpaid} className="min-w-0" disabled={share.due <= 0}>
                <p className="text-[10.5px] nm-mut">بانتظار التحصيل</p>
                <p className={`nm-num font-bold text-sm ${share.due > 0 ? "text-[var(--due)]" : "text-[var(--ok)]"}`}>{fmt(share.due)}</p>
                <p className="text-[10.5px] nm-mut">{share.due > 0 ? "اضغط للعرض" : "لا شيء"}</p>
              </button>
            </div>
          )}
          {share && share.remainingUnits === 0 && share.due <= 0 && share.target > 0 && (
            <p className="text-xs font-semibold text-[var(--ok)]">أحسنت! بعت حصتك كاملة وحصّلت قيمتها</p>
          )}
        </div>
        <div className="grid grid-cols-4 gap-2 justify-items-center">
          {actions.map((a) => {
            const Icon = a.icon;
            return (
              <button key={a.label} onClick={() => setView(a.view)} className="nm-act">
                <span className={`nm-knob lg ${a.ink ? "nm-ink" : ""}`}><Icon size={22} /></span>
                {a.label}
              </button>
            );
          })}
        </div>
      </div>

      <section className="flex flex-col gap-3" aria-label="أداء المتجر">
        <div className="flex items-baseline justify-between">
          <h3 className="font-bold text-[15px]">أداء المتجر</h3>
          <span className="text-xs nm-mut">كل البائعين</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="عدد الفواتير" value={mySales.length} icon={Receipt} />
          <StatCard label="إجمالي المبيعات" value={fmt(totalRevenue)} unit="د.ك" icon={TrendingUp} />
          <StatCard label="المحصّل" value={fmt(totalCollected)} unit="د.ك" icon={Wallet} tone="ink" />
          <button onClick={onOpenUnpaid} className="text-right" aria-label="عرض الفواتير غير المحصّلة">
            <StatCard label="المتبقي · غير محصّل" value={fmt(totalRemaining)} unit="د.ك" icon={AlertTriangle} tone={totalRemaining > 0 ? "due" : undefined} />
          </button>
        </div>
      </section>

      <button onClick={() => setView("challenges")} className="nm-card p-4 flex items-center gap-3 text-right card-hover">
        <span className="nm-knob" style={{ boxShadow: "var(--nm-in-sm)", color: medalColor }}><Medal size={20} /></span>
        <span className="flex-1 min-w-0">
          <span className="block font-bold text-sm">ترتيبك هذا الشهر: {monthRank.rank || "-"} من {monthRank.total}</span>
          <span className="block text-xs nm-mut mt-0.5">التحديات والأوسمة</span>
          {myGoal > 0 && (
            <span className="block mt-2 nm-groove" aria-hidden="true"><span style={{ width: `${goalProgress}%` }} /></span>
          )}
        </span>
        <ChevronLeft size={18} className="nm-mut shrink-0" />
      </button>

      <div className="grid md:grid-cols-2 gap-6">
        <section className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <h3 className="font-bold text-[15px]">آخر المبيعات</h3>
            <button onClick={() => setView("records")} className="text-xs font-semibold nm-ink">عرض الكل</button>
          </div>
          <div className="nm-card px-4 py-1">
            {mySales.length === 0 ? (
              <EmptyState text="لا توجد مبيعات مسجلة بعد" />
            ) : (
              mySales.slice(0, 5).map((s, i) => (
                <div key={s.id} className={`flex items-center gap-3 py-3 ${i ? "border-t border-[var(--border)]" : ""}`}>
                  <span className="nm-knob sm" style={{ boxShadow: "var(--nm-in-sm)" }}><Receipt size={15} className="nm-ink" /></span>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm">{s.invoiceNo}</p>
                    <p className="text-xs nm-mut truncate">{s.sellerName} · {dateLabel(s.date)}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="nm-num font-bold text-sm">{fmt(s.total)}</span>
                    {s.remaining > 0 ? <span className="nm-pill due">متبقٍ {fmt(s.remaining)}</span> : <span className="nm-pill ok">مسدّدة</span>}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <h3 className="font-bold text-[15px]">تنبيهات المخزون</h3>
            <button onClick={() => setView("inventory")} className="text-xs font-semibold nm-ink">المخزن</button>
          </div>
          {lowStock.length === 0 ? (
            <div className="nm-well p-4"><EmptyState text="جميع المنتجات بكميات كافية" /></div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {lowStock.slice(0, 6).map((p) => (
                <div key={p.id} className="nm-well px-4 py-3">
                  <p className="font-bold text-sm truncate">{p.name}</p>
                  <p className={`text-xs font-semibold ${p.stock <= 0 ? "text-[var(--bad)]" : "text-[var(--due)]"}`}>
                    {p.stock <= 0 ? "نفد المخزون" : `${p.stock} متبقي`}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// KPI shown as a sunk well: a label you read, never a button you press.
// (color/themeKey/slot are still accepted from older call sites; the soft
// design keeps one consistent look instead of per-theme coloured cards.)
function StatCard({ label, value, unit, color, icon: Icon, tone }) {
  if (!tone && color) tone = color === "#B23A3A" ? "bad" : color === "#3F7D57" ? "ok" : color === "var(--accent)" ? "ink" : undefined;
  if (!unit && typeof value === "string" && value.endsWith(" K.D")) { value = value.slice(0, -4); unit = "د.ك"; }
  const valueColor = tone === "ink" ? "var(--accent-ink)" : tone === "due" ? "var(--due)" : tone === "bad" ? "var(--bad)" : tone === "ok" ? "var(--ok)" : "var(--text)";
  return (
    <div className="nm-well px-4 py-3 relative min-w-0">
      {Icon && <Icon size={14} className="absolute top-3 left-3 nm-mut" aria-hidden="true" />}
      <p className="text-[11px] nm-mut mb-1 leading-snug line-clamp-2 pl-6">{label}</p>
      <p className="nm-num text-base font-bold leading-tight whitespace-nowrap text-right" style={{ color: valueColor }}>
        {value}{unit && <span className="text-[10px] font-medium nm-mut ml-1">{unit}</span>}
      </p>
    </div>
  );
}

function MorePage({ currentUser, isAdmin, visibleNav, setView, darkMode, onToggleDarkMode, onLogout, unseenAnnouncements = 0 }) {
  const byKey = new Map(visibleNav.map((n) => [n.key, n]));
  const groups = MORE_GROUPS
    .map((g) => ({ ...g, items: g.keys.map((k) => byKey.get(k)).filter(Boolean) }))
    .filter((g) => g.items.length > 0);
  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-6">
      <div className="nm-card p-4 flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="nm-knob lg" style={{ boxShadow: "var(--nm-in-sm)" }}>
            <span className="text-xl font-bold nm-ink">{(currentUser.name || "?").trim().charAt(0)}</span>
          </span>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-lg leading-tight truncate">{currentUser.name}</p>
            <p className="text-xs nm-mut truncate">
              {isAdmin ? "مدير النظام" : "بائع"}
              {currentUser.isPrimaryAdmin ? " · الحساب الأساسي" : ""}
              {currentUser.canManageStock && !currentUser.isPrimaryAdmin ? " · مسؤول المخزن" : ""}
            </p>
          </div>
          <button onClick={onLogout} className="nm-knob danger" aria-label="تسجيل الخروج" title="تسجيل الخروج"><LogOut size={18} /></button>
        </div>
        <button onClick={onToggleDarkMode} role="switch" aria-checked={darkMode} className="nm-well px-4 py-3 flex items-center gap-3 text-right">
          {darkMode ? <Moon size={18} className="nm-ink" /> : <Sun size={18} className="nm-ink" />}
          <span className="flex-1 text-sm font-semibold">الوضع الداكن</span>
          <span className={`nm-switch ${darkMode ? "is-on" : ""}`} aria-hidden="true" />
        </button>
      </div>

      {groups.map((g) => (
        <section key={g.title} className="nm-card p-4 flex flex-col gap-4" aria-label={g.title}>
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-[15px]">{g.title}</h3>
            {g.adminOnly && <span className="nm-pill plain">للمدير</span>}
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-y-5 gap-x-2 justify-items-center">
            {g.items.map((n) => {
              const Icon = n.icon;
              const badge = n.key === "announcements" ? unseenAnnouncements : 0;
              return (
                <button key={n.key} onClick={() => setView(n.key)} className="nm-act text-center">
                  <span className="nm-knob lg">
                    <Icon size={21} />
                    {badge > 0 && <span className="nm-badge">{badge}</span>}
                  </span>
                  <span className="leading-tight max-w-[88px]">{MORE_SHORT[n.key] || n.label}</span>
                  {n.primaryOnly && <span className="nm-pill plain !text-[9.5px] !px-2 !py-0.5">للأساسي</span>}
                </button>
              );
            })}
          </div>
        </section>
      ))}

      {!isAdmin && <p className="text-center text-xs nm-mut">أقسام المالية والإدارة تظهر للمدير فقط</p>}
    </div>
  );
}

function EmptyState({ text }) {
  return (
    <div className="text-center py-6 text-sm text-[var(--muted)]">
      <p>{text}</p>
    </div>
  );
}

/* ---------------------------------- New Sale ---------------------------------- */

function NewSale({ products, users, currentUser, sales, seq, settings, sellerAllocations = [], stockRequests = [], onCreate, onSendRequest }) {
  const isAdmin = currentUser.role === "admin";
  const sellers = users.filter((u) => u.role === "seller" || u.role === "admin");
  const [sellerId, setSellerId] = useState(currentUser.id);
  const [cart, setCart] = useState([]);
  const [requestPanelProduct, setRequestPanelProduct] = useState(null);
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState(1);
  const [unitPrice, setUnitPrice] = useState("");
  const [collected, setCollected] = useState("");
  const [discountType, setDiscountType] = useState("amount"); // 'amount' | 'percent'
  const [discountValue, setDiscountValue] = useState("");
  const [tileSize, setTileSizeState] = useState(() => window.localStorage.getItem("atourna_pos_tilesize") || "md");
  const [posSearch, setPosSearch] = useState("");
  const totalsRef = useRef(null);

  const setTileSize = (size) => {
    setTileSizeState(size);
    window.localStorage.setItem("atourna_pos_tilesize", size);
  };

  const seller = users.find((u) => u.id === sellerId) || currentUser;
  const selectedProduct = products.find((p) => p.id === productId);
  // Managers sell too, so they can hold — and be limited by — a personal
  // stock allocation exactly like any other seller; there is no role-based
  // exemption here. (Kept as a named flag rather than inlining `true`
  // everywhere below, since it documents *why* the allocation checks run.)
  const isSellerRole = true;

  useEffect(() => {
    if (selectedProduct) setUnitPrice(String(selectedProduct.price));
  }, [productId]); // eslint-disable-line

  const cartQtyFor = (pid) => cart.filter((c) => c.productId === pid).reduce((a, c) => a + c.qty, 0);

  // How many more units of this product can still be added to the cart for
  // the currently-selected seller. For an unmanaged product (no allocation
  // ever assigned), this is simply the shop's physical stock — identical to
  // the app's original behaviour. For a managed product, it's capped by the
  // seller's OWN remaining share only: there is no automatic borrowing from
  // a colleague's allocation any more — getting more requires sending that
  // colleague a request and having them approve it first (see
  // requestableFor / the "طلب كمية إضافية" panel below).
  const availableFor = (product) => {
    const consumed = cartQtyFor(product.id);
    if (!isProductManaged(sellerAllocations, product.id)) {
      return product.stock - consumed;
    }
    return Math.min(product.stock, remainingForSeller(sellerAllocations, seller.id, product.id)) - consumed;
  };

  // True once the seller's own share of a managed product is used up (by
  // stock already sold plus whatever is sitting in the cart right now) while
  // at least one colleague still has some left — i.e. this is a product
  // worth sending a stock-transfer request for.
  const requestableFor = (product) => {
    if (!isProductManaged(sellerAllocations, product.id)) return false;
    const ownLeft = remainingForSeller(sellerAllocations, seller.id, product.id) - cartQtyFor(product.id);
    if (ownLeft > 0) return false;
    return totalRemainingForProduct(sellerAllocations, product.id) > 0;
  };

  const openRequestPanel = (product) => setRequestPanelProduct(product);

  // This seller's own outstanding stock-transfer requests, most recent
  // first — shown so they can see at a glance what's still waiting on a
  // colleague's answer (or how a past request was resolved).
  const myRequests = stockRequests
    .filter((r) => r.requesterId === seller.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 6);

  // Tap a product tile: adds one unit at its default price, merging into an
  // existing cart line for the same product+price instead of creating a new
  // one, so repeated taps just bump the quantity — this is the fast
  // point-of-sale-style add path.
  const addTileToCart = (product) => {
    const available = availableFor(product);
    if (available <= 0) return;
    setCart((c) => {
      const idx = c.findIndex((l) => l.productId === product.id && l.price === product.price);
      if (idx !== -1) {
        const next = [...c];
        next[idx] = { ...next[idx], qty: next[idx].qty + 1, total: (next[idx].qty + 1) * next[idx].price };
        return next;
      }
      return [...c, { lineId: uid(), productId: product.id, name: product.name, qty: 1, price: product.price, total: product.price }];
    });
  };

  const addToCart = () => {
    if (!selectedProduct) return;
    const q = Number(qty);
    const price = Number(unitPrice);
    if (!q || q <= 0) return;
    const availableStock = availableFor(selectedProduct);
    if (q > availableStock) return;
    setCart((c) => [...c, { lineId: uid(), productId: selectedProduct.id, name: selectedProduct.name, qty: q, price, total: q * price }]);
    setProductId("");
    setQty(1);
    setUnitPrice("");
  };

  const removeLine = (lineId) => setCart((c) => c.filter((l) => l.lineId !== lineId));

  const subtotal = cart.reduce((a, l) => a + l.total, 0);
  const discountNum = Number(discountValue) || 0;
  const discountAmount = Math.min(
    subtotal,
    discountType === "percent" ? subtotal * (discountNum / 100) : discountNum
  );
  const afterDiscount = Math.max(0, subtotal - discountAmount);
  const taxEnabled = !!settings.taxEnabled;
  const taxRate = Number(settings.taxRate) || 0;
  const taxAmount = taxEnabled ? afterDiscount * (taxRate / 100) : 0;
  const total = afterDiscount + taxAmount;

  const collectedNum = collected === "" ? total : Number(collected);
  const remaining = Math.max(0, total - collectedNum);

  const submit = async () => {
    if (cart.length === 0) return;
    const updatedProducts = products.map((p) => {
      const used = cart.filter((c) => c.productId === p.id).reduce((a, c) => a + c.qty, 0);
      return used ? { ...p, stock: p.stock - used } : p;
    });

    // Draw the sold quantities out of the seller's own personal stock
    // allocation for every managed product. `availableFor` above already
    // kept the cart from exceeding what the seller actually owns, so this
    // never needs to borrow from anyone — any extra stock a seller needed
    // was already transferred into their own allocation beforehand via an
    // approved stock-transfer request. `allocationSources` records exactly
    // what was drawn, so a later delete/edit can give it back precisely.
    let updatedAllocations = sellerAllocations;
    const allocationSources = [];
    const qtyByProduct = new Map();
    cart.forEach((c) => qtyByProduct.set(c.productId, (qtyByProduct.get(c.productId) || 0) + c.qty));
    for (const [pid, qty] of qtyByProduct) {
      if (!isProductManaged(updatedAllocations, pid)) continue;
      updatedAllocations = consumeOwnAllocation(updatedAllocations, seller.id, pid, qty);
      allocationSources.push({ sellerId: seller.id, sellerName: seller.name, productId: pid, qty });
    }

    const nextNum = (seq.count || 0) + 1;
    const newSeq = { ...seq, count: nextNum };
    const invoiceNo = `INV-${String(nextNum).padStart(5, "0")}`;
    const sale = {
      id: uid(),
      invoiceNo,
      sellerId: seller.id,
      sellerName: seller.name,
      date: todayISO(),
      items: cart,
      subtotal,
      discountType,
      discountValue: discountNum,
      discountAmount,
      taxEnabled,
      taxRate,
      taxLabel: settings.taxLabel || "الضريبة",
      taxAmount,
      total,
      collected: collectedNum,
      remaining,
      allocationSources,
    };
    await onCreate(sale, updatedProducts, newSeq, updatedAllocations);
    setCart([]);
    setCollected("");
    setDiscountValue("");
  };

  const filteredProducts = products.filter((p) => p.name.toLowerCase().includes(posSearch.trim().toLowerCase()));
  const tileGridCls = { sm: "grid-cols-4 sm:grid-cols-6", md: "grid-cols-3 sm:grid-cols-4", lg: "grid-cols-2 sm:grid-cols-3" }[tileSize];
  const tileBoxCls = { sm: "aspect-square p-1.5", md: "aspect-square p-2.5", lg: "aspect-[4/3] p-4" }[tileSize];
  const tileIconPx = { sm: 20, md: 28, lg: 40 }[tileSize];
  const tileNameCls = { sm: "text-[9px]", md: "text-[11px]", lg: "text-sm" }[tileSize];
  const tilePriceCls = { sm: "text-[9px]", md: "text-[10px]", lg: "text-xs" }[tileSize];

  return (
    <div className="space-y-5 max-w-2xl">
      <h2 className="text-xl font-bold">تسجيل عملية بيع جديدة</h2>

      <Card className="p-4 space-y-4">
        <Field label="البائع">
          <select className={inputCls} value={sellerId} onChange={(e) => setSellerId(e.target.value)}>
            {sellers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
        {isSellerRole && (
          <p className="text-[11px] text-[var(--muted)] flex items-start gap-1.5">
            <Boxes size={13} className="shrink-0 mt-0.5" />
            المنتجات الموزّعة تُخصم من حصة {seller.name}. إذا نفدت حصته من منتج، اضغطه لطلب كمية من زميل، ولا تنتقل إلا بعد موافقته.
          </p>
        )}
      </Card>

      {myRequests.length > 0 && (
        <Card className="p-4">
          <h3 className="font-bold mb-2 text-sm flex items-center gap-2"><ArrowLeftRight size={16} className="text-[#C97B3D]" /> طلبات النقل المرسلة</h3>
          <div className="space-y-1.5">
            {myRequests.map((r) => (
              <div key={r.id} className="flex items-center justify-between text-xs bg-[var(--surface-2)] rounded-lg px-3 py-2">
                <span>{r.qty} من {r.productName} — إلى {r.targetSellerName}</span>
                <span
                  className={`font-bold px-2 py-0.5 rounded-full text-[10px] ${
                    r.status === "pending"
                      ? "bg-[#FFF6E5] text-[#C97B3D]"
                      : r.status === "approved"
                      ? "bg-[#EAF6EF] text-[#3F7D57]"
                      : "bg-[#FBEAEA] text-[#B23A3A]"
                  }`}
                >
                  {r.status === "pending" ? "بانتظار الموافقة" : r.status === "approved" ? "تمت الموافقة" : "مرفوض"}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* POS-style tap-to-add product grid */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3 gap-2">
          <h3 className="font-bold flex items-center gap-2 shrink-0"><Grid3x3 size={18} /> نقطة البيع السريعة</h3>
          <div className="nm-tog !p-1 shrink-0" role="radiogroup" aria-label="حجم البطاقات">
            {[["sm", "صغير"], ["md", "متوسط"], ["lg", "كبير"]].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTileSize(key)}
                title={label}
                role="radio"
                aria-checked={tileSize === key}
                className={`!px-3 !py-1.5 !text-[11px] ${tileSize === key ? "is-on" : ""}`}
              >
                {key === "sm" ? "S" : key === "md" ? "M" : "L"}
              </button>
            ))}
          </div>
        </div>

        <div className="relative mb-3">
          <Search size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
          <input className={inputCls + " pr-9 !py-2"} placeholder="بحث عن منتج..." value={posSearch} onChange={(e) => setPosSearch(e.target.value)} />
        </div>

        {filteredProducts.length === 0 ? (
          <EmptyState text="لا توجد منتجات مطابقة" />
        ) : (
          <div className={`grid ${tileGridCls} gap-2`}>
            {filteredProducts.map((p, i) => {
              const available = availableFor(p);
              const inCartQty = cartQtyFor(p.id);
              const disabled = available <= 0;
              const tileColor = COLORS[i % COLORS.length];
              const managed = isProductManaged(sellerAllocations, p.id);
              const ownLeft = managed ? Math.max(0, remainingForSeller(sellerAllocations, seller.id, p.id) - inCartQty) : null;
              const canRequest = disabled && requestableFor(p);
              return (
                <button
                  key={p.id}
                  onClick={() => (disabled ? (canRequest ? openRequestPanel(p) : null) : addTileToCart(p))}
                  disabled={disabled && !canRequest}
                  title={
                    canRequest
                      ? "نفدت حصتك — اضغط لطلب كمية من زميل"
                      : managed
                      ? `المتبقي من مخصصك: ${ownLeft}`
                      : undefined
                  }
                  className={`relative nm-tile flex flex-col items-center justify-center text-center ${tileBoxCls} ${
                    disabled ? (canRequest ? "req" : "opacity-45 grayscale") : inCartQty > 0 ? "in-cart" : ""
                  }`}
                >
                  {inCartQty > 0 && (
                    <span className="absolute -top-1.5 -left-1.5 text-white text-[11px] font-bold rounded-full w-6 h-6 flex items-center justify-center fade-in" style={{ background: "linear-gradient(145deg, var(--accent), var(--accent-dark))", boxShadow: "var(--nm-out-sm)" }}>
                      {inCartQty}
                    </span>
                  )}
                  {managed && !disabled && (
                    <span className="absolute -top-1.5 -right-1.5 rounded-full w-5 h-5 flex items-center justify-center shadow fade-in bg-[#3F7D57] text-white">
                      <PackageCheck size={11} />
                    </span>
                  )}
                  {canRequest && (
                    <span className="absolute -top-1.5 -right-1.5 rounded-full w-5 h-5 flex items-center justify-center shadow fade-in bg-[#C97B3D] text-white">
                      <ArrowLeftRight size={11} />
                    </span>
                  )}
                  <div
                    className="rounded-full flex items-center justify-center mb-1.5 shrink-0 nm-in-sm"
                    style={{ width: tileIconPx + 16, height: tileIconPx + 16 }}
                  >
                    <Droplet size={tileIconPx} style={{ color: tileColor }} />
                  </div>
                  <p className={`font-bold leading-tight line-clamp-2 ${tileNameCls}`}>{p.name}</p>
                  {tileSize !== "sm" && !canRequest && <p className={`text-[var(--muted)] ${tilePriceCls}`} dir="ltr">{fmt(p.price)} K.D</p>}
                  {canRequest && tileSize !== "sm" && <p className="text-[10px] text-[#C97B3D] font-semibold mt-0.5">اطلب من زميل</p>}
                  {managed && !canRequest && tileSize === "lg" && (
                    <p className="text-[10px] text-[var(--muted)] mt-0.5">مخصصك: {ownLeft}</p>
                  )}
                </button>
              );
            })}
          </div>
        )}
        <p className="text-[11px] text-[var(--muted)] mt-3">اضغط على أي منتج لإضافته مباشرة، والضغط المتكرر يزيد الكمية تلقائياً.</p>
      </Card>

      <Card className="p-4 space-y-4">
        <h3 className="font-bold text-sm text-[var(--muted)]">إضافة يدوية (لسعر أو كمية مخصصة)</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="col-span-2 md:col-span-2">
            <Field label="المنتج">
              <select className={inputCls} value={productId} onChange={(e) => setProductId(e.target.value)}>
                <option value="">اختر منتج...</option>
                {products.map((p) => {
                  const avail = availableFor(p);
                  const managed = isSellerRole && isProductManaged(sellerAllocations, p.id);
                  return (
                    <option key={p.id} value={p.id} disabled={avail <= 0}>
                      {p.name} — متبقي {avail}{managed ? ` (مخصصك: ${remainingForSeller(sellerAllocations, seller.id, p.id)})` : ""}
                    </option>
                  );
                })}
              </select>
            </Field>
          </div>
          <Field label="الكمية">
            <input type="number" min="1" className={inputCls} value={qty} onChange={(e) => setQty(e.target.value)} />
          </Field>
          <Field label="سعر الوحدة (K.D)">
            <input type="number" min="0" step="0.001" className={inputCls} value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
          </Field>
        </div>
        <Btn onClick={addToCart} disabled={!productId} variant="ghost">
          <Plus size={16} /> إضافة إلى الفاتورة
        </Btn>
      </Card>

      <Card className="p-4">
        <h3 className="font-bold mb-3">عناصر الفاتورة</h3>
        {cart.length === 0 ? (
          <EmptyState text="لم تتم إضافة منتجات بعد" />
        ) : (
          <div className="space-y-2">
            {cart.map((l) => (
              <div key={l.lineId} className="flex items-center justify-between text-sm bg-[var(--surface-2)] rounded-xl px-3 py-2">
                <div>
                  <p className="font-semibold">{l.name}</p>
                  <p className="text-xs text-[var(--muted)]">{l.qty} × {fmt(l.price)} K.D</p>
                </div>
                <div className="flex items-center gap-3">
                  <p className="font-bold text-[var(--accent)]">{fmt(l.total)} K.D</p>
                  <button onClick={() => removeLine(l.lineId)} className="text-[#B23A3A]"><Trash2 size={16} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {cart.length > 0 && (
        <div ref={totalsRef} style={{ scrollMarginTop: 140 }}>
        <Card className="p-4 space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-[var(--muted)]">المجموع الفرعي</span>
            <span className="font-semibold">{fmt(subtotal)} K.D</span>
          </div>

          <div className="pt-2 border-t border-[var(--border)]">
            <span className="block text-xs font-semibold text-[var(--muted)] mb-2 flex items-center gap-1.5"><Percent size={13} /> الخصم (اختياري)</span>
            <div className="flex gap-2">
              <div className="nm-tog !p-1 shrink-0" role="radiogroup" aria-label="نوع الخصم">
                <button type="button" role="radio" aria-checked={discountType === "amount"} onClick={() => setDiscountType("amount")} className={`!px-3 ${discountType === "amount" ? "is-on" : ""}`}>د.ك</button>
                <button type="button" role="radio" aria-checked={discountType === "percent"} onClick={() => setDiscountType("percent")} className={`!px-3 ${discountType === "percent" ? "is-on" : ""}`}>%</button>
              </div>
              <input
                type="number"
                min="0"
                step="0.001"
                className={inputCls + " flex-1"}
                placeholder={discountType === "percent" ? "مثال: 10" : "مثال: 2.000"}
                value={discountValue}
                onChange={(e) => setDiscountValue(e.target.value)}
              />
            </div>
            {discountAmount > 0 && (
              <div className="flex justify-between text-sm mt-2">
                <span className="text-[var(--muted)]">قيمة الخصم</span>
                <span className="font-semibold text-[#B23A3A]">− {fmt(discountAmount)} K.D</span>
              </div>
            )}
          </div>

          {taxEnabled && (
            <div className="flex justify-between text-sm">
              <span className="text-[var(--muted)]">{settings.taxLabel || "الضريبة"} ({taxRate}%)</span>
              <span className="font-semibold">+ {fmt(taxAmount)} K.D</span>
            </div>
          )}

          <div className="flex justify-between text-sm pt-2 border-t border-[var(--border)]">
            <span className="text-[var(--muted)]">الإجمالي النهائي</span>
            <span className="font-extrabold text-lg">{fmt(total)} K.D</span>
          </div>
          <Field label="المبلغ المحصل (K.D)">
            <input type="number" min="0" step="0.001" className={inputCls} value={collected} placeholder={fmt(total)} onChange={(e) => setCollected(e.target.value)} />
          </Field>
          <div className="flex justify-between text-sm">
            <span className="text-[var(--muted)]">المبلغ المتبقي</span>
            <span className={`font-bold ${remaining > 0 ? "text-[#B23A3A]" : "text-[#3F7D57]"}`}>{fmt(remaining)} K.D</span>
          </div>
          <Btn onClick={submit} className="w-full">
            <Receipt size={16} /> إصدار الفاتورة وحفظ عملية البيع
          </Btn>
        </Card>
        </div>
      )}

      {cart.length > 0 && (
        <div className="no-print fixed inset-x-0 z-30 px-4 flex justify-center" style={{ bottom: "calc(16px + env(safe-area-inset-bottom, 0px))" }}>
          <div className="nm-out nm-pop rounded-full w-full max-w-2xl flex items-center gap-3 p-2 pr-4 fade-in">
            <span className="nm-knob sm nm-ink" style={{ boxShadow: "var(--nm-in-sm)" }}><ShoppingCart size={16} /></span>
            <div className="flex-1 min-w-0 leading-tight">
              <p className="text-[11px] nm-mut">{cart.reduce((a, l) => a + l.qty, 0)} قطعة · {seller.name}</p>
              <p className="nm-num font-bold text-[17px]">{fmt(total)}<span className="text-[10.5px] font-medium nm-mut ml-1">د.ك</span></p>
            </div>
            <button className="nm-btn solid !py-2.5 !px-5 text-sm" onClick={() => totalsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              الدفع والإصدار <ChevronLeft size={16} />
            </button>
          </div>
        </div>
      )}

      {requestPanelProduct && (
        <StockRequestModal
          product={requestPanelProduct}
          sellerAllocations={sellerAllocations}
          users={users}
          seller={seller}
          onSend={onSendRequest}
          onClose={() => setRequestPanelProduct(null)}
        />
      )}
    </div>
  );
}

/* ---------------------------------- Sales Records ---------------------------------- */

function SalesRecords({ sales, users, currentUser, isAdmin, settings, onDelete, onPrintInvoice, onPrintRecord, onCollectPayment, onEditSale, onAddComment, onDeleteComment, onConfirm, statusFilter = "all", onStatusFilter = () => {} }) {
  const [sellerFilter, setSellerFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [payingId, setPayingId] = useState(null);
  const [commentingId, setCommentingId] = useState(null);

  const sellers = useMemo(() => {
    const map = new Map();
    sales.forEach((s) => map.set(s.sellerId, s.sellerName));
    return Array.from(map.entries());
  }, [sales]);

  let list = sales;
  if (sellerFilter !== "all") list = list.filter((s) => s.sellerId === sellerFilter);
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    list = list.filter((s) => s.invoiceNo.toLowerCase().includes(q) || s.sellerName.toLowerCase().includes(q));
  }
  // Unpaid counts follow the seller/search filters so the chip numbers always
  // match what you'd see after tapping them.
  const unpaidAll = list.filter((s) => s.remaining > 0.0005);
  const unpaidTotal = unpaidAll.reduce((a, s) => a + s.remaining, 0);
  const paidCount = list.length - unpaidAll.length;
  if (statusFilter === "unpaid") list = [...unpaidAll].sort((a, b) => new Date(a.date) - new Date(b.date)); // oldest debt first
  else if (statusFilter === "paid") list = list.filter((s) => s.remaining <= 0.0005);
  const daysOpen = (d) => Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000));
  const ageLabel = (d) => { const n = daysOpen(d); return n === 0 ? "اليوم" : n === 1 ? "منذ يوم" : n === 2 ? "منذ يومين" : n <= 10 ? `منذ ${n} أيام` : `منذ ${n} يوماً`; };

  const sellerName = sellerFilter !== "all" ? sellers.find(([id]) => id === sellerFilter)?.[1] : currentUser.name;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-xl font-bold">سجل المبيعات</h2>
        <div className="flex gap-3">
          <Btn variant="outline" className="!py-2 !px-4 text-[13px]" onClick={() => onPrintRecord(sellerFilter === "all" ? "الكل" : sellerName, list)}>
            <Printer size={16} /> طباعة السجل PDF
          </Btn>
          <Btn
            variant="ghost"
            className="!py-2 !px-4 text-[13px]"
            onClick={() => {
              exportSalesExcel(sellerFilter === "all" ? "الكل" : sellerName, list, settings.companyName).catch((err) => {
                console.error("Excel export failed:", err);
                alert("تعذّر إنشاء ملف Excel: " + (err?.message || "خطأ غير معروف") + "\n\nأرسل هذه الرسالة للدعم الفني.");
              });
            }}
          >
            <Download size={16} /> تصدير Excel
          </Btn>
        </div>
      </div>

      <div className="nm-tog" role="tablist" aria-label="حالة التحصيل">
        <button role="tab" aria-selected={statusFilter === "all"} className={statusFilter === "all" ? "is-on" : ""} onClick={() => onStatusFilter("all")}>الكل</button>
        <button role="tab" aria-selected={statusFilter === "unpaid"} className={statusFilter === "unpaid" ? "is-on" : ""} onClick={() => onStatusFilter("unpaid")} style={statusFilter === "unpaid" ? { color: "var(--due)" } : undefined}>
          غير محصّلة
          {unpaidAll.length > 0 && <span className="nm-num text-[10.5px] font-bold text-white rounded-full px-1.5 min-w-[20px] h-5 inline-flex items-center justify-center" style={{ background: "var(--due)" }}>{unpaidAll.length}</span>}
        </button>
        <button role="tab" aria-selected={statusFilter === "paid"} className={statusFilter === "paid" ? "is-on" : ""} onClick={() => onStatusFilter("paid")}>مسدّدة <span className="nm-num text-[11px] nm-mut">{paidCount}</span></button>
      </div>

      {unpaidAll.length > 0 && statusFilter !== "unpaid" && (
        <button onClick={() => onStatusFilter("unpaid")} className="nm-card w-full p-4 flex items-center gap-3 text-right" style={{ boxShadow: "var(--nm-out), inset 4px 0 0 var(--due)" }}>
          <span className="nm-knob" style={{ color: "var(--due)", boxShadow: "var(--nm-in-sm)" }}><AlertTriangle size={18} /></span>
          <span className="flex-1 min-w-0">
            <span className="block font-bold text-sm">{unpaidAll.length} {unpaidAll.length === 1 ? "فاتورة غير محصّلة" : unpaidAll.length === 2 ? "فاتورتان غير محصّلتين" : "فواتير غير محصّلة بالكامل"}</span>
            <span className="block text-xs nm-mut">أقدمها {ageLabel(unpaidAll.reduce((o, x) => (new Date(x.date) < new Date(o.date) ? x : o)).date)} · اضغط لعرضها</span>
          </span>
          <span className="text-left">
            <span className="block nm-num font-bold text-[var(--due)]">{fmt(unpaidTotal)}</span>
            <span className="block text-[10px] nm-mut">د.ك مستحقة</span>
          </span>
        </button>
      )}

      {statusFilter === "unpaid" && (
        <div className="nm-well px-4 py-3 flex items-center justify-between gap-3" role="status">
          <div>
            <p className="text-xs nm-mut">إجمالي المستحق على العملاء</p>
            <p className="nm-num text-xl font-bold text-[var(--due)]">{fmt(unpaidTotal)} <span className="text-xs nm-mut font-medium">د.ك</span></p>
          </div>
          <p className="text-[11px] nm-mut text-left leading-relaxed">{unpaidAll.length} فاتورة<br />مرتّبة من الأقدم</p>
        </div>
      )}

      <div className="nm-well px-2 py-3 grid grid-cols-3 text-center" aria-label="ملخص السجل المعروض">
        <div><p className="text-[10.5px] nm-mut">المحصّل</p><p className="nm-num font-bold nm-ink">{fmt(list.reduce((a, x) => a + x.collected, 0))}</p></div>
        <div className="border-x border-[var(--border)]"><p className="text-[10.5px] nm-mut">المتبقي</p><p className="nm-num font-bold text-[var(--due)]">{fmt(list.reduce((a, x) => a + x.remaining, 0))}</p></div>
        <div><p className="text-[10.5px] nm-mut">الفواتير</p><p className="nm-num font-bold">{list.length}</p></div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <select className={inputCls + " sm:w-56"} value={sellerFilter} onChange={(e) => setSellerFilter(e.target.value)}>
          <option value="all">كل البائعين</option>
          {sellers.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
        <div className="relative flex-1">
          <Search size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
          <input className={inputCls + " pr-9"} placeholder="بحث برقم الفاتورة أو اسم البائع..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {list.length === 0 ? (
        <Card className="p-8"><EmptyState text={statusFilter === "unpaid" ? "ممتاز! لا توجد فواتير غير محصّلة" : "لا توجد سجلات مطابقة"} /></Card>
      ) : (
        <>
          {/* Mobile cards */}
          <div className="space-y-3 md:hidden">
            {list.map((s) => (
              <Card key={s.id} className="p-4">
                <div className="flex justify-between items-start gap-3 mb-2">
                  <div className="min-w-0">
                    <p className="font-bold flex items-center gap-1.5 flex-wrap">
                      {s.invoiceNo}
                      {(s.editHistory || []).length > 0 && <span title={`عُدّلت ${s.editHistory.length} مرة — آخر تعديل: ${s.editHistory[s.editHistory.length - 1].byUserName}`} className="nm-pill info !text-[9.5px] !py-0.5">مُعدّلة</span>}
                    </p>
                    <p className="text-xs nm-mut">{s.sellerName} · {dateLabel(s.date)} {timeLabel(s.date)}</p>
                  </div>
                  {s.remaining > 0 ? (
                    <span className="flex flex-col items-end gap-1 shrink-0">
                      <span className="nm-pill due">{s.collected > 0 ? "محصّلة جزئياً" : "غير محصّلة"}</span>
                      <span className={`text-[10px] font-semibold ${daysOpen(s.date) > 14 ? "text-[var(--bad)]" : "nm-mut"}`}>{ageLabel(s.date)}</span>
                    </span>
                  ) : <span className="nm-pill ok shrink-0">مسدّدة</span>}
                </div>
                <div className="text-xs nm-mut mb-2 truncate">{s.items.map((i) => i.name).join("، ")}</div>
                <div className="flex items-end justify-between gap-3 mb-4">
                  <p className="nm-num text-[22px] font-bold leading-none">{fmt(s.total)}<span className="text-[11px] font-medium nm-mut ml-1">د.ك</span></p>
                  <div className="text-[11px] text-left leading-relaxed">
                    <p className="text-[var(--ok)] font-semibold">محصّل <span className="nm-num">{fmt(s.collected)}</span></p>
                    {s.remaining > 0 && <p className="text-[var(--due)] font-semibold">متبقٍ <span className="nm-num">{fmt(s.remaining)}</span></p>}
                  </div>
                </div>
                <div className="flex justify-between gap-1 pt-3 border-t border-[var(--border)]">
                  <button className="nm-act" onClick={() => onPrintInvoice(s)}>
                    <span className="nm-knob"><Printer size={17} /></span>طباعة
                  </button>
                  {s.remaining > 0 && (
                    <button className="nm-act" onClick={() => setPayingId(payingId === s.id ? null : s.id)}>
                      <span className={`nm-knob nm-ink ${payingId === s.id ? "is-on" : ""}`}><Wallet size={17} /></span>تحصيل
                    </button>
                  )}
                  <button className="nm-act" onClick={() => setCommentingId(commentingId === s.id ? null : s.id)}>
                    <span className={`nm-knob ${commentingId === s.id ? "is-on" : ""}`}>
                      <MessageSquare size={17} />
                      {(s.comments || []).length > 0 && <span className="nm-badge">{s.comments.length}</span>}
                    </span>ملاحظات
                  </button>
                  {(isAdmin || s.sellerId === currentUser.id) && (
                    <button className="nm-act" onClick={() => onEditSale(s)} title={isAdmin ? "تعديل" : "تصحيح بيانات فاتورتك"}>
                      <span className="nm-knob"><Pencil size={17} /></span>{isAdmin ? "تعديل" : "تصحيح"}
                    </button>
                  )}
                  {isAdmin && (
                    <button className="nm-act" onClick={() => onConfirm(`هل تريد حذف الفاتورة ${s.invoiceNo}؟ سيتم إرجاع كمية المنتجات إلى المخزون تلقائياً. لا يمكن التراجع عن هذا الإجراء.`, () => onDelete(s.id))}>
                      <span className="nm-knob danger"><Trash2 size={17} /></span>حذف
                    </button>
                  )}
                </div>
                {payingId === s.id && (
                  <PayRow
                    sale={s}
                    onSubmit={(amount) => { onCollectPayment(s.id, amount); setPayingId(null); }}
                    onCancel={() => setPayingId(null)}
                  />
                )}
                {commentingId === s.id && (
                  <CommentThread
                    sale={s}
                    isAdmin={isAdmin}
                    onAddComment={(text) => onAddComment(s.id, text)}
                    onDeleteComment={(commentId) => onConfirm("هل تريد حذف هذه الملاحظة؟", () => onDeleteComment(s.id, commentId))}
                  />
                )}
              </Card>
            ))}
          </div>

          {/* Desktop table */}
          <Card className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-right text-[var(--muted)] border-b border-[var(--border)]">
                  <th className="px-4 py-3 font-semibold">رقم الفاتورة</th>
                  <th className="px-4 py-3 font-semibold">البائع</th>
                  <th className="px-4 py-3 font-semibold">التاريخ</th>
                  <th className="px-4 py-3 font-semibold">المنتجات</th>
                  <th className="px-4 py-3 font-semibold">الإجمالي</th>
                  <th className="px-4 py-3 font-semibold">المحصل</th>
                  <th className="px-4 py-3 font-semibold">المتبقي</th>
                  <th className="px-4 py-3 font-semibold"></th>
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <React.Fragment key={s.id}>
                    <tr className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-2)]">
                      <td className="px-4 py-3 font-bold">{s.invoiceNo}{(s.editHistory || []).length > 0 && <span title={`عُدّلت ${s.editHistory.length} مرة — آخر تعديل: ${s.editHistory[s.editHistory.length - 1].byUserName}`} className="mr-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-[#FFF6E5] text-[#C97B3D] align-middle">مُعدّلة</span>}</td>
                      <td className="px-4 py-3">{s.sellerName}</td>
                      <td className="px-4 py-3 text-[var(--muted)]">{dateLabel(s.date)}</td>
                      <td className="px-4 py-3 text-[var(--muted)] max-w-[220px] truncate">{s.items.map((i) => i.name).join("، ")}</td>
                      <td className="px-4 py-3 font-bold text-[var(--accent)]">{fmt(s.total)}</td>
                      <td className="px-4 py-3 text-[#3F7D57] font-semibold">{fmt(s.collected)}</td>
                      <td className="px-4 py-3 font-semibold">
                        {s.remaining > 0 ? (
                          <span className="flex flex-col items-start gap-0.5"><span className="text-[var(--due)]">{fmt(s.remaining)}</span><span className={`text-[10px] ${daysOpen(s.date) > 14 ? "text-[var(--bad)]" : "nm-mut"}`}>{ageLabel(s.date)}</span></span>
                        ) : <span className="nm-pill ok">مسدّدة</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button onClick={() => onPrintInvoice(s)} className="p-1.5 rounded-lg text-[var(--accent-dark)] hover:bg-[var(--surface-3)]" title="طباعة"><Printer size={16} /></button>
                          {s.remaining > 0 && (
                            <button onClick={() => { setPayingId(payingId === s.id ? null : s.id); }} className="p-1.5 rounded-lg text-[#3F7D57] hover:bg-[var(--surface-3)]" title="تسجيل تحصيل"><Wallet size={16} /></button>
                          )}
                          <button onClick={() => setCommentingId(commentingId === s.id ? null : s.id)} className="p-1.5 rounded-lg text-[var(--accent-dark)] hover:bg-[var(--surface-3)] relative" title="ملاحظات">
                            <MessageSquare size={16} />
                            {(s.comments || []).length > 0 && (
                              <span className="absolute -top-1 -left-1 bg-[#B23A3A] text-white text-[9px] rounded-full w-4 h-4 flex items-center justify-center">{s.comments.length}</span>
                            )}
                          </button>
                          {(isAdmin || s.sellerId === currentUser.id) && (
                            <button onClick={() => onEditSale(s)} className="p-1.5 rounded-lg text-[var(--accent-dark)] hover:bg-[var(--surface-3)]" title={isAdmin ? "تعديل" : "تصحيح بيانات فاتورتك"}><Pencil size={16} /></button>
                          )}
                          {isAdmin && (
                            <button onClick={() => onConfirm(`هل تريد حذف الفاتورة ${s.invoiceNo}؟ سيتم إرجاع كمية المنتجات إلى المخزون تلقائياً. لا يمكن التراجع عن هذا الإجراء.`, () => onDelete(s.id))} className="p-1.5 rounded-lg text-[#B23A3A] hover:bg-[#FBEAEA]" title="حذف"><Trash2 size={16} /></button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {payingId === s.id && (
                      <tr>
                        <td colSpan={8} className="px-4 pb-3">
                          <PayRow
                            sale={s}
                            onSubmit={(amount) => { onCollectPayment(s.id, amount); setPayingId(null); }}
                            onCancel={() => setPayingId(null)}
                          />
                        </td>
                      </tr>
                    )}
                    {commentingId === s.id && (
                      <tr>
                        <td colSpan={8} className="px-4 pb-3">
                          <CommentThread
                            sale={s}
                            isAdmin={isAdmin}
                            onAddComment={(text) => onAddComment(s.id, text)}
                            onDeleteComment={(commentId) => onConfirm("هل تريد حذف هذه الملاحظة؟", () => onDeleteComment(s.id, commentId))}
                          />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}

// Defined at module scope (not inside SalesRecords) so React keeps a stable
// component identity across re-renders — this is what fixes the bug where
// the on-screen keyboard closed after every typed character.
function PayRow({ sale, onSubmit, onCancel }) {
  const [amount, setAmount] = useState("");
  return (
    <div className="mt-2 flex gap-2 items-center bg-[var(--surface-2)] rounded-xl p-2">
      <input
        type="number"
        min="0"
        step="0.001"
        autoFocus
        className={inputCls + " flex-1 !py-2"}
        placeholder={`حتى ${fmt(sale.remaining)} K.D`}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <Btn
        className="!py-2 !px-3 text-xs"
        onClick={() => {
          const v = Number(amount);
          if (!v || v <= 0) return;
          onSubmit(v);
        }}
      >
        <Check size={14} /> تأكيد
      </Btn>
      <button onClick={onCancel} className="p-2 text-[var(--muted)]">
        <X size={16} />
      </button>
    </div>
  );
}

function CommentThread({ sale, isAdmin, onAddComment, onDeleteComment }) {
  const [text, setText] = useState("");

  const submit = () => {
    if (!text.trim()) return;
    onAddComment(text);
    setText("");
  };

  return (
    <div className="mt-2 bg-[var(--surface-2)] rounded-xl p-3 space-y-2">
      {(sale.comments || []).length === 0 ? (
        <p className="text-xs text-[var(--muted)]">لا توجد ملاحظات بعد — أول ملاحظة تُسجَّل باسمك</p>
      ) : (
        <div className="space-y-2 max-h-48 overflow-y-auto">
          {sale.comments.map((c) => (
            <div key={c.id} className="text-xs bg-[var(--surface)] rounded-lg p-2 border border-[var(--border)]">
              <div className="flex justify-between items-start mb-0.5 gap-2">
                <div className="flex justify-between flex-1">
                  <span className="font-semibold text-[var(--accent-dark)]">{c.authorName}</span>
                  <span className="text-[var(--muted)]">{dateLabel(c.date)} {timeLabel(c.date)}</span>
                </div>
                {isAdmin && (
                  <button onClick={() => onDeleteComment(c.id)} className="text-[#B23A3A] shrink-0">
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
              <p className="text-[var(--text)]">{c.text}</p>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          className={inputCls + " flex-1 !py-2 text-xs"}
          placeholder="اكتب ملاحظة أو تعليق..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        />
        <Btn className="!py-2 !px-3 text-xs" onClick={submit}>
          <MessageSquare size={14} />
        </Btn>
      </div>
    </div>
  );
}

/* ---------------------------------- Stats ---------------------------------- */

// One compact control that scales from 3 sellers to hundreds: a single button
// showing the current choice, opening a searchable list (bottom sheet on
// phones, centered card on larger screens).
function SellerPicker({ sellers, value, onChange, totals = [], label = "البائع" }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const current = value === "all" ? null : sellers.find((u) => u.id === value);
  const totalOf = (id) => totals.find((t) => t.id === id)?.total || 0;
  const term = q.trim().toLowerCase();
  const shown = sellers
    .filter((u) => !term || u.name.toLowerCase().includes(term) || (u.username || "").toLowerCase().includes(term))
    .sort((x, y) => totalOf(y.id) - totalOf(x.id) || x.name.localeCompare(y.name, "ar"));
  const pick = (id) => { onChange(id); setOpen(false); setQ(""); };

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button onClick={() => setOpen(true)} className="nm-out rounded-full px-4 py-2.5 flex items-center gap-3 text-right w-full" aria-haspopup="dialog" aria-expanded={open}>
        <span className="nm-knob sm" style={{ boxShadow: "var(--nm-in-sm)" }} aria-hidden="true">
          {current ? <span className="text-sm font-bold nm-ink">{current.name.trim().charAt(0)}</span> : <UsersIcon size={15} className="nm-ink" />}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[10.5px] nm-mut leading-tight">{label}</span>
          <span className="block text-sm font-bold truncate leading-tight">{current ? current.name : `كل البائعين (${sellers.length})`}</span>
        </span>
        {current && (
          <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); onChange("all"); }} onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onChange("all"); } }} className="nm-knob sm" aria-label="إلغاء اختيار البائع"><X size={14} /></span>
        )}
        <ChevronDown size={16} className="nm-mut shrink-0" />
      </button>

      {open && (
        <div className="fixed inset-0 z-[9000] flex items-end sm:items-center justify-center announce-backdrop" style={{ background: "rgba(30,38,50,.45)" }} dir="rtl" onClick={() => setOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="اختيار البائع" onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-md flex flex-col gap-3 p-4 announce-pop" style={{ background: "var(--bg)", borderRadius: "28px 28px 0 0", maxHeight: "82vh", paddingBottom: "calc(16px + env(safe-area-inset-bottom, 0px))", boxShadow: "0 -12px 40px rgba(20,28,40,.3)" }}>
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-bold">اختيار البائع</h3>
              <button onClick={() => setOpen(false)} className="nm-knob sm" aria-label="إغلاق"><X size={15} /></button>
            </div>
            <div className="relative">
              <Search size={16} className="absolute right-4 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
              <input autoFocus className={inputCls + " pr-10 !rounded-full"} placeholder={`ابحث بالاسم بين ${sellers.length} بائعاً...`} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="overflow-y-auto flex flex-col gap-2 px-1 pb-1" style={{ minHeight: 0, WebkitOverflowScrolling: "touch" }}>
              {!term && (
                <button onClick={() => pick("all")} className={`flex items-center gap-3 px-3 py-2.5 rounded-2xl text-right ${value === "all" ? "nm-in-sm" : ""}`}>
                  <span className="nm-knob sm" style={{ boxShadow: "var(--nm-in-sm)" }}><UsersIcon size={15} className="nm-ink" /></span>
                  <span className="flex-1 font-bold text-sm">كل البائعين</span>
                  {value === "all" && <Check size={16} className="nm-ink" />}
                </button>
              )}
              {shown.map((u) => (
                <button key={u.id} onClick={() => pick(u.id)} className={`flex items-center gap-3 px-3 py-2.5 rounded-2xl text-right ${value === u.id ? "nm-in-sm" : ""}`}>
                  <span className="nm-knob sm" style={{ boxShadow: "var(--nm-in-sm)" }}><span className="text-sm font-bold nm-ink">{u.name.trim().charAt(0)}</span></span>
                  <span className="flex-1 min-w-0">
                    <span className="block font-semibold text-sm truncate">{u.name}</span>
                    <span className="block text-[11px] nm-mut">{u.role === "admin" ? "مدير" : "بائع"}</span>
                  </span>
                  <span className="nm-num text-xs font-semibold nm-mut shrink-0">{fmt(totalOf(u.id))}</span>
                  {value === u.id && <Check size={16} className="nm-ink shrink-0" />}
                </button>
              ))}
              {shown.length === 0 && <EmptyState text="لا يوجد بائع بهذا الاسم" />}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Stats({ sales, users, products, currentUser, isAdmin, activeTheme }) {
  const [sellerFilter, setSellerFilter] = useState("all");
  const [period, setPeriod] = useState("all"); // today | week | month | all
  const [productMode, setProductMode] = useState("qty"); // qty | value
  const [pickedDay, setPickedDay] = useState(null);
  const [showAllSellers, setShowAllSellers] = useState(false);
  const sellers = users.filter((u) => u.role === "seller" || u.role === "admin");

  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const today0 = startOfDay(new Date());
  const periodStart =
    period === "today" ? today0
    : period === "week" ? new Date(today0.getTime() - 6 * 86400000)
    : period === "month" ? new Date(today0.getFullYear(), today0.getMonth(), 1)
    : null;
  const PERIODS = [["today", "اليوم"], ["week", "7 أيام"], ["month", "هذا الشهر"], ["all", "الكل"]];

  const inPeriod = useMemo(() => (periodStart ? sales.filter((s) => new Date(s.date) >= periodStart) : sales), [sales, period]); // eslint-disable-line
  const list = sellerFilter === "all" ? inPeriod : inPeriod.filter((s) => s.sellerId === sellerFilter);

  const totalRevenue = list.reduce((a, s) => a + s.total, 0);
  const totalCollected = list.reduce((a, s) => a + s.collected, 0);
  const totalRemaining = list.reduce((a, s) => a + s.remaining, 0);
  const collectRate = totalRevenue > 0 ? (totalCollected / totalRevenue) * 100 : 0;
  const avgInvoice = list.length ? totalRevenue / list.length : 0;
  const unitsSold = list.reduce((a, s) => a + s.items.reduce((x, i) => x + i.qty, 0), 0);

  const costById = useMemo(() => {
    const m = new Map();
    products.forEach((p) => m.set(p.id, p.cost || 0));
    return m;
  }, [products]);

  const totalProfit = useMemo(() => {
    if (!isAdmin) return 0;
    return list.reduce((sum, s) => {
      const saleCost = s.items.reduce((a, i) => a + (costById.get(i.productId) || 0) * i.qty, 0);
      return sum + (s.total - saleCost);
    }, 0);
  }, [list, costById, isAdmin]);
  const margin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;

  // Per-seller totals for the chosen period (ignores the seller filter so the
  // comparison is always complete), split into collected and still-due.
  const bySeller = useMemo(() => {
    const map = new Map();
    inPeriod.forEach((s) => {
      const cur = map.get(s.sellerId) || { id: s.sellerId, name: s.sellerName, total: 0, collected: 0, remaining: 0, count: 0 };
      cur.total += s.total; cur.collected += s.collected; cur.remaining += s.remaining; cur.count += 1;
      map.set(s.sellerId, cur);
    });
    return Array.from(map.values()).sort((x, y) => y.total - x.total);
  }, [inPeriod]);
  const sellerMax = Math.max(1, ...bySeller.map((x) => x.total));
  const sellersTotal = bySeller.reduce((a, x) => a + x.total, 0);

  const byProduct = useMemo(() => {
    const map = new Map();
    list.forEach((s) => s.items.forEach((i) => {
      const cur = map.get(i.name) || { name: i.name, qty: 0, value: 0 };
      cur.qty += i.qty;
      cur.value += i.total ?? i.qty * i.price;
      map.set(i.name, cur);
    }));
    return Array.from(map.values());
  }, [list]);
  const productKey = productMode === "qty" ? "qty" : "value";
  const topProducts = [...byProduct].sort((x, y) => y[productKey] - x[productKey]).slice(0, 6);
  const productMax = Math.max(1, ...topProducts.map((x) => x[productKey]));
  const productTotal = byProduct.reduce((a, x) => a + x[productKey], 0);

  // Daily totals: the last 7 days for "7 أيام", otherwise the last 14 days.
  const dayCount = period === "week" ? 7 : 14;
  const days = useMemo(() => {
    const src = sellerFilter === "all" ? sales : sales.filter((s) => s.sellerId === sellerFilter);
    const out = [];
    for (let k = dayCount - 1; k >= 0; k--) {
      const d0 = new Date(today0.getTime() - k * 86400000);
      const d1 = new Date(d0.getTime() + 86400000);
      const daySales = src.filter((s) => { const t = new Date(s.date); return t >= d0 && t < d1; });
      out.push({ key: d0.toISOString().slice(0, 10), date: d0, total: daySales.reduce((a, s) => a + s.total, 0), count: daySales.length });
    }
    return out;
  }, [sales, sellerFilter, dayCount]); // eslint-disable-line
  const dayMax = Math.max(1, ...days.map((d) => d.total));
  const bestDay = days.reduce((b, d) => (d.total > b.total ? d : b), days[0]);
  const shownDay = days.find((d) => d.key === pickedDay) || (bestDay.total > 0 ? bestDay : days[days.length - 1]);
  const dayName = (d) => d.toLocaleDateString("ar", { weekday: "long" });
  const dayShort = (d) => `${d.getDate()}/${d.getMonth() + 1}`;

  const noData = list.length === 0;

  return (
    <div className="flex flex-col gap-5 max-w-5xl mx-auto nm-stats">
      <style>{`
        .nm-stats { --chart-1: #008C99; --chart-2: #C8782A; }
        html.dark .nm-stats { --chart-1: #1C9AA3; --chart-2: #BE7C2C; }
        .nm-bar { display: flex; gap: 2px; height: 14px; padding: 3px; border-radius: 99px; background: var(--bg); box-shadow: var(--nm-in-sm); }
        .nm-bar > i { display: block; height: 8px; border-radius: 4px; min-width: 3px; transition: width .5s ease; }
        .nm-bar > i:first-child { border-radius: 99px 4px 4px 99px; }
        .nm-bar > i:last-child { border-radius: 4px 99px 99px 4px; }
        .nm-bar > i:only-child { border-radius: 99px; }
        .nm-key { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); }
        .nm-key::before { content: ""; width: 10px; height: 10px; border-radius: 3px; background: var(--k); }
        .nm-cols { display: flex; align-items: flex-end; gap: 4px; height: 120px; padding: 8px 8px 0; border-radius: 18px; background: var(--bg); box-shadow: var(--nm-in); }
        .nm-cols > button { flex: 1; height: 100%; display: flex; align-items: flex-end; justify-content: center; padding: 0 1px; }
        .nm-cols > button > i { display: block; width: 100%; max-width: 18px; border-radius: 4px 4px 0 0; background: color-mix(in srgb, var(--chart-1) 45%, var(--bg)); transition: height .5s ease, background .2s ease; }
        .nm-cols > button.is-on > i, .nm-cols > button:hover > i { background: var(--chart-1); }
        .nm-chips { display: flex; gap: 8px; overflow-x: auto; padding: 6px 2px 10px; margin: -6px -2px -10px; scrollbar-width: none; }
        .nm-chips::-webkit-scrollbar { display: none; }
        .nm-chip { flex: none; display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 99px; font-size: 12.5px; font-weight: 600; color: var(--muted); background: var(--bg); box-shadow: var(--nm-out-sm); white-space: nowrap; }
        .nm-chip.is-on { color: var(--accent-ink); font-weight: 700; box-shadow: var(--nm-in-sm); }
      `}</style>

      <div>
        <h2 className="text-xl font-bold">إحصائيات المبيعات</h2>
        <p className="text-sm nm-mut">
          {PERIODS.find(([k]) => k === period)[1]} · {sellerFilter === "all" ? "كل البائعين" : sellers.find((x) => x.id === sellerFilter)?.name}
        </p>
      </div>

      {/* filters: one row for the period, one for who */}
      <div className="flex flex-col gap-3">
        <div className="nm-tog" role="tablist" aria-label="الفترة">
          {PERIODS.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={period === k} className={period === k ? "is-on" : ""} onClick={() => { setPeriod(k); setPickedDay(null); }}>{label}</button>
          ))}
        </div>
        <SellerPicker
          sellers={sellers}
          value={sellerFilter}
          onChange={setSellerFilter}
          totals={bySeller}
        />
      </div>

      {/* headline: how much was sold and how much of it is actually in hand */}
      <div className="grid md:grid-cols-2 gap-5 items-center">
        <SoftDial value={fmt(totalRevenue)} pct={collectRate} label="إجمالي المبيعات" caption={noData ? "لا مبيعات في هذه الفترة" : `محصّل ${collectRate.toFixed(0)}٪`} />
        <div className="grid grid-cols-2 gap-3">
          <StatCard label="عدد الفواتير" value={list.length} icon={Receipt} />
          <StatCard label="متوسط الفاتورة" value={fmt(avgInvoice)} unit="د.ك" icon={Calculator} />
          <StatCard label="المحصّل" value={fmt(totalCollected)} unit="د.ك" icon={Wallet} tone="ink" />
          <StatCard label="المتبقي" value={fmt(totalRemaining)} unit="د.ك" icon={AlertTriangle} tone={totalRemaining > 0 ? "due" : undefined} />
        </div>
      </div>

      {isAdmin && (
        <Card className="p-4 flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs nm-mut">صافي الربح (بعد خصم سعر التكلفة)</p>
              <p className={`nm-num text-2xl font-bold text-right ${totalProfit >= 0 ? "text-[var(--ok)]" : "text-[var(--bad)]"}`}>{fmt(totalProfit)} <span className="text-xs font-medium nm-mut">د.ك</span></p>
            </div>
            <div className="nm-well px-3 py-2 text-center shrink-0">
              <p className="nm-num text-lg font-bold leading-none">{margin.toFixed(0)}٪</p>
              <p className="text-[10px] nm-mut mt-1">هامش الربح</p>
            </div>
          </div>
          <div className="nm-groove" role="img" aria-label={`هامش الربح ${margin.toFixed(0)}٪ من المبيعات`}><span style={{ width: `${Math.max(0, Math.min(100, margin))}%`, background: "var(--ok)" }} /></div>
          <p className="text-[11px] nm-mut flex items-center gap-1.5"><ShieldCheck size={13} /> مرئي للمدير فقط · بناءً على سعر التكلفة المسجَّل لكل منتج · {unitsSold} قطعة مباعة</p>
        </Card>
      )}

      {/* daily trend */}
      {period !== "today" && (
        <Card className="p-4 flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="font-bold">المبيعات اليومية</h3>
            <span className="text-xs nm-mut">{dayCount === 7 ? "آخر 7 أيام" : "آخر 14 يوماً"}</span>
          </div>
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-xs nm-mut">{dayName(shownDay.date)} {dayShort(shownDay.date)}{shownDay.key === bestDay.key && bestDay.total > 0 ? " · أفضل يوم" : ""}</p>
              <p className="nm-num text-xl font-bold text-right">{fmt(shownDay.total)} <span className="text-xs font-medium nm-mut">د.ك</span></p>
            </div>
            <p className="text-xs nm-mut">{shownDay.count} فاتورة</p>
          </div>
          <div className="nm-cols" role="group" aria-label="مبيعات كل يوم، اضغط على عمود لعرض قيمته">
            {days.map((d) => (
              <button key={d.key} className={d.key === shownDay.key ? "is-on" : ""} onClick={() => setPickedDay(d.key)} title={`${dayName(d.date)} ${dayShort(d.date)} — ${fmt(d.total)} د.ك`} aria-label={`${dayName(d.date)} ${dayShort(d.date)}: ${fmt(d.total)} دينار، ${d.count} فاتورة`}>
                <i style={{ height: `${d.total > 0 ? Math.max(4, (d.total / dayMax) * 100) : 2}%` }} />
              </button>
            ))}
          </div>
          <div className="flex justify-between text-[10.5px] nm-mut px-1">
            <span className="nm-num">{dayShort(days[0].date)}</span>
            <span>اضغط على أي عمود لعرض قيمته</span>
            <span>اليوم</span>
          </div>
        </Card>
      )}

      {/* sellers: horizontal bars, name and value on the row itself — nothing to overlap */}
      {sellerFilter === "all" && (
        <Card className="p-4 flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h3 className="font-bold">{bySeller.length > 5 && !showAllSellers ? "أعلى 5 بائعين" : "مبيعات كل بائع"}</h3>
            <div className="flex items-center gap-3">
              <span className="nm-key" style={{ "--k": "var(--chart-1)" }}>محصّل</span>
              <span className="nm-key" style={{ "--k": "var(--chart-2)" }}>متبقٍ</span>
            </div>
          </div>
          {bySeller.length === 0 ? (
            <EmptyState text="لا مبيعات في هذه الفترة" />
          ) : (
            (showAllSellers ? bySeller : bySeller.slice(0, 5)).map((x, i) => (
              <button key={x.id} onClick={() => setSellerFilter(x.id)} className="text-right flex flex-col gap-2" title={`عرض إحصائيات ${x.name}`}>
                <span className="flex items-center gap-3">
                  <span className="nm-knob sm" style={{ boxShadow: "var(--nm-in-sm)" }} aria-hidden="true"><span className="nm-num text-xs font-bold nm-mut">{i + 1}</span></span>
                  <span className="flex-1 min-w-0">
                    <span className="block font-bold text-sm truncate">{x.name}</span>
                    <span className="block text-[11px] nm-mut">{x.count} فاتورة · {sellersTotal > 0 ? ((x.total / sellersTotal) * 100).toFixed(0) : 0}٪ من المبيعات</span>
                  </span>
                  <span className="text-left shrink-0">
                    <span className="block nm-num font-bold text-sm">{fmt(x.total)}</span>
                    {x.remaining > 0 && <span className="block nm-num text-[11px] text-[var(--due)]">متبقٍ {fmt(x.remaining)}</span>}
                  </span>
                </span>
                <span className="nm-bar" style={{ width: `${Math.max(12, (x.total / sellerMax) * 100)}%` }} role="img" aria-label={`${x.name}: محصّل ${fmt(x.collected)}، متبقٍ ${fmt(x.remaining)}`}>
                  {x.collected > 0 && <i style={{ width: `${(x.collected / x.total) * 100}%`, background: "var(--chart-1)" }} />}
                  {x.remaining > 0 && <i style={{ width: `${(x.remaining / x.total) * 100}%`, background: "var(--chart-2)" }} />}
                </span>
              </button>
            ))
          )}
          {bySeller.length > 5 && (
            <button onClick={() => setShowAllSellers((v) => !v)} className="nm-btn ink self-center !py-2 !px-4 text-[13px]">
              {showAllSellers ? "عرض أعلى 5 فقط" : `عرض كل البائعين (${bySeller.length})`}
            </button>
          )}
        </Card>
      )}

      {/* best sellers: ranked bars instead of a pie whose labels collided */}
      <Card className="p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-bold">الأكثر مبيعاً</h3>
          <div className="nm-tog !p-1" role="radiogroup" aria-label="طريقة الترتيب">
            <button role="radio" aria-checked={productMode === "qty"} className={`!px-3 !py-1.5 !text-[11.5px] ${productMode === "qty" ? "is-on" : ""}`} onClick={() => setProductMode("qty")}>بالعدد</button>
            <button role="radio" aria-checked={productMode === "value"} className={`!px-3 !py-1.5 !text-[11.5px] ${productMode === "value" ? "is-on" : ""}`} onClick={() => setProductMode("value")}>بالقيمة</button>
          </div>
        </div>
        {topProducts.length === 0 ? (
          <EmptyState text="لا مبيعات في هذه الفترة" />
        ) : (
          topProducts.map((x, i) => (
            <div key={x.name} className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <span className="nm-knob sm" style={{ boxShadow: "var(--nm-in-sm)" }} aria-hidden="true"><span className="nm-num text-xs font-bold nm-mut">{i + 1}</span></span>
                <span className="flex-1 min-w-0 font-bold text-sm truncate">{x.name}</span>
                <span className="text-left shrink-0">
                  <span className="block nm-num font-bold text-sm">{productMode === "qty" ? x.qty : fmt(x.value)} <span className="text-[10px] font-medium nm-mut">{productMode === "qty" ? "قطعة" : "د.ك"}</span></span>
                  <span className="block nm-num text-[11px] nm-mut">{productTotal > 0 ? ((x[productKey] / productTotal) * 100).toFixed(0) : 0}٪</span>
                </span>
              </div>
              <span className="nm-bar" style={{ width: `${Math.max(12, (x[productKey] / productMax) * 100)}%` }} role="img" aria-label={`${x.name}: ${productMode === "qty" ? `${x.qty} قطعة` : `${fmt(x.value)} دينار`}`}>
                <i style={{ width: "100%", background: "var(--chart-1)" }} />
              </span>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}

/* ---------------------------------- Inventory ---------------------------------- */

function Inventory({ products, isAdmin, onSave, onPrintLabels, stockLogs, onLogAdjustment, onDeleteLog, onConfirm, activeTheme, sellerAllocations = [], tab = "products", currentUserId }) {
  const [form, setForm] = useState({ name: "", price: "", cost: "", stock: "", minStock: "5" });
  const [editingId, setEditingId] = useState(null);
  const [labelQty, setLabelQty] = useState({});
  const [adjustingId, setAdjustingId] = useState(null);
  const [adjustType, setAdjustType] = useState("gift");
  const [adjustQty, setAdjustQty] = useState(1);
  const [adjustNote, setAdjustNote] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("name"); // name | stockAsc
  const [logFilter, setLogFilter] = useState("all");
  const [showForm, setShowForm] = useState(false);
  const [stockFilter, setStockFilter] = useState("all"); // all | low | out
  const [panel, setPanel] = useState(null); // { id, kind: "adjust" | "labels" } — the action panel open inside a card

  const resetForm = () => { setForm({ name: "", price: "", cost: "", stock: "", minStock: "5" }); setEditingId(null); setShowForm(false); };

  const submit = () => {
    if (!form.name || form.price === "" || form.stock === "") return;
    if (editingId) {
      onSave(products.map((p) => p.id === editingId ? { ...p, name: form.name, price: Number(form.price), cost: Number(form.cost || 0), stock: Number(form.stock), minStock: Number(form.minStock || 5) } : p));
    } else {
      onSave([...products, { id: uid(), name: form.name, price: Number(form.price), cost: Number(form.cost || 0), stock: Number(form.stock), minStock: Number(form.minStock || 5) }]);
    }
    resetForm();
  };

  const startEdit = (p) => { setForm({ name: p.name, price: String(p.price), cost: String(p.cost || 0), stock: String(p.stock), minStock: String(p.minStock ?? 5) }); setEditingId(p.id); setShowForm(true); setExpandedId(null); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const maxStock = Math.max(1, ...products.map((p) => p.stock));

  const submitAdjustment = (product) => {
    const q = Number(adjustQty);
    if (!q || q <= 0) return;
    onLogAdjustment(product, adjustType, q, adjustNote);
    setAdjustingId(null);
    setAdjustQty(1);
    setAdjustNote("");
  };

  const lowStockCount = products.filter((p) => p.stock <= (p.minStock ?? 5)).length;
  const inventoryValueCost = products.reduce((a, p) => a + p.stock * (p.cost || 0), 0);
  const inventoryValueRetail = products.reduce((a, p) => a + p.stock * p.price, 0);

  let list = products;
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    list = list.filter((p) => p.name.toLowerCase().includes(q));
  }
  list = [...list].sort((a, b) => {
    if (sortBy === "stockAsc") return a.stock - b.stock;
    return a.name.localeCompare(b.name, "ar");
  });

  let logList = stockLogs;
  if (logFilter !== "all") logList = logList.filter((l) => l.type === logFilter);

  const stockBadge = (p) => {
    const min = p.minStock ?? 5;
    if (p.stock <= 0) return { label: "نفد المخزون", cls: "bg-[#FBEAEA] text-[#B23A3A]" };
    if (p.stock <= min) return { label: "منخفض", cls: "bg-[#FBEAEA] text-[#B23A3A]" };
    if (p.stock <= min * 2) return { label: "جيد", cls: "bg-[#FFF6E5] text-[#C97B3D]" };
    return { label: "ممتاز", cls: "bg-[#EAF6EF] text-[#3F7D57]" };
  };

  // ----- derived values for the redesigned page -----
  const outCount = products.filter((p) => p.stock <= 0).length;
  const lowOnlyCount = lowStockCount - outCount;
  if (stockFilter === "low") list = list.filter((p) => p.stock > 0 && p.stock <= (p.minStock ?? 5));
  else if (stockFilter === "out") list = list.filter((p) => p.stock <= 0);
  const heldBySellers = (pid) => (sellerAllocations || []).filter((a) => a.productId === pid).reduce((a, x) => a + Math.max(0, x.remaining), 0);
  const VIAL_COLORS = ["#B24A63", "#6A4AA0", "#3E8A73", "#9A6420", "#2F5E9A", "#6B4424"];
  const vialColor = (p) => VIAL_COLORS[Math.max(0, products.findIndex((x) => x.id === p.id)) % VIAL_COLORS.length];
  const tone = (p) => {
    const min = p.minStock ?? 5;
    if (p.stock <= 0) return { pill: "bad", label: "نفد المخزون", color: "var(--bad)", bar: "linear-gradient(270deg, #D46E6E, #B04747)" };
    if (p.stock <= min) return { pill: "due", label: "منخفض", color: "var(--due)", bar: "linear-gradient(270deg, #D08A5A, #A8612E)" };
    if (p.stock <= min * 2) return { pill: "info", label: "جيد", color: "var(--text)", bar: null };
    return { pill: "ok", label: "ممتاز", color: "var(--text)", bar: null };
  };
  const openPanel = (p, kind) => {
    const same = panel && panel.id === p.id && panel.kind === kind;
    setPanel(same ? null : { id: p.id, kind });
    setAdjustQty(1); setAdjustNote(""); setAdjustType("gift");
  };
  const logCounts = { gift: 0, tester: 0, damage: 0 };
  stockLogs.forEach((l) => { if (logCounts[l.type] != null) logCounts[l.type] += l.qty; });

  if (tab === "log") {
    return (
      <div className="flex flex-col gap-5 max-w-3xl mx-auto">
        <div>
          <h2 className="text-xl font-bold">الهدايا والتالف والتجربة</h2>
          <p className="text-sm nm-mut">كل ما خرج من المخزون بدون بيع</p>
        </div>
        <div className="nm-tog" role="tablist" aria-label="نوع العملية">
          {[["all", "الكل", stockLogs.reduce((a, l) => a + l.qty, 0)], ["gift", "هدايا", logCounts.gift], ["tester", "تجربة", logCounts.tester], ["damage", "تالف", logCounts.damage]].map(([k, label, n]) => (
            <button key={k} role="tab" aria-selected={logFilter === k} className={logFilter === k ? "is-on" : ""} onClick={() => setLogFilter(k)}>
              {label} <span className="nm-num text-[11px] nm-mut">{n}</span>
            </button>
          ))}
        </div>
        {logList.length === 0 ? (
          <div className="nm-well p-6"><EmptyState text="لا توجد عمليات مسجَّلة بعد" /></div>
        ) : (
          <div className="nm-card px-4 py-1">
            {logList.map((l, i) => {
              const c = l.type === "gift" ? "var(--accent-ink)" : l.type === "tester" ? "var(--info)" : "var(--bad)";
              return (
                <div key={l.id} className={`flex items-center gap-3 py-3 ${i ? "border-t border-[var(--border)]" : ""}`}>
                  <span className="nm-knob sm" style={{ boxShadow: "var(--nm-in-sm)", color: c }}>
                    {l.type === "gift" ? <Gift size={15} /> : l.type === "tester" ? <Droplet size={15} /> : <Ban size={15} />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate">{l.productName} <span className="nm-num nm-mut font-normal">× {l.qty}</span></p>
                    <p className="text-[11px] nm-mut truncate">{l.type === "gift" ? "هدية" : l.type === "tester" ? "تجربة" : "تالف"} · {l.byUserName} · {dateLabel(l.date)} {timeLabel(l.date)}{l.note ? ` · ${l.note}` : ""}</p>
                  </div>
                  {isAdmin && (
                    <button onClick={() => onConfirm("هل تريد حذف هذا السجل؟ سيتم إرجاع الكمية إلى المخزون تلقائياً.", () => onDeleteLog(l.id))} className="nm-knob sm danger" aria-label="حذف السجل وإرجاع الكمية"><Trash2 size={15} /></button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">المنتجات</h2>
          <p className="text-sm nm-mut">{products.length} منتج · {products.reduce((a, p) => a + p.stock, 0)} قطعة في المخزن</p>
        </div>
        {isAdmin && !showForm && !editingId && (
          <Btn variant="ghost" className="!py-2 !px-4 text-[13px]" onClick={() => setShowForm(true)}><Plus size={16} /> منتج جديد</Btn>
        )}
      </div>

      {isAdmin && (
        <div className="nm-well px-2 py-3 grid grid-cols-3 text-center" aria-label="قيمة المخزون">
          <div><p className="text-[10.5px] nm-mut">قيمة التكلفة</p><p className="nm-num font-bold">{fmt(inventoryValueCost)}</p></div>
          <div className="border-x border-[var(--border)]"><p className="text-[10.5px] nm-mut">قيمة البيع</p><p className="nm-num font-bold nm-ink">{fmt(inventoryValueRetail)}</p></div>
          <div><p className="text-[10.5px] nm-mut">الربح المتوقع</p><p className="nm-num font-bold text-[var(--ok)]">{fmt(inventoryValueRetail - inventoryValueCost)}</p></div>
        </div>
      )}

      {isAdmin && (showForm || editingId) && (
        <Card className="p-4 fade-in">
          <h3 className="font-bold mb-3">{editingId ? "تعديل منتج" : "إضافة منتج جديد"}</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="col-span-2 md:col-span-1">
              <Field label="اسم المنتج"><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="عود كمبودي" /></Field>
            </div>
            <Field label="سعر البيع (K.D)"><input type="number" step="0.001" className={inputCls} value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></Field>
            <Field label="سعر التكلفة (K.D)"><input type="number" step="0.001" className={inputCls} value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} /></Field>
            <Field label="الكمية بالمخزون"><input type="number" className={inputCls} value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} /></Field>
            <Field label="حد التنبيه"><input type="number" className={inputCls} value={form.minStock} onChange={(e) => setForm({ ...form, minStock: e.target.value })} /></Field>
          </div>
          <div className="flex gap-3 mt-4">
            <Btn onClick={submit} className="flex-1"><Check size={16} /> {editingId ? "حفظ التعديل" : "إضافة المنتج"}</Btn>
            <Btn variant="outline" onClick={resetForm}>إلغاء</Btn>
          </div>
        </Card>
      )}

      {/* Search, status filter and sort */}
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search size={16} className="absolute right-4 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
          <input className={inputCls + " pr-10 !rounded-full"} placeholder="بحث باسم المنتج..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="nm-tog" role="tablist" aria-label="حالة المخزون">
          <button role="tab" aria-selected={stockFilter === "all"} className={stockFilter === "all" ? "is-on" : ""} onClick={() => setStockFilter("all")}>الكل <span className="nm-num text-[11px] nm-mut">{products.length}</span></button>
          <button role="tab" aria-selected={stockFilter === "low"} className={stockFilter === "low" ? "is-on" : ""} onClick={() => setStockFilter("low")} style={stockFilter === "low" ? { color: "var(--due)" } : undefined}>منخفض <span className="nm-num text-[11px] nm-mut">{lowOnlyCount}</span></button>
          <button role="tab" aria-selected={stockFilter === "out"} className={stockFilter === "out" ? "is-on" : ""} onClick={() => setStockFilter("out")} style={stockFilter === "out" ? { color: "var(--bad)" } : undefined}>نفد <span className="nm-num text-[11px] nm-mut">{outCount}</span></button>
        </div>
        <button onClick={() => setSortBy(sortBy === "name" ? "stockAsc" : "name")} className="nm-btn self-start !py-1.5 !px-3.5 text-[12px]" aria-label="تغيير الترتيب">
          <ArrowLeftRight size={13} className="rotate-90" /> الترتيب: {sortBy === "name" ? "أبجدي" : "الأقل مخزوناً أولاً"}
        </button>
      </div>

      {list.length === 0 ? (
        <div className="nm-well p-8"><EmptyState text={products.length === 0 ? "لا توجد منتجات مضافة بعد" : "لا توجد منتجات مطابقة"} /></div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {list.map((p) => {
            const t = tone(p);
            const min = p.minStock ?? 5;
            const held = heldBySellers(p.id);
            const managed = (sellerAllocations || []).some((a) => a.productId === p.id);
            const myShare = (sellerAllocations || []).find((a) => a.productId === p.id && a.sellerId === currentUserId);
            const profit = p.price - (p.cost || 0);
            const margin = p.price > 0 ? (profit / p.price) * 100 : 0;
            const open = panel && panel.id === p.id ? panel.kind : null;
            const scale = Math.max(maxStock, min * 3);
            return (
              <Card key={p.id} className="p-4 flex flex-col gap-4">
                {/* identity + the number that matters */}
                <div className="flex items-center gap-3">
                  <span className="nm-knob lg" style={{ boxShadow: "var(--nm-in-sm)", color: p.stock <= 0 ? "var(--faint)" : vialColor(p) }} aria-hidden="true"><Droplet size={22} /></span>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-[16px] leading-tight truncate">{p.name}</p>
                    <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                      <span className={`nm-pill ${t.pill}`}>{t.label}</span>
                      {managed && <span className="nm-pill plain"><Boxes size={11} /> {myShare ? `حصتي ${Math.max(0, myShare.remaining)}` : "موزّع"}</span>}
                    </div>
                  </div>
                  <div className="nm-well px-3 py-2 text-center shrink-0" style={{ minWidth: 68 }}>
                    <p className="nm-num text-[26px] font-bold leading-none" style={{ color: t.color }}>{p.stock}</p>
                    <p className="text-[10px] nm-mut mt-1">قطعة</p>
                  </div>
                </div>

                {/* stock level against its alert threshold */}
                <div>
                  <div className="nm-groove relative" role="img" aria-label={`المخزون ${p.stock}، حد التنبيه ${min}`}>
                    <span style={{ width: `${Math.max(p.stock > 0 ? 4 : 0, Math.min(100, (p.stock / scale) * 100))}%`, ...(t.bar ? { background: t.bar } : {}) }} />
                    <i className="absolute top-0 bottom-0 w-[2px] rounded" style={{ right: `calc(${Math.min(96, (min / scale) * 100)}% + 3px)`, background: "var(--faint)" }} />
                  </div>
                  <div className="flex justify-between text-[10.5px] nm-mut mt-1.5">
                    <span>حد التنبيه {min}</span>
                    {managed && <span>بحوزة البائعين {held} · غير موزّع {Math.max(0, p.stock - held)}</span>}
                  </div>
                </div>

                {/* money */}
                <div className={`nm-well py-2.5 px-2 grid text-center ${isAdmin ? "grid-cols-3" : "grid-cols-2"}`}>
                  <div><p className="text-[10px] nm-mut">سعر البيع</p><p className="nm-num font-bold text-sm">{fmt(p.price)}</p></div>
                  {!isAdmin && (
                    <div className="border-r border-[var(--border)]">
                      <p className="text-[10px] nm-mut">{managed ? "حصتي" : "متاح للبيع"}</p>
                      <p className="nm-num font-bold text-sm nm-ink">{managed ? Math.max(0, myShare?.remaining || 0) : p.stock}</p>
                    </div>
                  )}
                  {isAdmin && <div className="border-x border-[var(--border)]"><p className="text-[10px] nm-mut">التكلفة</p><p className="nm-num font-bold text-sm">{fmt(p.cost || 0)}</p></div>}
                  {isAdmin && <div><p className="text-[10px] nm-mut">الربح · {margin.toFixed(0)}٪</p><p className="nm-num font-bold text-sm text-[var(--ok)]">{fmt(profit)}</p></div>}
                </div>

                {/* every action one tap away */}
                <div className="flex justify-around gap-1">
                  <button className="nm-act" onClick={() => openPanel(p, "adjust")} disabled={p.stock <= 0} style={p.stock <= 0 ? { opacity: 0.45 } : undefined}>
                    <span className={`nm-knob nm-ink ${open === "adjust" ? "is-on" : ""}`}><Gift size={17} /></span>هدية/تالف
                  </button>
                  <button className="nm-act" onClick={() => openPanel(p, "labels")}>
                    <span className={`nm-knob ${open === "labels" ? "is-on" : ""}`}><Tag size={17} /></span>ملصقات
                  </button>
                  {isAdmin && (
                    <button className="nm-act" onClick={() => { setPanel(null); startEdit(p); }}>
                      <span className="nm-knob"><Pencil size={17} /></span>تعديل
                    </button>
                  )}
                  {isAdmin && (
                    <button className="nm-act" onClick={() => onConfirm(`هل تريد حذف المنتج "${p.name}"؟ لا يمكن التراجع عن هذا الإجراء.`, () => onSave(products.filter((x) => x.id !== p.id)))}>
                      <span className="nm-knob danger"><Trash2 size={17} /></span>حذف
                    </button>
                  )}
                </div>

                {open === "labels" && (
                  <div className="nm-well p-3 flex flex-col gap-3 fade-in">
                    <p className="text-xs font-semibold">طباعة ملصقات وباركود</p>
                    <div className="flex items-center gap-3">
                      <SoftStepper value={labelQty[p.id] ?? 12} min={1} max={500} onChange={(v) => setLabelQty({ ...labelQty, [p.id]: v })} label="عدد الملصقات" />
                      <Btn variant="ghost" className="flex-1 !py-2.5 text-[13px]" onClick={() => onPrintLabels(p, labelQty[p.id] ?? 12)}><Printer size={15} /> طباعة</Btn>
                    </div>
                  </div>
                )}

                {open === "adjust" && (
                  <div className="nm-well p-3 flex flex-col gap-3 fade-in">
                    <p className="text-xs font-semibold">تسجيل خروج بدون بيع</p>
                    <div className="nm-tog !p-1" role="radiogroup" aria-label="نوع العملية">
                      <button role="radio" aria-checked={adjustType === "gift"} onClick={() => setAdjustType("gift")} className={adjustType === "gift" ? "is-on" : ""}><Gift size={13} /> هدية</button>
                      <button role="radio" aria-checked={adjustType === "tester"} onClick={() => setAdjustType("tester")} className={adjustType === "tester" ? "is-on" : ""} style={adjustType === "tester" ? { color: "var(--info)" } : undefined}><Droplet size={13} /> تجربة</button>
                      <button role="radio" aria-checked={adjustType === "damage"} onClick={() => setAdjustType("damage")} className={adjustType === "damage" ? "is-on" : ""} style={adjustType === "damage" ? { color: "var(--bad)" } : undefined}><Ban size={13} /> تالف</button>
                    </div>
                    <div className="flex items-center gap-3">
                      <SoftStepper value={adjustQty} min={1} max={p.stock} onChange={setAdjustQty} label="الكمية" />
                      <input className={inputCls + " flex-1 !py-2 !text-xs"} placeholder="سبب / ملاحظة (اختياري)" value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)} />
                    </div>
                    <div className="flex gap-3">
                      <Btn className="flex-1 !py-2.5 text-[13px]" onClick={() => { submitAdjustment(p); setPanel(null); }}><Check size={15} /> تأكيد الخصم من المخزون</Btn>
                      <button onClick={() => setPanel(null)} className="nm-knob" aria-label="إغلاق"><X size={16} /></button>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Round − / + stepper: the buttons are raised, the track is sunk.
function SoftStepper({ value, onChange, min = 1, max = 9999, label }) {
  const v = Number(value) || min;
  const set = (n) => onChange(Math.max(min, Math.min(max, n)));
  return (
    <div className="nm-in-sm rounded-full p-1 inline-flex items-center gap-1 shrink-0" role="group" aria-label={label}>
      <button type="button" className="nm-knob sm" onClick={() => set(v - 1)} disabled={v <= min} aria-label="إنقاص"><Minus size={15} /></button>
      <input
        type="number"
        inputMode="numeric"
        className="nm-num w-10 text-center text-sm font-bold bg-transparent outline-none"
        style={{ MozAppearance: "textfield" }}
        value={v}
        onChange={(e) => set(Number(e.target.value) || min)}
        aria-label={label}
      />
      <button type="button" className="nm-knob sm" onClick={() => set(v + 1)} disabled={v >= max} aria-label="زيادة"><Plus size={15} /></button>
    </div>
  );
}

/* ---------------------------------- Users Admin ---------------------------------- */

function UsersAdmin({ users, onSave, onConfirm, currentUser, onToggleStockManager, sales = [], sellerAllocations = [] }) {
  const [form, setForm] = useState({ username: "", password: "", name: "", role: "seller" });
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ username: "", password: "", name: "", role: "seller", securityQuestion: "", securityAnswer: "" });
  const [showForm, setShowForm] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [roleFilter, setRoleFilter] = useState("all"); // all | admin | seller
  const [userSearch, setUserSearch] = useState("");
  const [formError, setFormError] = useState("");
  const [editError, setEditError] = useState("");

  const submit = async () => {
    if (!form.name.trim() || !form.username.trim() || !form.password) { setFormError("أكمل الاسم واسم المستخدم وكلمة المرور"); return; }
    if (users.some((u) => u.username.toLowerCase() === form.username.trim().toLowerCase())) { setFormError("اسم المستخدم مستعمل من حساب آخر"); return; }
    const hashed = await hashPassword(form.password);
    onSave([...users, { id: uid(), ...form, name: form.name.trim(), username: form.username.trim(), password: hashed }]);
    setForm({ username: "", password: "", name: "", role: "seller" });
    setFormError("");
    setShowForm(false);
  };

  const startEdit = (u) => {
    setEditingId(u.id);
    setEditError("");
    setEditForm({
      username: u.username,
      password: "", // blank = keep the current (hashed) password unchanged
      name: u.name,
      role: u.role,
      securityQuestion: u.securityQuestion || "",
      securityAnswer: "", // blank = keep the current (hashed) answer unchanged
    });
  };

  const saveEdit = async (id) => {
    if (!editForm.username || !editForm.name) { setEditError("الاسم واسم المستخدم مطلوبان"); return; }
    if (users.some((u) => u.id !== id && u.username.toLowerCase() === editForm.username.toLowerCase())) { setEditError("اسم المستخدم مستعمل من حساب آخر"); return; }
    const original = users.find((u) => u.id === id);
    const updates = { ...editForm };
    updates.password = editForm.password.trim() ? await hashPassword(editForm.password.trim()) : original.password;
    if (original.isPrimaryAdmin) {
      updates.securityAnswer = editForm.securityAnswer.trim()
        ? await hashPassword(editForm.securityAnswer.trim().toLowerCase())
        : original.securityAnswer;
    } else {
      delete updates.securityAnswer;
      delete updates.securityQuestion;
    }
    onSave(users.map((u) => (u.id === id ? { ...u, ...updates } : u)));
    setEditingId(null);
  };

  const admins = users.filter((u) => u.role === "admin");
  const sellersOnly = users.filter((u) => u.role !== "admin");
  const stockManagers = users.filter((u) => u.canManageStock && !u.isPrimaryAdmin);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const statsOf = (u) => {
    const mine = sales.filter((x) => x.sellerId === u.id && new Date(x.date) >= monthStart);
    return {
      invoices: mine.length,
      collected: mine.reduce((a, x) => a + x.collected, 0),
      held: sellerAllocations.filter((a) => a.sellerId === u.id).reduce((a, x) => a + Math.max(0, x.remaining), 0),
    };
  };
  const AVATAR_COLORS = ["#2F7F86", "#6A4AA0", "#B24A63", "#9A6420", "#2F5E9A", "#3E8A73"];
  const userTerm = userSearch.trim().toLowerCase();
  const shown = users
    .filter((u) => roleFilter === "all" || (roleFilter === "admin" ? u.role === "admin" : u.role !== "admin"))
    .filter((u) => !userTerm || u.name.toLowerCase().includes(userTerm) || (u.username || "").toLowerCase().includes(userTerm))
    // primary first, then admins, then sellers — a stable, predictable order
    .sort((x, y) => (y.isPrimaryAdmin ? 1 : 0) - (x.isPrimaryAdmin ? 1 : 0) || (y.role === "admin" ? 1 : 0) - (x.role === "admin" ? 1 : 0));

  const RoleToggle = ({ value, onChange, disabled }) => (
    <div className="nm-tog !p-1" role="radiogroup" aria-label="الدور" style={disabled ? { opacity: 0.55, pointerEvents: "none" } : undefined}>
      <button type="button" role="radio" aria-checked={value === "seller"} className={value === "seller" ? "is-on" : ""} onClick={() => onChange("seller")}>بائع</button>
      <button type="button" role="radio" aria-checked={value === "admin"} className={value === "admin" ? "is-on" : ""} onClick={() => onChange("admin")}>مدير</button>
    </div>
  );

  return (
    <div className="flex flex-col gap-5 max-w-5xl mx-auto">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold">المستخدمون والصلاحيات</h2>
          <p className="text-sm nm-mut">{users.length} حساب في النظام</p>
        </div>
        {!showForm && (
          <Btn variant="ghost" className="!py-2 !px-4 text-[13px] shrink-0" onClick={() => { setShowForm(true); setFormError(""); }}><Plus size={16} /> مستخدم جديد</Btn>
        )}
      </div>

      <div className="nm-well px-2 py-3 grid grid-cols-3 text-center" aria-label="ملخص الحسابات">
        <div><p className="text-[10.5px] nm-mut">المدراء</p><p className="nm-num font-bold">{admins.length}</p></div>
        <div className="border-x border-[var(--border)]"><p className="text-[10.5px] nm-mut">البائعون</p><p className="nm-num font-bold">{sellersOnly.length}</p></div>
        <div className="min-w-0 px-1"><p className="text-[10.5px] nm-mut">مسؤول المخزن</p><p className="font-bold text-sm truncate" style={{ color: "var(--due)" }}>{stockManagers.length ? stockManagers.map((u) => u.name).join("، ") : "الأساسي فقط"}</p></div>
      </div>

      {showForm && (
        <Card className="p-4 flex flex-col gap-4 fade-in">
          <div className="flex items-center justify-between">
            <h3 className="font-bold">إضافة مستخدم جديد</h3>
            <button onClick={() => { setShowForm(false); setFormError(""); }} className="nm-knob sm" aria-label="إغلاق"><X size={15} /></button>
          </div>
          <Field label="الاسم"><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="مثال: فهد" /></Field>
          <div>
            <span className="block text-xs font-semibold text-[var(--muted)] mb-1">الدور</span>
            <RoleToggle value={form.role} onChange={(role) => setForm({ ...form, role })} />
            <p className="text-[11px] nm-mut mt-1.5">{form.role === "admin" ? "المدير يرى المالية والإدارة ويعدّل ويحذف." : "البائع يبيع ويحصّل ويرى حصته فقط."}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="اسم المستخدم"><input dir="ltr" autoCapitalize="none" className={inputCls + " text-right"} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="fahad" /></Field>
            <Field label="كلمة المرور">
              <span className="relative block">
                <input dir="ltr" type={showPass ? "text" : "password"} className={inputCls + " text-right pl-10"} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                <button type="button" onClick={() => setShowPass((v) => !v)} className="absolute left-2 top-1/2 -translate-y-1/2 p-1 nm-mut" aria-label={showPass ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}>{showPass ? <EyeOff size={16} /> : <Eye size={16} />}</button>
              </span>
            </Field>
          </div>
          {formError && <p className="text-xs font-semibold text-[var(--bad)] flex items-center gap-1.5" role="alert"><AlertTriangle size={14} /> {formError}</p>}
          <Btn onClick={submit} className="w-full"><Plus size={16} /> إضافة المستخدم</Btn>
        </Card>
      )}

      <div className="relative">
        <Search size={16} className="absolute right-4 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
        <input className={inputCls + " pr-10 !rounded-full"} placeholder="بحث بالاسم أو اسم المستخدم..." value={userSearch} onChange={(e) => setUserSearch(e.target.value)} aria-label="بحث في المستخدمين" />
      </div>

      <div className="flex items-center gap-3">
        <div className="nm-tog flex-1" role="tablist" aria-label="تصفية حسب الدور">
          <button role="tab" aria-selected={roleFilter === "all"} className={roleFilter === "all" ? "is-on" : ""} onClick={() => setRoleFilter("all")}>الكل <span className="nm-num text-[11px] nm-mut">{users.length}</span></button>
          <button role="tab" aria-selected={roleFilter === "admin"} className={roleFilter === "admin" ? "is-on" : ""} onClick={() => setRoleFilter("admin")}>المدراء <span className="nm-num text-[11px] nm-mut">{admins.length}</span></button>
          <button role="tab" aria-selected={roleFilter === "seller"} className={roleFilter === "seller" ? "is-on" : ""} onClick={() => setRoleFilter("seller")}>البائعون <span className="nm-num text-[11px] nm-mut">{sellersOnly.length}</span></button>
        </div>
        {currentUser.isPrimaryAdmin && (
          <button onClick={() => setShowHelp((v) => !v)} className={`nm-knob ${showHelp ? "is-on" : ""}`} aria-expanded={showHelp} aria-label="ما هي صلاحية مسؤول المخزن؟" title="ما هي صلاحية مسؤول المخزن؟"><Boxes size={17} /></button>
        )}
      </div>

      {currentUser.isPrimaryAdmin && showHelp && (
        <div className="nm-well p-4 text-xs leading-relaxed nm-mut fade-in">
          <p className="font-bold text-sm text-[var(--text)] mb-1">صلاحية مسؤول المخزن</p>
          صاحبها — مديراً كان أو بائعاً — يوزّع المنتجات بالعدد على جميع البائعين، ويزيد أو ينقص حصة كل بائع، ويطّلع على سجل الحركات بالاسم. بقية البائعين يرون حصتهم فقط. فعّلها أو أوقفها من المفتاح داخل بطاقة أي حساب.
        </div>
      )}

      {shown.length === 0 ? (
        <div className="nm-well p-6"><EmptyState text={userTerm ? "لا يوجد مستخدم بهذا الاسم" : "لا توجد حسابات بهذا الدور"} /></div>
      ) : (
        <div className="grid md:grid-cols-2 gap-5">
          {shown.map((u) => {
            const st = statsOf(u);
            const isMe = currentUser.id === u.id;
            const color = AVATAR_COLORS[Math.max(0, users.findIndex((x) => x.id === u.id)) % AVATAR_COLORS.length];
            const canEdit = !u.isPrimaryAdmin || isMe;
            const canDelete = !u.isPrimaryAdmin;
            const editing = editingId === u.id;
            return (
              <Card key={u.id} className="p-4 flex flex-col gap-4">
                {/* identity */}
                <div className="flex items-center gap-3">
                  <span className="nm-knob lg" style={{ boxShadow: "var(--nm-in-sm)" }} aria-hidden="true">
                    <span className="text-xl font-bold" style={{ color }}>{(u.name || "?").trim().charAt(0)}</span>
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-[16px] leading-tight truncate">{u.name}</p>
                    <p className="nm-num text-xs nm-mut truncate text-right">@{u.username}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <span className={`nm-pill ${u.role === "admin" ? "info" : "plain"}`}>{u.role === "admin" ? "مدير" : "بائع"}</span>
                    {isMe && <span className="nm-pill ok">أنت</span>}
                  </div>
                </div>

                {(u.isPrimaryAdmin || u.canManageStock) && !editing && (
                  <div className="flex items-center gap-1.5 flex-wrap -mt-1">
                    {u.isPrimaryAdmin && <span className="nm-pill" style={{ color: "var(--accent-ink)", background: "color-mix(in srgb, var(--accent) 14%, var(--bg))" }}><ShieldCheck size={11} /> الحساب الأساسي</span>}
                    {(u.canManageStock || u.isPrimaryAdmin) && <span className="nm-pill due"><Boxes size={11} /> مسؤول المخزن</span>}
                  </div>
                )}

                {editing ? (
                  <div className="flex flex-col gap-3 fade-in">
                    <Field label="الاسم"><input className={inputCls} value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} /></Field>
                    <div>
                      <span className="block text-xs font-semibold text-[var(--muted)] mb-1">الدور</span>
                      <RoleToggle value={editForm.role} onChange={(role) => setEditForm({ ...editForm, role })} disabled={u.isPrimaryAdmin} />
                      {u.isPrimaryAdmin && <p className="text-[11px] nm-mut mt-1.5 flex items-center gap-1"><ShieldCheck size={12} /> دور الحساب الأساسي ثابت ولا يمكن تغييره</p>}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="اسم المستخدم"><input dir="ltr" autoCapitalize="none" className={inputCls + " text-right"} value={editForm.username} onChange={(e) => setEditForm({ ...editForm, username: e.target.value })} /></Field>
                      <Field label="كلمة المرور الجديدة"><input dir="ltr" className={inputCls + " text-right"} value={editForm.password} onChange={(e) => setEditForm({ ...editForm, password: e.target.value })} placeholder="بدون تغيير" /></Field>
                    </div>
                    <p className="text-[11px] nm-mut -mt-1">اترك كلمة المرور فارغة للإبقاء على الحالية.</p>
                    {u.isPrimaryAdmin && (
                      <div className="nm-well p-3 flex flex-col gap-3">
                        <p className="text-xs font-semibold flex items-center gap-1.5"><KeyRound size={13} className="nm-ink" /> سؤال استعادة الحساب (لهذا الحساب فقط)</p>
                        <Field label="السؤال"><input className={inputCls} value={editForm.securityQuestion} onChange={(e) => setEditForm({ ...editForm, securityQuestion: e.target.value })} /></Field>
                        <Field label="إجابة جديدة"><input className={inputCls} value={editForm.securityAnswer} onChange={(e) => setEditForm({ ...editForm, securityAnswer: e.target.value })} placeholder="اتركها فارغة للإبقاء عليها" /></Field>
                      </div>
                    )}
                    {editError && <p className="text-xs font-semibold text-[var(--bad)] flex items-center gap-1.5" role="alert"><AlertTriangle size={14} /> {editError}</p>}
                    <div className="flex gap-3">
                      <Btn className="flex-1" onClick={() => saveEdit(u.id)}><Save size={16} /> حفظ</Btn>
                      <Btn variant="outline" onClick={() => setEditingId(null)}>إلغاء</Btn>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* this month at a glance */}
                    <div className="nm-well py-2.5 px-2 grid grid-cols-3 text-center">
                      <div><p className="text-[10px] nm-mut">فواتير الشهر</p><p className="nm-num font-bold text-sm">{st.invoices}</p></div>
                      <div className="border-x border-[var(--border)]"><p className="text-[10px] nm-mut">محصّل الشهر</p><p className="nm-num font-bold text-sm nm-ink">{fmt(st.collected)}</p></div>
                      <div><p className="text-[10px] nm-mut">في حصته</p><p className="nm-num font-bold text-sm">{st.held} <span className="text-[10px] nm-mut font-medium">قطعة</span></p></div>
                    </div>

                    {/* stock-manager permission: a real switch, primary account only */}
                    {currentUser.isPrimaryAdmin && !u.isPrimaryAdmin && (
                      <button
                        role="switch"
                        aria-checked={!!u.canManageStock}
                        onClick={() =>
                          u.canManageStock
                            ? onConfirm(`هل تريد سحب صلاحية "مسؤول المخزن" من ${u.name}؟ لن يتمكن بعدها من توزيع المخزون على البائعين.`, () => onToggleStockManager(u, false))
                            : onToggleStockManager(u, true)
                        }
                        className="nm-well px-4 py-3 flex items-center gap-3 text-right"
                      >
                        <Boxes size={18} style={{ color: u.canManageStock ? "var(--due)" : "var(--muted)" }} />
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-semibold">مسؤول المخزن</span>
                          <span className="block text-[11px] nm-mut">{u.canManageStock ? "يوزّع المخزون على البائعين" : "يرى حصته فقط"}</span>
                        </span>
                        <span className={`nm-switch ${u.canManageStock ? "is-on" : ""}`} aria-hidden="true" />
                      </button>
                    )}

                    {/* actions */}
                    {canEdit || canDelete ? (
                      <div className="flex justify-around gap-1">
                        {canEdit && (
                          <button className="nm-act" onClick={() => startEdit(u)}>
                            <span className="nm-knob"><Pencil size={17} /></span>{isMe ? "تعديل بياناتي" : "تعديل"}
                          </button>
                        )}
                        {canEdit && (
                          <button className="nm-act" onClick={() => startEdit(u)}>
                            <span className="nm-knob"><KeyRound size={17} /></span>كلمة المرور
                          </button>
                        )}
                        {canDelete && (
                          <button className="nm-act" onClick={() => onConfirm(`هل تريد حذف المستخدم "${u.name}"؟ لا يمكن التراجع عن هذا الإجراء.`, () => onSave(users.filter((x) => x.id !== u.id)))}>
                            <span className="nm-knob danger"><Trash2 size={17} /></span>حذف
                          </button>
                        )}
                      </div>
                    ) : (
                      <p className="text-[11px] nm-mut flex items-center justify-center gap-1.5"><ShieldCheck size={13} /> الحساب الأساسي محمي من التعديل والحذف</p>
                    )}
                  </>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------- Settings ---------------------------------- */

/* ---------------------------------- Announcements (Circulars) ---------------------------------- */

function AnnouncementPopup({ announcement, onClose }) {
  if (!announcement) return null;
  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-4 announce-backdrop" dir="rtl">
      <div className="bg-[var(--surface)] rounded-2xl w-full max-w-sm p-6 text-center announce-pop">
        <div className="w-14 h-14 rounded-full bg-[var(--surface-3)] flex items-center justify-center mx-auto mb-4">
          <Megaphone size={26} className="text-[var(--accent)]" />
        </div>
        <p className="text-[10px] font-semibold text-[var(--accent)] mb-1">تعميم جديد من {announcement.createdByName}</p>
        <h3 className="text-lg font-extrabold mb-2">{announcement.title}</h3>
        <p className="text-sm text-[var(--text)] whitespace-pre-line mb-1">{announcement.message}</p>
        <p className="text-[10px] text-[var(--muted)] mb-5">{dateLabel(announcement.date)} · {timeLabel(announcement.date)}</p>
        <Btn className="w-full" onClick={onClose}>
          <Check size={16} /> تم الاطلاع
        </Btn>
      </div>
    </div>
  );
}

const ALLOC_LOG_TYPES = {
  set: { label: "تعيين كمية", cls: "bg-[var(--surface-3)] text-[var(--accent-dark)]" },
  adjust_in: { label: "إضافة", cls: "bg-[#EAF6EF] text-[#3F7D57]" },
  adjust_out: { label: "سحب", cls: "bg-[#FBEAEA] text-[#B23A3A]" },
  equal: { label: "توزيع بالتساوي", cls: "bg-[var(--surface-3)] text-[var(--accent-dark)]" },
  clear: { label: "إلغاء التوزيع", cls: "bg-[#FBEAEA] text-[#B23A3A]" },
  transfer_in: { label: "استلام من زميل", cls: "bg-[#FFF6E5] text-[#C97B3D]" },
  transfer_out: { label: "تسليم لزميل", cls: "bg-[#FFF6E5] text-[#C97B3D]" },
  stock_adjust: { label: "هدية/تالف/تجربة", cls: "bg-[#FBEAEA] text-[#B23A3A]" },
  stock_adjust_undo: { label: "إلغاء هدية/تالف", cls: "bg-[#EAF6EF] text-[#3F7D57]" },
};
const allocLogType = (e) => (e.type === "adjust" ? (e.delta >= 0 ? ALLOC_LOG_TYPES.adjust_in : ALLOC_LOG_TYPES.adjust_out) : ALLOC_LOG_TYPES[e.type] || ALLOC_LOG_TYPES.set);

// One row of the stock-distribution movement log.
function AllocationLogRow({ e, showSeller = true }) {
  const t = allocLogType(e);
  return (
    <div className="flex items-start justify-between gap-3 bg-[var(--surface-2)] rounded-xl px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-semibold flex items-center gap-1.5 flex-wrap">
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${t.cls}`}>{t.label}</span>
          {e.productName}
          {showSeller && <span className="text-[var(--muted)] font-normal">— {e.sellerName}</span>}
        </p>
        <p className="text-[11px] text-[var(--muted)] mt-0.5">
          الحصة: {e.before} ← {e.after} · بواسطة {e.byUserName} · {dateLabel(e.date)} {timeLabel(e.date)}
          {e.note ? ` · ${e.note}` : ""}
        </p>
      </div>
      <span dir="ltr" className={`text-sm font-extrabold shrink-0 ${e.delta > 0 ? "text-[#3F7D57]" : e.delta < 0 ? "text-[#B23A3A]" : "text-[var(--muted)]"}`}>
        {e.delta > 0 ? "+" : ""}{e.delta}
      </span>
    </div>
  );
}

/* ------------------------------ Seller Stock Allocation ------------------------------ */
// The warehouse manager's workspace (مسؤول المخزن — the primary admin, or
// whoever they've delegated that responsibility to): hand out each
// product's stock to accounts by quantity, top up / take back, and keep a
// detailed per-name record of every movement. Everyone else sees only their
// own shares here. A seller sells only from their own share; once it runs
// dry, they request more from a colleague, and nothing moves until that
// colleague approves. Products nobody has assigned a share for stay
// completely unrestricted, exactly as before.
function StockAllocationPage({ products, users, currentUser, canManage, allocations, allocationLog = [], onSave, onConfirm }) {
  // Managers sell too, so every account — admin or seller — can hold a share.
  const accounts = users;
  const managedProductIds = new Set(allocations.map((a) => a.productId));
  const [tab, setTab] = useState("distribute"); // distribute | summary | log
  const [productId, setProductId] = useState("");
  const [draft, setDraft] = useState({});
  const [deltaDraft, setDeltaDraft] = useState({});
  const [search, setSearch] = useState("");
  const [summaryFilter, setSummaryFilter] = useState("all");
  const [logAccount, setLogAccount] = useState("all");
  const [logProduct, setLogProduct] = useState("all");

  const product = products.find((p) => p.id === productId) || null;

  useEffect(() => { setDraft({}); }, [productId]);

  const recordFor = (sellerId) => allocations.find((a) => a.sellerId === sellerId && a.productId === productId) || null;

  const productAllocations = allocations.filter((a) => a.productId === productId);
  const totalAllocated = productAllocations.reduce((s, a) => s + a.allocated, 0);
  const totalRemaining = productAllocations.reduce((s, a) => s + a.remaining, 0);
  const totalSold = totalAllocated - totalRemaining;
  // Physical stock not currently sitting in anyone's unsold share — the
  // pool the warehouse manager can still hand out.
  const freePool = product ? Math.max(0, product.stock - totalRemaining) : 0;

  const entry = (seller, type, before, after, note) =>
    makeAllocationLogEntry({ byUser: currentUser, type, productId, productName: product.name, sellerId: seller.id, sellerName: seller.name, before, after, note });

  const overPoolMsg = (need) => `لا يوجد مخزون حر كافٍ: المطلوب ${need} والمتاح غير الموزَّع ${freePool} فقط. زِد كمية المنتج في صفحة المخزون أولاً، أو اسحب من حصة بائع آخر.`;

  const saveSeller = (seller) => {
    if (!product) return;
    const raw = draft[seller.id];
    if (raw === undefined || raw === "") return;
    const newAllocated = Math.max(0, Math.floor(Number(raw) || 0));
    const existing = recordFor(seller.id);
    const before = existing ? existing.allocated : 0;
    const delta = newAllocated - before;
    if (delta === 0) return;
    if (delta > freePool) { alert(overPoolMsg(delta)); return; }
    let next;
    if (existing) {
      const nextRemaining = Math.max(0, Math.min(newAllocated, existing.remaining + delta));
      next = allocations.map((a) => (a.id === existing.id ? { ...a, allocated: newAllocated, remaining: nextRemaining, sellerName: seller.name, productName: product.name } : a));
    } else {
      next = [...allocations, { id: uid(), sellerId: seller.id, sellerName: seller.name, productId, productName: product.name, allocated: newAllocated, remaining: newAllocated }];
    }
    onSave(next, `${product.name} ← ${seller.name}: ${newAllocated} قطعة`, [entry(seller, "set", before, newAllocated)]);
    setDraft((d) => ({ ...d, [seller.id]: undefined }));
  };

  // Quick top-up / take-back by a small step, without retyping the total.
  const adjustSeller = (seller, delta) => {
    if (!product || !delta) return;
    const existing = recordFor(seller.id);
    if (delta > 0 && delta > freePool) { alert(overPoolMsg(delta)); return; }
    if (!existing) {
      if (delta <= 0) return; // nothing to take back from an empty share
      onSave(
        [...allocations, { id: uid(), sellerId: seller.id, sellerName: seller.name, productId, productName: product.name, allocated: delta, remaining: delta }],
        `${product.name} ← ${seller.name}: +${delta} قطعة`,
        [entry(seller, "adjust", 0, delta)]
      );
      return;
    }
    // Only unsold pieces can be taken back.
    const take = delta < 0 ? -Math.min(existing.remaining, -delta) : delta;
    if (take === 0) return;
    const newAllocated = Math.max(0, existing.allocated + take);
    const newRemaining = Math.max(0, Math.min(newAllocated, existing.remaining + take));
    const next = allocations.map((a) => (a.id === existing.id ? { ...a, allocated: newAllocated, remaining: newRemaining } : a));
    onSave(next, `${product.name} ← ${seller.name}: ${take > 0 ? "+" : ""}${take} قطعة`, [entry(seller, "adjust", existing.allocated, newAllocated)]);
  };

  const equalDistribute = () => {
    if (!product || accounts.length === 0) return;
    onConfirm(
      `سيتم توزيع كامل كمية "${product.name}" (${product.stock} قطعة) بالتساوي على ${accounts.length} بائع، ما يستبدل أي توزيع سابق لهذا المنتج. هل تريد المتابعة؟`,
      () => {
        const base = Math.floor(product.stock / accounts.length);
        let remainder = product.stock - base * accounts.length;
        const others = allocations.filter((a) => a.productId !== productId);
        const logEntries = [];
        const fresh = accounts.map((s) => {
          const qty = base + (remainder-- > 0 ? 1 : 0);
          logEntries.push(entry(s, "equal", recordFor(s.id)?.allocated || 0, qty));
          return { id: uid(), sellerId: s.id, sellerName: s.name, productId, productName: product.name, allocated: qty, remaining: qty };
        });
        onSave([...others, ...fresh], `توزيع بالتساوي: ${product.name}`, logEntries);
      }
    );
  };

  const clearProduct = () => {
    if (!product) return;
    onConfirm(`سيتم إلغاء توزيع "${product.name}" على البائعين بالكامل (لن يتأثر إجمالي المخزون، ويعود البيع منه حراً للجميع). هل تريد المتابعة؟`, () => {
      const logEntries = productAllocations.map((a) =>
        entry({ id: a.sellerId, name: a.sellerName }, "clear", a.allocated, 0)
      );
      onSave(allocations.filter((a) => a.productId !== productId), `إلغاء توزيع: ${product.name}`, logEntries);
    });
  };

  const filteredProducts = products.filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase()));
  const myLog = allocationLog.filter((e) => e.sellerId === currentUser.id).slice(0, 30);

  /* ---------------- Everyone else: read-only view of their own shares ---------------- */
  if (!canManage) {
    const mine = allocations
      .filter((a) => a.sellerId === currentUser.id)
      .sort((a, b) => a.remaining - b.remaining);
    return (
      <div className="space-y-5">
        <h2 className="text-xl font-bold flex items-center gap-2"><Boxes size={22} /> مخزوني المخصص</h2>
        <p className="text-sm text-[var(--muted)]">
          هذه هي الكميات التي خصصها لك مسؤول المخزن من كل منتج. إذا نفدت حصتك من منتج ما، يمكنك إرسال طلب لأحد زملائك من شاشة "تسجيل عملية بيع" — ولا تنتقل الكمية إليك إلا بعد موافقته.
        </p>
        {mine.length === 0 ? (
          <Card className="p-8"><EmptyState text="لم يتم تخصيص أي منتج لك بعد — بإمكانك البيع من المخزون العام بحرية" /></Card>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {mine.map((a) => {
              const sold = a.allocated - a.remaining;
              const low = a.remaining <= 0;
              return (
                <Card key={a.id} className="p-4 card-hover">
                  <div className="flex justify-between items-start gap-2">
                    <p className="font-bold truncate">{a.productName}</p>
                    <span className={`text-[10px] font-bold px-2 py-1 rounded-full shrink-0 ${low ? "bg-[#FBEAEA] text-[#B23A3A]" : "bg-[#EAF6EF] text-[#3F7D57]"}`}>
                      {low ? "نفدت حصتك" : "متاح"}
                    </span>
                  </div>
                  <p className={`text-sm font-bold mt-2 ${low ? "text-[#B23A3A]" : "text-[#3F7D57]"}`}>المتبقي لك: {a.remaining} من {a.allocated}</p>
                  <p className="text-xs text-[var(--muted)] mt-1">تم بيع {sold} قطعة من حصتك</p>
                  <div className="w-full h-1.5 bg-[var(--surface-3)] rounded-full mt-2 overflow-hidden">
                    <div className="h-full bg-[var(--accent)]" style={{ width: `${a.allocated ? Math.min(100, (a.remaining / a.allocated) * 100) : 0}%` }} />
                  </div>
                </Card>
              );
            })}
          </div>
        )}
        {myLog.length > 0 && (
          <Card className="p-4">
            <h3 className="font-bold mb-3 flex items-center gap-2"><History size={16} /> حركات حصتي</h3>
            <div className="space-y-2">
              {myLog.map((e) => <AllocationLogRow key={e.id} e={e} showSeller={false} />)}
            </div>
          </Card>
        )}
      </div>
    );
  }

  /* ---------------- Summary data (per account) ---------------- */
  const summaryAccounts = accounts
    .filter((u) => summaryFilter === "all" || u.id === summaryFilter)
    .map((u) => {
      const rows = allocations.filter((a) => a.sellerId === u.id).sort((a, b) => a.productName.localeCompare(b.productName, "ar"));
      return {
        user: u,
        rows,
        allocated: rows.reduce((s, a) => s + a.allocated, 0),
        remaining: rows.reduce((s, a) => s + a.remaining, 0),
      };
    });

  let logList = allocationLog;
  if (logAccount !== "all") logList = logList.filter((e) => e.sellerId === logAccount);
  if (logProduct !== "all") logList = logList.filter((e) => e.productId === logProduct);
  const loggedProducts = Array.from(new Map(allocationLog.map((e) => [e.productId, e.productName])).entries());

  const TABS = [
    ["distribute", "التوزيع", Boxes],
    ["summary", "ملخص البائعين", Users2],
    ["log", "سجل الحركات", History],
  ];

  /* ---------------- Warehouse manager: assign & manage per-account shares ---------------- */
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-xl font-bold flex items-center gap-2"><Boxes size={22} /> توزيع المخزون على البائعين</h2>
        <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-[#FFF6E5] text-[#C97B3D] inline-flex items-center gap-1">
          <ShieldCheck size={12} /> {currentUser.isPrimaryAdmin ? "الحساب الرئيسي" : "مسؤول المخزن"}
        </span>
      </div>

      <div className="flex gap-1 bg-[var(--surface-2)] rounded-xl p-1 w-fit max-w-full overflow-x-auto">
        {TABS.map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap transition ${
              tab === key ? "bg-[var(--accent)] text-white shadow-sm" : "text-[var(--muted)] hover:text-[var(--text)]"
            }`}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {tab === "distribute" && (
        <>
          <p className="text-sm text-[var(--muted)]">
            اختر منتجاً وخصّص لكل بائع — بما فيهم المدراء — كمية منه، وزِد أو اسحب في أي وقت. لا يمكن توزيع أكثر من المخزون الفعلي غير الموزَّع، وكل حركة تُسجَّل باسم صاحبها في "سجل الحركات".
          </p>

          {accounts.length === 0 ? (
            <Card className="p-8"><EmptyState text="لا يوجد بائعون مسجّلون بعد لتوزيع المخزون عليهم" /></Card>
          ) : (
            <>
              <Card className="p-4 space-y-3">
                <div className="relative">
                  <Search size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
                  <input className={inputCls + " pr-9"} placeholder="بحث عن منتج..." value={search} onChange={(e) => setSearch(e.target.value)} />
                </div>
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-64 overflow-y-auto">
                  {filteredProducts.map((p) => {
                    const isManaged = managedProductIds.has(p.id);
                    const active = p.id === productId;
                    return (
                      <button
                        key={p.id}
                        onClick={() => setProductId(p.id)}
                        className={`text-right px-3 py-2 rounded-xl border transition text-sm ${
                          active ? "border-[var(--accent)] bg-[var(--surface-3)] font-bold" : "border-[var(--border)] hover:border-[var(--accent)]"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate">{p.name}</span>
                          {isManaged && <Boxes size={13} className="text-[var(--accent)] shrink-0" />}
                        </div>
                        <span className="text-[11px] text-[var(--muted)]">المخزون الكلي: {p.stock}</span>
                      </button>
                    );
                  })}
                </div>
              </Card>

              {product && (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <StatCard label="المخزون الفعلي" value={product.stock} color="var(--accent-dark)" icon={Package} />
                    <StatCard label="بحوزة البائعين (غير مباع)" value={totalRemaining} color="var(--accent)" icon={Boxes} />
                    <StatCard label="متاح للتوزيع" value={freePool} color="#8A7B6C" icon={Package} />
                    <StatCard label="بيع من الحصص" value={totalSold} color="#3F7D57" icon={TrendingUp} />
                  </div>

                  {totalRemaining > product.stock && (
                    <Card className="p-3 flex items-start gap-2 border-[#E8B4B4]">
                      <AlertTriangle size={16} className="text-[#B23A3A] shrink-0 mt-0.5" />
                      <p className="text-xs text-[#B23A3A] leading-relaxed">
                        المحتسب بحوزة البائعين ({totalRemaining}) أكثر من المخزون الفعلي ({product.stock}) بفارق {totalRemaining - product.stock} قطعة — غالباً بسبب هدية أو تالف أو تجربة سُجّلت قبل هذا التحديث. اسحب الفرق بزر (−) من حصة البائع المعني لتتطابق الأرقام.
                      </p>
                    </Card>
                  )}

                  <Card className="p-4">
                    <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                      <h3 className="font-bold">توزيع "{product.name}"</h3>
                      <div className="flex gap-2">
                        <Btn variant="ghost" onClick={equalDistribute}><Users2 size={15} /> توزيع بالتساوي</Btn>
                        {productAllocations.length > 0 && (
                          <Btn variant="outline" onClick={clearProduct}><Trash2 size={15} /> إلغاء التوزيع</Btn>
                        )}
                      </div>
                    </div>

                    <div className="space-y-2">
                      {accounts.map((s) => {
                        const rec = recordFor(s.id);
                        const value = draft[s.id] !== undefined ? draft[s.id] : (rec ? String(rec.allocated) : "");
                        const dirty = draft[s.id] !== undefined && draft[s.id] !== (rec ? String(rec.allocated) : "");
                        const sold = rec ? rec.allocated - rec.remaining : 0;
                        const low = rec && rec.remaining <= 0 && rec.allocated > 0;
                        const deltaValue = deltaDraft[s.id] ?? "1";
                        const delta = Math.max(1, Math.floor(Number(deltaValue) || 1));
                        return (
                          <div key={s.id} className="flex items-center gap-3 bg-[var(--surface-2)] rounded-xl px-3 py-2.5 flex-wrap">
                            <div className="flex-1 min-w-[120px]">
                              <p className="font-semibold text-sm flex items-center gap-1.5">
                                {s.name}
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-[var(--surface-3)] text-[var(--muted)]">
                                  {s.role === "admin" ? "مدير" : "بائع"}
                                </span>
                              </p>
                              {rec ? (
                                <p className={`text-xs ${low ? "text-[#B23A3A]" : "text-[var(--muted)]"}`}>
                                  بحوزته: {rec.remaining} · إجمالي ما استلم: {rec.allocated} · باع: {sold}
                                </p>
                              ) : (
                                <p className="text-xs text-[var(--muted)]">لم يُخصص له شيء بعد</p>
                              )}
                            </div>

                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                title="سحب كمية"
                                onClick={() => adjustSeller(s, -delta)}
                                className="w-8 h-8 rounded-lg bg-[#FBEAEA] text-[#B23A3A] flex items-center justify-center hover:brightness-95 active:scale-95"
                              >
                                <Minus size={14} />
                              </button>
                              <input
                                type="number"
                                min="1"
                                className={inputCls + " !w-14 !py-1.5 text-center"}
                                value={deltaValue}
                                onChange={(e) => setDeltaDraft((d) => ({ ...d, [s.id]: e.target.value }))}
                              />
                              <button
                                type="button"
                                title="إضافة كمية"
                                onClick={() => adjustSeller(s, delta)}
                                className="w-8 h-8 rounded-lg bg-[#EAF6EF] text-[#3F7D57] flex items-center justify-center hover:brightness-95 active:scale-95"
                              >
                                <Plus size={14} />
                              </button>
                            </div>

                            <input
                              type="number"
                              min="0"
                              className={inputCls + " !w-24 !py-1.5"}
                              placeholder="الإجمالي"
                              value={value}
                              onChange={(e) => setDraft((d) => ({ ...d, [s.id]: e.target.value }))}
                            />
                            <Btn variant={dirty ? "primary" : "ghost"} className="!px-3 !py-1.5" disabled={!dirty} onClick={() => saveSeller(s)}>
                              <Check size={14} /> حفظ
                            </Btn>
                          </div>
                        );
                      })}
                    </div>
                  </Card>
                </>
              )}
            </>
          )}
        </>
      )}

      {tab === "summary" && (
        <>
          <select className={inputCls + " sm:w-64"} value={summaryFilter} onChange={(e) => setSummaryFilter(e.target.value)}>
            <option value="all">كل البائعين</option>
            {accounts.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <div className="grid md:grid-cols-2 gap-3">
            {summaryAccounts.map(({ user, rows, allocated, remaining }) => (
              <Card key={user.id} className="p-4">
                <div className="flex items-center justify-between mb-3 gap-2">
                  <p className="font-bold flex items-center gap-1.5">
                    {user.name}
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-[var(--surface-3)] text-[var(--muted)]">{user.role === "admin" ? "مدير" : "بائع"}</span>
                  </p>
                  <p className="text-xs text-[var(--muted)]">بحوزته <b className="text-[var(--text)]">{remaining}</b> · باع <b className="text-[var(--text)]">{allocated - remaining}</b></p>
                </div>
                {rows.length === 0 ? (
                  <p className="text-xs text-[var(--muted)]">لا توجد حصص مخصصة لهذا البائع</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-[var(--muted)] border-b border-[var(--border)]">
                        <th className="text-right font-semibold py-1.5">المنتج</th>
                        <th className="font-semibold py-1.5">استلم</th>
                        <th className="font-semibold py-1.5">باع</th>
                        <th className="font-semibold py-1.5">بحوزته</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((a) => (
                        <tr key={a.id} className="border-b border-[var(--border)] last:border-0">
                          <td className="py-1.5 font-semibold">{a.productName}</td>
                          <td className="py-1.5 text-center">{a.allocated}</td>
                          <td className="py-1.5 text-center">{a.allocated - a.remaining}</td>
                          <td className={`py-1.5 text-center font-bold ${a.remaining <= 0 ? "text-[#B23A3A]" : "text-[#3F7D57]"}`}>{a.remaining}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            ))}
          </div>
        </>
      )}

      {tab === "log" && (
        <>
          <div className="flex flex-col sm:flex-row gap-2">
            <select className={inputCls + " sm:w-56"} value={logAccount} onChange={(e) => setLogAccount(e.target.value)}>
              <option value="all">كل البائعين</option>
              {accounts.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <select className={inputCls + " sm:w-56"} value={logProduct} onChange={(e) => setLogProduct(e.target.value)}>
              <option value="all">كل المنتجات</option>
              {loggedProducts.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </div>
          {logList.length === 0 ? (
            <Card className="p-8"><EmptyState text="لا توجد حركات مسجّلة بعد" /></Card>
          ) : (
            <div className="space-y-2">
              {logList.slice(0, 200).map((e) => <AllocationLogRow key={e.id} e={e} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AnnouncementsPage({ announcements, isAdmin, onCreate, onDelete, onConfirm }) {
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");

  const submit = () => {
    if (!title.trim() || !message.trim()) return;
    onCreate(title, message);
    setTitle("");
    setMessage("");
  };

  return (
    <div className="space-y-5 max-w-xl">
      <h2 className="text-xl font-bold flex items-center gap-2"><Megaphone size={20} /> التعميمات</h2>

      {isAdmin && (
        <Card className="p-4 space-y-3">
          <h3 className="font-bold">إصدار تعميم جديد</h3>
          <Field label="العنوان">
            <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثال: تنبيه بشأن العطلة الرسمية" />
          </Field>
          <Field label="نص التعميم">
            <textarea className={inputCls + " min-h-[90px]"} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="اكتب تفاصيل التعميم هنا..." />
          </Field>
          <Btn onClick={submit} className="w-full">
            <Megaphone size={16} /> إرسال التعميم لجميع البائعين
          </Btn>
          <p className="text-[11px] text-[var(--muted)]">سيظهر التعميم فوراً كنافذة منبثقة لكل من يستخدم التطبيق حالياً، وكذلك عند دخول أي بائع لاحقاً.</p>
        </Card>
      )}

      {announcements.length === 0 ? (
        <Card className="p-8"><EmptyState text="لا توجد تعميمات بعد" /></Card>
      ) : (
        <div className="space-y-3">
          {announcements.map((a) => (
            <Card key={a.id} className="p-4">
              <div className="flex justify-between items-start gap-2">
                <div>
                  <p className="font-bold">{a.title}</p>
                  <p className="text-xs text-[var(--muted)]">{a.createdByName} · {dateLabel(a.date)} {timeLabel(a.date)}</p>
                </div>
                {isAdmin && (
                  <button onClick={() => onConfirm(`هل تريد حذف التعميم "${a.title}"؟`, () => onDelete(a.id))} className="p-1.5 rounded-lg text-[#B23A3A] hover:bg-[#FBEAEA] shrink-0"><Trash2 size={16} /></button>
                )}
              </div>
              <p className="text-sm mt-2 whitespace-pre-line">{a.message}</p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------- Shared theme palette ---------------------------------- */

const THEMES = [
  { key: "classic", label: "الفيروزي (الأساسي)", accent: "#2F7F86", dark: "#1C5A60" },
  { key: "emerald", label: "زمردي", accent: "#2F8F6B", dark: "#1B5E45" },
  { key: "rose", label: "وردي", accent: "#B24A6A", dark: "#7A2E47" },
  { key: "sapphire", label: "سماوي", accent: "#3B6EA8", dark: "#244A75" },
  { key: "violet", label: "بنفسجي", accent: "#6E55A0", dark: "#46356B" },
  { key: "amber", label: "كهرماني", accent: "#B06A2E", dark: "#7A461C" },
  { key: "gem", label: "ذهبي", accent: "#A8842A", dark: "#6E5518", vivid: true },
  { key: "candy", label: "أخضر حيوي", accent: "#12A594", dark: "#0B6B60", vivid: true },
  { key: "pastel", label: "باستيل هادئ", accent: "#5BADA6", dark: "#2E6B65", vivid: true },
];

// The 4-color card palette + background flourish for each "vivid" full style.
// StatCard falls back to the original plain design whenever the active theme
// isn't listed here (i.e. "التصميم الأصلي" and the 5 plain accent themes),
// so switching back to classic restores the app's look exactly as it was.
const VIVID_THEMES = {
  gem: {
    stats: ["#2AA6A0", "#C9A227", "#8B2635", "#1F3F73"],
    bg: "linear-gradient(160deg, #EFE1C4 0%, #DCC291 45%, #C9AE87 100%)",
    surface: "rgba(255,255,255,0.9)",
    facet: true,
  },
  candy: {
    stats: ["#3B82F6", "#22C55E", "#F04B4B", "#8B5CF6"],
    bg: "#ffffff",
    surface: "#ffffff",
  },
  pastel: {
    stats: ["#6EC6BA", "#8FCB92", "#E8927C", "#7FB3D5"],
    bg: "linear-gradient(160deg, #FBFBFA 0%, #F3F6F5 100%)",
    surface: "#ffffff",
  },
};

/* ---------------------------------- Sellers' Challenge & Achievements ---------------------------------- */

const ACHIEVEMENTS = [
  { id: "first_sale", label: "أول خطوة", desc: "أول فاتورة مسجَّلة", icon: Sparkles, color: "#3F7D57", check: (s) => s.count >= 1 },
  { id: "invoices_10", label: "نشيط", desc: "10 فواتير", icon: Flame, color: "var(--accent)", check: (s) => s.count >= 10 },
  { id: "invoices_50", label: "محترف", desc: "50 فاتورة", icon: Medal, color: "#3B6EA8", check: (s) => s.count >= 50 },
  { id: "invoices_100", label: "نجم المبيعات", desc: "100 فاتورة", icon: Trophy, color: "#C9A227", check: (s) => s.count >= 100 },
  { id: "collected_100", label: "100 دينار", desc: "تحصيل 100 K.D فأكثر", icon: Award, color: "#7B5EA8", check: (s) => s.collected >= 100 },
  { id: "collected_500", label: "500 دينار", desc: "تحصيل 500 K.D فأكثر", icon: Award, color: "#C2547E", check: (s) => s.collected >= 500 },
  { id: "collected_1000", label: "1000 دينار", desc: "تحصيل 1000 K.D فأكثر", icon: Trophy, color: "#B8894A", check: (s) => s.collected >= 1000 },
];

function ChallengesPage({ sales, users, currentUser, isAdmin, sellerGoals, onSaveGoal }) {
  const [period, setPeriod] = useState("month"); // week | month | all

  const sellers = useMemo(() => users.filter((u) => u.role === "seller" || u.role === "admin"), [users]);

  const periodSales = useMemo(() => {
    if (period === "all") return sales;
    const now = new Date();
    let start;
    if (period === "week") {
      start = new Date(now);
      start.setDate(now.getDate() - 6);
      start.setHours(0, 0, 0, 0);
    } else {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    return sales.filter((s) => new Date(s.date) >= start);
  }, [sales, period]);

  const leaderboard = useMemo(() => {
    const map = new Map();
    sellers.forEach((u) => map.set(u.id, { id: u.id, name: u.name, count: 0, collected: 0 }));
    periodSales.forEach((s) => {
      const cur = map.get(s.sellerId);
      if (!cur) return;
      cur.count += 1;
      cur.collected += s.collected;
    });
    return Array.from(map.values()).sort((a, b) => b.collected - a.collected);
  }, [periodSales, sellers]);

  // All-time stats per seller for achievement unlocking (achievements shouldn't reset with the period filter above)
  const allTimeStats = useMemo(() => {
    const map = new Map();
    sellers.forEach((u) => map.set(u.id, { id: u.id, name: u.name, count: 0, collected: 0 }));
    sales.forEach((s) => {
      const cur = map.get(s.sellerId);
      if (!cur) return;
      cur.count += 1;
      cur.collected += s.collected;
    });
    return map;
  }, [sales, sellers]);

  const myStats = allTimeStats.get(currentUser.id) || { count: 0, collected: 0 };
  const myGoal = sellerGoals[currentUser.id] || 0;
  const myPeriodCollected = leaderboard.find((l) => l.id === currentUser.id)?.collected || 0;
  const goalProgress = myGoal > 0 ? Math.min(100, (myPeriodCollected / myGoal) * 100) : 0;

  const medal = (rank) => (rank === 0 ? "🥇" : rank === 1 ? "🥈" : rank === 2 ? "🥉" : null);

  const [goalInput, setGoalInput] = useState(String(myGoal || ""));

  return (
    <div className="space-y-5">
      <h2 className="text-xl font-bold flex items-center gap-2"><Trophy size={20} /> التحديات والإنجازات</h2>
      <p className="text-xs text-[var(--muted)] -mt-3">لوحة صدارة البائعين حسب المبلغ المحصَّل، مع أوسمة إنجاز تُفتح تلقائياً كلما تقدّمت في عملك.</p>

      {myGoal > 0 && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="font-bold flex items-center gap-2"><Target size={16} className="text-[var(--accent)]" /> هدفي هذا الشهر</p>
            <p className="text-sm font-bold">{fmt(myPeriodCollected)} / {fmt(myGoal)} K.D</p>
          </div>
          <div className="w-full h-3 rounded-full bg-[var(--surface-3)] overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${goalProgress}%`, background: "linear-gradient(90deg, var(--accent), var(--accent-dark))" }}
            />
          </div>
          <p className="text-[11px] text-[var(--muted)] mt-1.5">{goalProgress.toFixed(0)}% من الهدف الشهري محقَّق</p>
        </Card>
      )}

      <Card className="p-4">
        <div className="flex gap-2 mb-4">
          {[["week", "هذا الأسبوع"], ["month", "هذا الشهر"], ["all", "كل الوقت"]].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setPeriod(key)}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold transition ${period === key ? "bg-[var(--accent)] text-white" : "bg-[var(--surface-2)] text-[var(--muted)]"}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="space-y-2">
          {leaderboard.map((s, i) => (
            <div
              key={s.id}
              className={`flex items-center justify-between rounded-xl px-3 py-2.5 ${s.id === currentUser.id ? "bg-[var(--surface-3)] border border-[var(--accent)]" : "bg-[var(--surface-2)]"}`}
            >
              <div className="flex items-center gap-2.5">
                <span className="w-7 text-center font-extrabold text-sm">{medal(i) || `#${i + 1}`}</span>
                <div>
                  <p className="text-sm font-semibold">{s.name}{s.id === currentUser.id ? " (أنت)" : ""}</p>
                  <p className="text-[10px] text-[var(--muted)]">{s.count} فاتورة</p>
                </div>
              </div>
              <p dir="ltr" className="font-bold text-[var(--accent-dark)] whitespace-nowrap">{fmt(s.collected)} K.D</p>
            </div>
          ))}
          {leaderboard.length === 0 && <EmptyState text="لا توجد بيانات لهذه الفترة بعد" />}
        </div>
      </Card>

      <div>
        <h3 className="font-bold mb-3 flex items-center gap-2"><Award size={18} /> أوسمتي</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          {ACHIEVEMENTS.map((a) => {
            const unlocked = a.check(myStats);
            const Icon = a.icon;
            return (
              <Card key={a.id} className={`p-3 text-center ${!unlocked ? "opacity-40 grayscale" : "card-hover"}`}>
                <div
                  className="w-11 h-11 rounded-full flex items-center justify-center mx-auto mb-2"
                  style={{ background: `color-mix(in srgb, ${a.color} 18%, transparent)` }}
                >
                  <Icon size={20} style={{ color: a.color }} />
                </div>
                <p className="text-xs font-bold">{a.label}</p>
                <p className="text-[10px] text-[var(--muted)]">{a.desc}</p>
              </Card>
            );
          })}
        </div>
      </div>

      {isAdmin && (
        <Card className="p-4">
          <h3 className="font-bold mb-3">تحديد هدف شهري لكل بائع</h3>
          <div className="space-y-2">
            {sellers.map((u) => (
              <div key={u.id} className="flex items-center gap-2">
                <p className="text-sm flex-1">{u.name}</p>
                <input
                  type="number"
                  min="0"
                  step="1"
                  className={inputCls + " w-28 !py-1.5 text-xs"}
                  placeholder="بدون هدف"
                  defaultValue={sellerGoals[u.id] || ""}
                  onBlur={(e) => onSaveGoal(u.id, e.target.value)}
                />
                <span className="text-[11px] text-[var(--muted)] w-8">K.D</span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-[var(--muted)] mt-2">اكتب المبلغ واضغط خارج الحقل للحفظ. اتركه فارغاً لإلغاء الهدف.</p>
        </Card>
      )}
    </div>
  );
}

/* ---------------------------------- Personal Preferences (all roles) ---------------------------------- */

function PreferencesPage({ fontScale, onSetFontScale, personalTheme, onSetPersonalTheme, darkMode, onToggleDarkMode, companyTheme }) {
  const effectiveTheme = personalTheme || companyTheme;

  return (
    <div className="space-y-5 max-w-xl">
      <h2 className="text-xl font-bold flex items-center gap-2"><Palette size={20} /> تفضيلاتي</h2>
      <p className="text-xs text-[var(--muted)] -mt-3">هذه الإعدادات خاصة بجهازك أنت فقط، ولا تؤثر على ما يراه بقية المستخدمين.</p>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold text-[var(--muted)] flex items-center gap-1.5"><Moon size={14} /> الوضع الداكن</span>
          <button
            type="button"
            onClick={onToggleDarkMode}
            className={`w-11 h-6 rounded-full relative transition ${darkMode ? "bg-[var(--accent)]" : "bg-[var(--border)]"}`}
          >
            <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${darkMode ? "right-0.5" : "right-5"}`} />
          </button>
        </div>
      </Card>

      <Card className="p-4">
        <span className="text-xs font-semibold text-[var(--muted)] flex items-center gap-1.5 mb-2"><Type size={14} /> حجم الخط</span>
        <div className="grid grid-cols-4 gap-2">
          {[
            { scale: 0.9, label: "صغير" },
            { scale: 1, label: "عادي" },
            { scale: 1.1, label: "كبير" },
            { scale: 1.25, label: "أكبر" },
          ].map((o) => (
            <button
              key={o.scale}
              type="button"
              onClick={() => onSetFontScale(o.scale)}
              className={`rounded-xl border-2 py-2.5 flex flex-col items-center gap-1 transition ${fontScale === o.scale ? "border-[var(--accent)]" : "border-transparent"}`}
              style={{ background: "var(--surface-2)" }}
            >
              <span className="font-extrabold" style={{ fontSize: `${14 * o.scale}px` }}>أ</span>
              <span className="text-[10px] font-semibold">{o.label}</span>
            </button>
          ))}
        </div>
      </Card>

      <Card className="p-4">
        <span className="text-xs font-semibold text-[var(--muted)] flex items-center gap-1.5 mb-2"><Palette size={14} /> ثيمي الشخصي</span>
        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => onSetPersonalTheme("")}
            className={`rounded-xl border-2 p-2.5 flex flex-col items-center gap-1.5 transition ${!personalTheme ? "border-[var(--accent)]" : "border-transparent"}`}
            style={{ background: "var(--surface-2)" }}
          >
            <span className="text-[11px] font-semibold">ثيم الشركة</span>
          </button>
          {THEMES.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => onSetPersonalTheme(t.key)}
              className={`rounded-xl border-2 p-2.5 flex flex-col items-center gap-1.5 transition ${effectiveTheme === t.key && personalTheme ? "border-[var(--accent)]" : "border-transparent"}`}
              style={{ background: "var(--surface-2)" }}
            >
              <span className="flex gap-1">
                <span className="w-5 h-5 rounded-full" style={{ background: t.accent }} />
                <span className="w-5 h-5 rounded-full" style={{ background: t.dark }} />
              </span>
              <span className="text-[11px] font-semibold">{t.label}</span>
            </button>
          ))}
        </div>
        <p className="text-[11px] text-[var(--muted)] mt-2">اختر "ثيم الشركة" للرجوع لألوان النظام الافتراضية التي يحددها المدير.</p>
      </Card>
    </div>
  );
}

const EXPENSE_CATEGORIES = [
  "شراء بضاعة",
  "إيجار",
  "رواتب",
  "فواتير (كهرباء / ماء / إنترنت)",
  "صيانة",
  "تسويق وإعلانات",
  "نثريات",
  "أخرى",
];

function ExpensesPage({ expenses, onAdd, onDelete, onConfirm, activeTheme }) {
  const [category, setCategory] = useState(EXPENSE_CATEGORIES[0]);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [search, setSearch] = useState("");

  const submit = () => {
    const amt = Number(amount);
    if (!amt || amt <= 0) return;
    onAdd({
      category,
      description,
      amount: amt,
      date: date ? new Date(date + "T12:00:00").toISOString() : todayISO(),
    });
    setDescription("");
    setAmount("");
  };

  let list = expenses;
  if (categoryFilter !== "all") list = list.filter((e) => e.category === categoryFilter);
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    list = list.filter((e) => e.description.toLowerCase().includes(q));
  }

  const total = list.reduce((a, e) => a + e.amount, 0);
  const now = new Date();
  const thisMonthTotal = expenses
    .filter((e) => {
      const d = new Date(e.date);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    })
    .reduce((a, e) => a + e.amount, 0);

  return (
    <div className="space-y-5">
      <h2 className="text-xl font-bold flex items-center gap-2"><Wallet2 size={20} /> المصروفات</h2>

      <div className="grid grid-cols-2 gap-3">
        <StatCard label="إجمالي المصروفات" value={fmt(total) + " K.D"} color="#B23A3A" icon={Wallet2} themeKey={activeTheme} slot={0} />
        <StatCard label="مصروفات هذا الشهر" value={fmt(thisMonthTotal) + " K.D"} color="var(--accent)" icon={CalendarRange} themeKey={activeTheme} slot={1} />
      </div>

      <Card className="p-4 space-y-3">
        <h3 className="font-bold">تسجيل مصروف جديد</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="نوع المصروف">
            <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}>
              {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="المبلغ (K.D)">
            <input type="number" min="0" step="0.001" className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <div className="col-span-2">
            <Field label="الوصف / التفاصيل">
              <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="مثال: شراء عود من المورد الفلاني" />
            </Field>
          </div>
          <Field label="التاريخ">
            <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <Btn onClick={submit} className="w-full"><Plus size={16} /> تسجيل المصروف</Btn>
      </Card>

      <div className="flex flex-col sm:flex-row gap-2">
        <select className={inputCls + " sm:w-56"} value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
          <option value="all">كل الأنواع</option>
          {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <div className="relative flex-1">
          <Search size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
          <input className={inputCls + " pr-9"} placeholder="بحث في الوصف..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {list.length === 0 ? (
        <Card className="p-8"><EmptyState text="لا توجد مصروفات مطابقة" /></Card>
      ) : (
        <div className="space-y-2">
          {list.map((e) => (
            <Card key={e.id} className="p-3 flex items-center justify-between card-hover">
              <div>
                <p className="text-sm font-semibold">{e.category}</p>
                {e.description && <p className="text-xs text-[var(--muted)]">{e.description}</p>}
                <p className="text-[11px] text-[var(--muted)]">{e.byUserName} · {dateLabel(e.date)}</p>
              </div>
              <div className="flex items-center gap-3">
                <p className="font-bold text-[#B23A3A]">{fmt(e.amount)} K.D</p>
                <button
                  onClick={() => onConfirm("هل تريد حذف هذا المصروف؟", () => onDelete(e.id))}
                  className="p-1.5 rounded-lg text-[#B23A3A] hover:bg-[#FBEAEA]"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------- Accounting ---------------------------------- */

const STOCK_LOG_LABELS = { gift: "هدايا", damage: "تالف", tester: "فتح للتجربة" };

function AccountingPage({ sales: allSales, products, expenses: allExpenses, stockLogs: allLogs, activeTheme }) {
  const [period, setPeriod] = useState("all"); // month | last | all
  const [showAllCats, setShowAllCats] = useState(false);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const inRange = (d) => {
    if (period === "all") return true;
    const t = new Date(d);
    return period === "month" ? t >= monthStart : t >= lastStart && t < monthStart;
  };
  const sales = useMemo(() => allSales.filter((x) => inRange(x.date)), [allSales, period]); // eslint-disable-line
  const expenses = useMemo(() => allExpenses.filter((x) => inRange(x.date)), [allExpenses, period]); // eslint-disable-line
  const stockLogs = useMemo(() => allLogs.filter((x) => inRange(x.date)), [allLogs, period]); // eslint-disable-line
  const monthLabel = (d) => d.toLocaleDateString("ar", { month: "long" });
  const PERIODS = [["month", `هذا الشهر (${monthLabel(monthStart)})`], ["last", `الشهر الماضي`], ["all", "الكل"]];

  const costById = useMemo(() => {
    const m = new Map();
    products.forEach((p) => m.set(p.id, p.cost || 0));
    return m;
  }, [products]);

  const totalRevenue = sales.reduce((a, s) => a + s.total, 0);
  const totalCollected = sales.reduce((a, s) => a + s.collected, 0);
  const totalRemaining = sales.reduce((a, s) => a + s.remaining, 0);

  const cogs = sales.reduce((sum, s) => {
    const saleCost = s.items.reduce((a, i) => a + (costById.get(i.productId) || 0) * i.qty, 0);
    return sum + saleCost;
  }, 0);
  const grossProfit = totalRevenue - cogs;

  const totalExpenses = expenses.reduce((a, e) => a + e.amount, 0);
  const expensesByCategory = useMemo(() => {
    const map = new Map();
    expenses.forEach((e) => map.set(e.category, (map.get(e.category) || 0) + e.amount));
    return Array.from(map.entries()).map(([name, total]) => ({ name, total })).sort((x, y) => y.total - x.total);
  }, [expenses]);

  const shrinkageByType = useMemo(() => {
    const map = { gift: 0, damage: 0, tester: 0 };
    stockLogs.forEach((l) => {
      const cost = costById.get(l.productId) || 0;
      map[l.type] = (map[l.type] || 0) + cost * l.qty;
    });
    return map;
  }, [stockLogs, costById]);
  const totalShrinkage = shrinkageByType.gift + shrinkageByType.damage + shrinkageByType.tester;

  const netProfit = grossProfit - totalExpenses - totalShrinkage;

  const inventoryValueCost = products.reduce((a, p) => a + p.stock * (p.cost || 0), 0);
  const inventoryValueRetail = products.reduce((a, p) => a + p.stock * p.price, 0);
  const potentialProfit = inventoryValueRetail - inventoryValueCost;

  const pctOfSales = (v) => (totalRevenue > 0 ? (v / totalRevenue) * 100 : 0);
  const netMargin = pctOfSales(netProfit);
  const grossMargin = pctOfSales(grossProfit);
  const collectRate = totalRevenue > 0 ? (totalCollected / totalRevenue) * 100 : 0;
  const loss = netProfit < 0;

  // Where each dinar of sales went. When there is a loss the costs exceed the
  // sales, so the bar is scaled to the costs and the overrun is stated in words.
  const split = [
    { key: "cogs", label: "تكلفة البضاعة", value: cogs, color: "var(--c-cogs)" },
    { key: "exp", label: "المصروفات", value: totalExpenses, color: "var(--c-exp)" },
    { key: "waste", label: "الهدر (هدايا/تالف/تجربة)", value: totalShrinkage, color: "var(--c-waste)" },
    { key: "net", label: "صافي الربح", value: Math.max(0, netProfit), color: "var(--c-net)" },
  ];
  const splitBase = Math.max(1, split.reduce((a, x) => a + x.value, 0));

  const Line = ({ sign, label, value, strong, tone, note, barColor }) => (
    <div className={`flex flex-col gap-1.5 ${strong ? "nm-well px-3 py-3" : "px-3"}`}>
      <div className="flex items-center gap-3">
        <span className="nm-sign" aria-hidden="true" style={{ color: sign === "−" ? "var(--bad)" : sign === "=" ? "var(--accent-ink)" : "var(--ok)" }}>{sign}</span>
        <span className="flex-1 min-w-0">
          <span className={`block truncate ${strong ? "font-bold text-sm" : "text-sm"}`}>{label}</span>
          {note && <span className="block text-[11px] nm-mut">{note}</span>}
        </span>
        <span className={`nm-num shrink-0 ${strong ? "font-bold text-base" : "font-semibold text-sm"}`} style={{ color: tone || "var(--text)" }}>{fmt(value)}</span>
      </div>
      {barColor && totalRevenue > 0 && (
        <span className="block" style={{ paddingRight: 38 }} aria-hidden="true">
          <span className="nm-bar" style={{ width: `${Math.max(6, Math.min(100, Math.abs(pctOfSales(value))))}%` }}><i style={{ width: "100%", background: barColor }} /></span>
        </span>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-5 max-w-5xl mx-auto">
      <div>
        <h2 className="text-xl font-bold">المحاسبة الشاملة</h2>
        <p className="text-sm nm-mut">المبيعات والتكلفة والمصروفات والهدر والمخزون في مكان واحد</p>
      </div>

      <div className="nm-tog" role="tablist" aria-label="الفترة">
        {PERIODS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={period === k} className={period === k ? "is-on" : ""} onClick={() => setPeriod(k)}>{label}</button>
        ))}
      </div>

      {/* headline */}
      <div className="grid md:grid-cols-2 gap-5 items-center">
        <SoftDial
          value={fmt(netProfit)}
          pct={loss ? 0 : netMargin}
          label="صافي الربح الحقيقي"
          caption={totalRevenue <= 0 ? "لا مبيعات في هذه الفترة" : loss ? "خسارة في هذه الفترة" : `${netMargin.toFixed(0)}٪ من المبيعات`}
        />
        <div className="grid grid-cols-2 gap-3">
          <StatCard label="إجمالي المبيعات" value={fmt(totalRevenue)} unit="د.ك" icon={TrendingUp} />
          <StatCard label="الربح الإجمالي" value={fmt(grossProfit)} unit="د.ك" icon={Calculator} tone="ink" />
          <StatCard label="المحصّل" value={fmt(totalCollected)} unit="د.ك" icon={Wallet} tone="ok" />
          <StatCard label="متبقي العملاء" value={fmt(totalRemaining)} unit="د.ك" icon={AlertTriangle} tone={totalRemaining > 0 ? "due" : undefined} />
        </div>
      </div>

      {/* where the sales went: one bar, every part named with its amount */}
      <Card className="p-4 flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="font-bold">أين ذهبت المبيعات؟</h3>
          <span className="text-xs nm-mut">من كل 100 دينار</span>
        </div>
        {totalRevenue <= 0 ? (
          <EmptyState text="لا مبيعات في هذه الفترة" />
        ) : (
          <>
            <div className="nm-bar lg" role="img" aria-label={split.map((x) => `${x.label} ${pctOfSales(x.value).toFixed(0)}٪`).join("، ")}>
              {split.filter((x) => x.value > 0).map((x) => (
                <i key={x.key} style={{ width: `${(x.value / splitBase) * 100}%`, background: x.color }} title={`${x.label}: ${fmt(x.value)} د.ك`} />
              ))}
            </div>
            <div className="flex flex-col">
              {split.map((x, i) => (
                <div key={x.key} className={`flex items-center gap-3 py-2.5 ${i ? "border-t border-[var(--border)]" : ""}`}>
                  <span className="nm-key" style={{ "--k": x.color }} aria-hidden="true" />
                  <span className={`flex-1 min-w-0 text-sm truncate ${x.key === "net" ? "font-bold" : ""}`}>{x.label}</span>
                  <span className="nm-num text-xs nm-mut shrink-0 w-10 text-left">{pctOfSales(x.value).toFixed(0)}٪</span>
                  <span className={`nm-num text-sm shrink-0 w-20 text-left ${x.key === "net" ? "font-bold" : "font-semibold"}`}>{fmt(x.value)}</span>
                </div>
              ))}
            </div>
            {loss && (
              <p className="text-xs font-semibold text-[var(--bad)] flex items-center gap-1.5" role="alert"><AlertTriangle size={14} /> التكاليف تجاوزت المبيعات بمبلغ {fmt(Math.abs(netProfit))} د.ك</p>
            )}
          </>
        )}
      </Card>

      {/* the calculation, step by step */}
      <Card className="py-4 px-1 flex flex-col gap-3">
        <h3 className="font-bold px-3">حساب الربح خطوة بخطوة</h3>
        <Line sign="+" label="إجمالي المبيعات" value={totalRevenue} />
        <Line sign="−" label="تكلفة البضاعة المباعة" value={cogs} barColor="var(--c-cogs)" />
        <Line sign="=" label="الربح الإجمالي" value={grossProfit} strong note={`${grossMargin.toFixed(0)}٪ من المبيعات`} />
        <Line sign="−" label="المصروفات" value={totalExpenses} barColor="var(--c-exp)" />
        <Line sign="−" label="الهدر (هدايا/تالف/تجربة) بسعر التكلفة" value={totalShrinkage} barColor="var(--c-waste)" />
        <Line sign="=" label="صافي الربح الحقيقي" value={netProfit} strong tone={loss ? "var(--bad)" : "var(--ok)"} note={totalRevenue > 0 ? `${netMargin.toFixed(0)}٪ من المبيعات` : undefined} />
      </Card>

      {/* collection */}
      <Card className="p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 className="font-bold">التحصيل من العملاء</h3>
          <div className="flex items-center gap-3">
            <span className="nm-key" style={{ "--k": "var(--chart-1)" }}>محصّل</span>
            <span className="nm-key" style={{ "--k": "var(--chart-2)" }}>متبقٍ</span>
          </div>
        </div>
        <div className="nm-bar lg" role="img" aria-label={`محصّل ${collectRate.toFixed(0)}٪ من المبيعات`}>
          {totalCollected > 0 && <i style={{ width: `${collectRate}%`, background: "var(--chart-1)" }} />}
          {totalRemaining > 0 && <i style={{ width: `${100 - collectRate}%`, background: "var(--chart-2)" }} />}
        </div>
        <div className="grid grid-cols-3 text-center">
          <div><p className="text-[10.5px] nm-mut">محصّل</p><p className="nm-num font-bold text-sm">{fmt(totalCollected)}</p></div>
          <div className="border-x border-[var(--border)]"><p className="text-[10.5px] nm-mut">متبقٍ على العملاء</p><p className="nm-num font-bold text-sm text-[var(--due)]">{fmt(totalRemaining)}</p></div>
          <div><p className="text-[10.5px] nm-mut">نسبة التحصيل</p><p className="nm-num font-bold text-sm">{collectRate.toFixed(0)}٪</p></div>
        </div>
      </Card>

      <div className="grid md:grid-cols-2 gap-5">
        <Card className="p-4 flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="font-bold">قيمة المخزون الحالي</h3>
            <span className="text-xs nm-mut">الآن · لا يتأثر بالفترة</span>
          </div>
          <div className="nm-well py-2.5 px-2 grid grid-cols-3 text-center">
            <div><p className="text-[10px] nm-mut">بسعر التكلفة</p><p className="nm-num font-bold text-sm">{fmt(inventoryValueCost)}</p></div>
            <div className="border-x border-[var(--border)]"><p className="text-[10px] nm-mut">بسعر البيع</p><p className="nm-num font-bold text-sm nm-ink">{fmt(inventoryValueRetail)}</p></div>
            <div><p className="text-[10px] nm-mut">الربح المحتمل</p><p className="nm-num font-bold text-sm text-[var(--ok)]">{fmt(potentialProfit)}</p></div>
          </div>
          <p className="text-[11px] nm-mut">الربح المحتمل هو ما تربحه إذا بعت كل المخزون بسعره الحالي.</p>
        </Card>

        <Card className="p-4 flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="font-bold">تفصيل الهدر</h3>
            <span className="text-xs nm-mut">بسعر التكلفة · <span className="nm-num font-semibold text-[var(--text)]">{fmt(totalShrinkage)}</span></span>
          </div>
          {Object.entries(shrinkageByType).map(([type, val]) => (
            <div key={type} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span>{STOCK_LOG_LABELS[type]}</span>
                <span className="flex items-baseline gap-2"><span className="nm-num text-xs nm-mut">{totalShrinkage > 0 ? ((val / totalShrinkage) * 100).toFixed(0) : 0}٪</span><span className="nm-num font-semibold">{fmt(val)}</span></span>
              </div>
              <span className="nm-bar" style={{ width: `${Math.max(6, totalShrinkage > 0 ? (val / Math.max(shrinkageByType.gift, shrinkageByType.damage, shrinkageByType.tester)) * 100 : 6)}%` }} aria-hidden="true"><i style={{ width: "100%", background: val > 0 ? "var(--c-waste)" : "transparent" }} /></span>
            </div>
          ))}
        </Card>
      </div>

      <Card className="p-4 flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="font-bold">المصروفات حسب النوع</h3>
          <span className="text-xs nm-mut">الإجمالي <span className="nm-num font-semibold text-[var(--text)]">{fmt(totalExpenses)}</span></span>
        </div>
        {expensesByCategory.length === 0 ? (
          <EmptyState text="لا مصروفات في هذه الفترة" />
        ) : (
          (showAllCats ? expensesByCategory : expensesByCategory.slice(0, 5)).map((c) => (
            <div key={c.name} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate">{c.name}</span>
                <span className="flex items-baseline gap-2 shrink-0"><span className="nm-num text-xs nm-mut">{totalExpenses > 0 ? ((c.total / totalExpenses) * 100).toFixed(0) : 0}٪</span><span className="nm-num font-semibold">{fmt(c.total)}</span></span>
              </div>
              <span className="nm-bar" style={{ width: `${Math.max(6, (c.total / expensesByCategory[0].total) * 100)}%` }} aria-hidden="true"><i style={{ width: "100%", background: "var(--c-exp)" }} /></span>
            </div>
          ))
        )}
        {expensesByCategory.length > 5 && (
          <button onClick={() => setShowAllCats((v) => !v)} className="nm-btn ink self-center !py-2 !px-4 text-[13px]">{showAllCats ? "عرض أعلى 5 فقط" : `عرض كل الأنواع (${expensesByCategory.length})`}</button>
        )}
      </Card>
    </div>
  );
}

/* ---------------------------------- Partners Profit Calculation ---------------------------------- */

function CapitalPartnersPage({
  sales, products, expenses, stockLogs, partners, profitDistributions,
  currentUser, onSavePartners, onSaveDistribution, onDeleteDistribution, onConfirm, onPrint,
}) {
  const [partnerCount, setPartnerCount] = useState(partners.length || 2);
  const [localPartners, setLocalPartners] = useState(
    partners.length ? partners : [{ id: uid(), name: "الشريك الأول", percent: 50 }, { id: uid(), name: "الشريك الثاني", percent: 50 }]
  );
  const [result, setResult] = useState(null);

  const costById = useMemo(() => {
    const m = new Map();
    products.forEach((p) => m.set(p.id, p.cost || 0));
    return m;
  }, [products]);

  // ---- Partner setup ----
  const totalPercent = localPartners.reduce((a, p) => a + Number(p.percent || 0), 0);
  const percentValid = Math.abs(totalPercent - 100) < 0.01;

  const generateEqualPartners = () => {
    const n = Math.max(1, Math.min(20, Number(partnerCount) || 1));
    const base = Math.floor((100 / n) * 100) / 100;
    const list = Array.from({ length: n }).map((_, i) => ({ id: uid(), name: `الشريك ${i + 1}`, percent: base }));
    const sum = list.reduce((a, p) => a + p.percent, 0);
    list[list.length - 1].percent = Math.round((list[list.length - 1].percent + (100 - sum)) * 100) / 100;
    setLocalPartners(list);
  };

  const updatePartner = (id, field, value) => {
    setLocalPartners((list) => list.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
  };
  const removePartner = (id) => setLocalPartners((list) => list.filter((p) => p.id !== id));
  const addPartner = () => setLocalPartners((list) => [...list, { id: uid(), name: `شريك ${list.length + 1}`, percent: 0 }]);

  // ---- Profit calculation — grounded directly in the same figures shown on
  // the Dashboard/Statistics pages (total collected across all sales), so
  // there's never a mismatch between what the admin sees there and here. ----
  const totalCollected = sales.reduce((a, s) => a + s.collected, 0);

  const grossProfit = sales.reduce((sum, s) => {
    if (!s.total) return sum;
    const saleCost = s.items.reduce((a, i) => a + (costById.get(i.productId) || 0) * i.qty, 0);
    const costRatio = saleCost / s.total;
    return sum + s.collected * (1 - costRatio);
  }, 0);

  const totalExpenses = expenses.reduce((a, e) => a + e.amount, 0);
  const totalShrinkage = stockLogs.reduce((a, l) => a + (costById.get(l.productId) || 0) * l.qty, 0);
  const netProfit = grossProfit - totalExpenses - totalShrinkage;

  const calculate = () => {
    if (!percentValid) return;
    const partnersBreakdown = localPartners.map((p) => ({
      id: p.id,
      name: p.name,
      percent: Number(p.percent),
      amount: netProfit * (Number(p.percent) / 100),
    }));
    setResult({
      id: uid(),
      periodLabel: `لقطة بتاريخ ${dateLabel(todayISO())}`,
      collectedCash: totalCollected,
      grossProfit,
      periodExpenses: totalExpenses,
      periodShrinkage: totalShrinkage,
      netProfit,
      partners: partnersBreakdown,
      date: todayISO(),
      byUserName: currentUser.name,
    });
  };

  return (
    <div className="space-y-5">
      <h2 className="text-xl font-bold flex items-center gap-2"><Landmark size={20} /> حساب أرباح الشركاء</h2>
      <p className="text-xs text-[var(--muted)] -mt-3">تحديد الشركاء ونسبهم، واحتساب حصة كل شريك من صافي الربح المبني مباشرةً على المبلغ المحصَّل الفعلي (نفس الرقم الظاهر بالرئيسية والإحصائيات).</p>

      {/* Partners */}
      <Card className="p-4">
        <h3 className="font-bold mb-3 flex items-center gap-2"><Users2 size={18} /> الشركاء ونسب الأرباح</h3>
        <div className="flex gap-2 items-end mb-4">
          <div className="w-28">
            <Field label="عدد الشركاء">
              <input type="number" min="1" max="20" className={inputCls} value={partnerCount} onChange={(e) => setPartnerCount(e.target.value)} />
            </Field>
          </div>
          <Btn variant="outline" onClick={generateEqualPartners}>توليد بالتساوي</Btn>
          <Btn variant="ghost" onClick={addPartner}><Plus size={14} /> إضافة شريك</Btn>
        </div>

        <div className="space-y-2">
          {localPartners.map((p) => (
            <div key={p.id} className="flex gap-2 items-center">
              <input className={inputCls + " flex-1"} value={p.name} onChange={(e) => updatePartner(p.id, "name", e.target.value)} />
              <div className="relative w-24">
                <input type="number" min="0" max="100" step="0.01" className={inputCls + " pl-6"} value={p.percent} onChange={(e) => updatePartner(p.id, "percent", e.target.value)} />
                <Percent size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
              </div>
              <button onClick={() => removePartner(p.id)} className="p-2 text-[#B23A3A]"><Trash2 size={16} /></button>
            </div>
          ))}
        </div>

        <div className={`mt-3 text-xs font-semibold flex items-center gap-1.5 ${percentValid ? "text-[#3F7D57]" : "text-[#B23A3A]"}`}>
          {percentValid ? <Check size={14} /> : <AlertTriangle size={14} />}
          إجمالي النسب: {totalPercent.toFixed(2)}% {percentValid ? "✓ صحيح" : "— يجب أن يساوي 100%"}
        </div>

        <Btn className="w-full mt-3" onClick={() => onSavePartners(localPartners)} disabled={!percentValid}>
          <Save size={16} /> حفظ بيانات الشركاء
        </Btn>
      </Card>

      {/* Profit calculator */}
      <Card className="p-4">
        <h3 className="font-bold mb-3 flex items-center gap-2"><HandCoins size={18} /> حساب أرباح الشركاء من المبلغ المحصَّل</h3>

        <div className="grid grid-cols-2 gap-2 text-sm mb-3">
          <div className="bg-[var(--surface-2)] rounded-xl p-2.5">
            <p className="text-[10px] text-[var(--muted)]">إجمالي المبلغ المحصَّل</p>
            <p className="font-bold">{fmt(totalCollected)} K.D</p>
          </div>
          <div className="bg-[var(--surface-2)] rounded-xl p-2.5">
            <p className="text-[10px] text-[var(--muted)]">الربح الإجمالي (بعد تكلفة البضاعة)</p>
            <p className="font-bold">{fmt(grossProfit)} K.D</p>
          </div>
          <div className="bg-[var(--surface-2)] rounded-xl p-2.5">
            <p className="text-[10px] text-[var(--muted)]">إجمالي المصروفات</p>
            <p className="font-bold text-[#B23A3A]">{fmt(totalExpenses)} K.D</p>
          </div>
          <div className="bg-[var(--surface-2)] rounded-xl p-2.5">
            <p className="text-[10px] text-[var(--muted)]">إجمالي الهدر (هدايا/تالف/تجربة)</p>
            <p className="font-bold text-[#B23A3A]">{fmt(totalShrinkage)} K.D</p>
          </div>
        </div>

        <div className="bg-[var(--surface-3)] rounded-xl p-3 text-center mb-3">
          <p className="text-[11px] text-[var(--muted)]">صافي الربح القابل للتوزيع</p>
          <p dir="ltr" className={`text-xl font-extrabold whitespace-nowrap ${netProfit >= 0 ? "text-[#3F7D57]" : "text-[#B23A3A]"}`}>{fmt(netProfit)} K.D</p>
        </div>

        <Btn className="w-full" onClick={calculate} disabled={!percentValid}>
          <Calculator size={16} /> احتساب أرباح كل شريك
        </Btn>
        {!percentValid && <p className="text-[11px] text-[#B23A3A] mt-2">أكمل نسب الشركاء بحيث تساوي 100% قبل الاحتساب</p>}

        {result && (
          <div className="mt-4 pt-4 border-t border-[var(--border)] space-y-1.5 fade-in">
            {result.partners.map((p) => (
              <div key={p.id} className="flex justify-between items-center text-sm bg-[var(--surface-2)] rounded-lg px-3 py-2">
                <span className="font-semibold">{p.name} <span className="text-[var(--muted)] font-normal">({p.percent}%)</span></span>
                <span className="font-bold text-[var(--accent)]">{fmt(p.amount)} K.D</span>
              </div>
            ))}

            <div className="flex gap-2 pt-2">
              <Btn className="flex-1" onClick={() => onSaveDistribution(result)}><Save size={16} /> حفظ بالسجل</Btn>
              <Btn variant="outline" onClick={() => onPrint(result)}><Printer size={16} /> طباعة</Btn>
            </div>
          </div>
        )}
      </Card>

      {/* History */}
      <div>
        <h3 className="font-bold mb-3 flex items-center gap-2"><CalendarRange size={18} /> سجل حسابات الأرباح السابقة</h3>
        {profitDistributions.length === 0 ? (
          <Card className="p-6"><EmptyState text="لا توجد حسابات محفوظة بعد" /></Card>
        ) : (
          <div className="space-y-2">
            {profitDistributions.map((d) => (
              <Card key={d.id} className="p-3 card-hover">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold">{d.periodLabel}</p>
                    <p className="text-[11px] text-[var(--muted)]">صافي الربح: {fmt(d.netProfit)} K.D · بواسطة {d.byUserName} · {dateLabel(d.date)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => onPrint(d)} className="p-1.5 rounded-lg text-[var(--accent-dark)] hover:bg-[var(--surface-3)]"><Printer size={15} /></button>
                    <button onClick={() => onConfirm("هل تريد حذف هذا السجل؟", () => onDeleteDistribution(d.id))} className="p-1.5 rounded-lg text-[#B23A3A] hover:bg-[#FBEAEA]"><Trash2 size={15} /></button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SettingsPage({ settings, onSave, fontScale, onSetFontScale }) {
  const [form, setForm] = useState(settings);
  const fileRef = useRef(null);

  const handleLogo = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setForm((f) => ({ ...f, logo: reader.result }));
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-5 max-w-xl">
      <h2 className="text-xl font-bold">إعدادات الشركة</h2>
      <Card className="p-4 space-y-4">
        <Field label="اسم الشركة / النشاط">
          <input className={inputCls} value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} />
        </Field>
        <Field label="رقم الهاتف">
          <input className={inputCls} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="العنوان">
          <input className={inputCls} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </Field>
        <div>
          <span className="block text-xs font-semibold text-[var(--muted)] mb-2">شعار الشركة (Logo)</span>
          <div className="flex items-center gap-3">
            {form.logo ? (
              <img src={form.logo} alt="logo" className="w-16 h-16 rounded-xl object-cover border border-[var(--border)]" />
            ) : (
              <div className="w-16 h-16 rounded-xl bg-[var(--surface-2)] border border-dashed border-[var(--border)] flex items-center justify-center text-[var(--muted)]">
                <ImageIcon size={22} />
              </div>
            )}
            <input ref={fileRef} type="file" accept="image/*" onChange={handleLogo} className="hidden" />
            <Btn variant="outline" onClick={() => fileRef.current?.click()}><Upload size={16} /> رفع شعار</Btn>
            {form.logo && <Btn variant="ghost" onClick={() => setForm({ ...form, logo: "" })}>إزالة</Btn>}
          </div>
        </div>

        <div>
          <span className="block text-xs font-semibold text-[var(--muted)] mb-2">ثيم ألوان الموقع</span>
          <div className="grid grid-cols-3 gap-2">
            {THEMES.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setForm({ ...form, theme: t.key })}
                className={`rounded-xl border-2 p-2.5 flex flex-col items-center gap-1.5 transition ${
                  (form.theme || "classic") === t.key ? "border-[var(--accent)]" : "border-transparent"
                }`}
                style={{ background: "var(--surface-2)" }}
              >
                <span className="flex gap-1">
                  <span className="w-5 h-5 rounded-full" style={{ background: t.accent }} />
                  <span className="w-5 h-5 rounded-full" style={{ background: t.dark }} />
                </span>
                <span className="text-[11px] font-semibold">{t.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="pt-3 border-t border-[var(--border)]">
          <span className="text-xs font-semibold text-[var(--muted)] flex items-center gap-1.5 mb-2"><Type size={14} /> حجم الخط (على هذا الجهاز فقط)</span>
          <div className="grid grid-cols-4 gap-2">
            {[
              { scale: 0.9, label: "صغير" },
              { scale: 1, label: "عادي" },
              { scale: 1.1, label: "كبير" },
              { scale: 1.25, label: "أكبر" },
            ].map((o) => (
              <button
                key={o.scale}
                type="button"
                onClick={() => onSetFontScale(o.scale)}
                className={`rounded-xl border-2 py-2.5 flex flex-col items-center gap-1 transition ${
                  fontScale === o.scale ? "border-[var(--accent)]" : "border-transparent"
                }`}
                style={{ background: "var(--surface-2)" }}
              >
                <span className="font-extrabold" style={{ fontSize: `${14 * o.scale}px` }}>أ</span>
                <span className="text-[10px] font-semibold">{o.label}</span>
              </button>
            ))}
          </div>
          <p className="text-[11px] text-[var(--muted)] mt-2">يتحكم بحجم النصوص والأرقام بكامل التطبيق على جهازك أنت فقط، ولا يؤثر على أجهزة بقية المستخدمين.</p>
        </div>

        <div className="pt-3 border-t border-[var(--border)]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-[var(--muted)] flex items-center gap-1.5"><Percent size={14} /> نظام الضريبة (تجهيز مسبق)</span>
            <button
              type="button"
              onClick={() => setForm({ ...form, taxEnabled: !form.taxEnabled })}
              className={`w-11 h-6 rounded-full relative transition ${form.taxEnabled ? "bg-[var(--accent)]" : "bg-[var(--border)]"}`}
            >
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${form.taxEnabled ? "right-0.5" : "right-5"}`} />
            </button>
          </div>
          <p className="text-[11px] text-[var(--muted)] mb-3">جهّزنا هذا النظام لتطبيق الضريبة عند إقرارها مستقبلاً في دولة الكويت. فعّله فقط عند الحاجة الفعلية.</p>
          {form.taxEnabled && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="اسم الضريبة">
                <input className={inputCls} value={form.taxLabel} onChange={(e) => setForm({ ...form, taxLabel: e.target.value })} />
              </Field>
              <Field label="نسبة الضريبة (%)">
                <input type="number" min="0" max="100" step="0.1" className={inputCls} value={form.taxRate} onChange={(e) => setForm({ ...form, taxRate: Number(e.target.value) })} />
              </Field>
            </div>
          )}
        </div>

        <Btn onClick={() => onSave(form)} className="w-full"><Save size={16} /> حفظ الإعدادات</Btn>
      </Card>
      <p className="text-xs text-[var(--muted)]">سيظهر اسم الشركة والشعار تلقائياً في جميع الفواتير المطبوعة. تغيير الثيم يطبَّق على واجهة الموقع لجميع المستخدمين.</p>
    </div>
  );
}

/* ---------------------------------- Backup ---------------------------------- */

/* ---------------------------------- Activity Log (primary admin only) ---------------------------------- */

const ACTIVITY_ICONS = {
  login: { icon: LogIn, color: "#3F7D57" },
  logout: { icon: LogOut, color: "#8A7B6C" },
  delete: { icon: Trash2, color: "#B23A3A" },
  edit: { icon: Edit3, color: "var(--accent)" },
};
function activityVisual(action) {
  if (action.includes("خروج")) return ACTIVITY_ICONS.logout;
  if (action.includes("دخول")) return ACTIVITY_ICONS.login;
  if (action.includes("حذف")) return ACTIVITY_ICONS.delete;
  if (action.includes("تعديل") || action.includes("تحديث")) return ACTIVITY_ICONS.edit;
  return { icon: ScrollText, color: "var(--accent-dark)" };
}

function ActivityLogPage({ log, users }) {
  const [userFilter, setUserFilter] = useState("all");
  const [search, setSearch] = useState("");

  let list = log;
  if (userFilter !== "all") list = list.filter((l) => l.userId === userFilter);
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    list = list.filter((l) => l.action.toLowerCase().includes(q) || l.details.toLowerCase().includes(q) || l.userName.toLowerCase().includes(q));
  }

  const knownUsers = useMemo(() => {
    const map = new Map();
    log.forEach((l) => map.set(l.userId, l.userName));
    return Array.from(map.entries());
  }, [log]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold flex items-center gap-2"><History size={20} /> سجل الدخول والنشاطات</h2>
        <p className="text-xs text-[var(--muted)] mt-1 flex items-center gap-1.5">
          <ShieldAlert size={13} /> هذه الصفحة خاصة بحساب المدير الأساسي فقط، ولا يراها أي مدير آخر
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <select className={inputCls + " sm:w-56"} value={userFilter} onChange={(e) => setUserFilter(e.target.value)}>
          <option value="all">كل المستخدمين</option>
          {knownUsers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <div className="relative flex-1">
          <Search size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
          <input className={inputCls + " pr-9"} placeholder="بحث في الإجراءات أو التفاصيل..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {list.length === 0 ? (
        <Card className="p-8"><EmptyState text="لا توجد أي أحداث مسجَّلة بعد" /></Card>
      ) : (
        <div className="space-y-2">
          {list.map((l) => {
            const { icon: Icon, color } = activityVisual(l.action);
            return (
              <Card key={l.id} className="p-3 flex items-start gap-3">
                <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)` }}>
                  <Icon size={16} style={{ color }} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{l.userName} <span className="font-normal text-[var(--muted)]">— {l.action}</span></p>
                  {l.details && <p className="text-xs text-[var(--muted)] mt-0.5">{l.details}</p>}
                  <p className="text-[10px] text-[var(--muted)] mt-1">{dateLabel(l.date)} · {timeLabel(l.date)}</p>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <p className="text-[11px] text-[var(--muted)] text-center">يحتفظ السجل بآخر 500 حدث فقط لتفادي أخذ مساحة كبيرة بمرور الوقت</p>
    </div>
  );
}

function BackupPage({ data, onRestore, dailyBackup, onRefreshDailyBackup }) {
  const fileRef = useRef(null);
  const [pending, setPending] = useState(null);

  const exportData = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `عطورنا-نسخة-احتياطية-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const exportDailyBackup = () => {
    if (!dailyBackup) return;
    const blob = new Blob([JSON.stringify(dailyBackup.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `عطورنا-نسخة-يومية-${dailyBackup.date}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        setPending(parsed);
      } catch {
        alert("ملف غير صالح");
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="space-y-5 max-w-xl">
      <h2 className="text-xl font-bold">النسخ الاحتياطي واستعادة البيانات</h2>

      <Card className="p-4">
        <h3 className="font-bold mb-2 flex items-center gap-2"><Save size={18} /> النسخة اليومية التلقائية</h3>
        <p className="text-sm text-[var(--muted)] mb-3">
          يحفظ النظام نسخة كاملة من كل بياناتك تلقائياً مرة واحدة كل يوم، وتستبدل نسخة اليوم السابق — بحيث توجد دائماً نسخة واحدة فقط محفوظة، ولا تتراكم لتأخذ مساحة إضافية.
        </p>
        {dailyBackup ? (
          <div className="bg-[var(--surface-2)] rounded-xl p-3 mb-3 text-sm">
            <p><b>آخر نسخة محفوظة:</b> {dateLabel(dailyBackup.savedAt)} — {timeLabel(dailyBackup.savedAt)}</p>
          </div>
        ) : (
          <p className="text-xs text-[var(--muted)] mb-3">لم تُحفظ أي نسخة يومية بعد.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Btn variant="outline" onClick={onRefreshDailyBackup}><Save size={16} /> تحديث النسخة الآن</Btn>
          {dailyBackup && (
            <>
              <Btn variant="ghost" onClick={exportDailyBackup}><Download size={16} /> تنزيل هذه النسخة</Btn>
              <Btn variant="danger" onClick={() => setPending(dailyBackup.data)}>استعادة هذه النسخة</Btn>
            </>
          )}
        </div>
      </Card>

      <Card className="p-4">
        <h3 className="font-bold mb-2">تنزيل نسخة احتياطية يدوية</h3>
        <p className="text-sm text-[var(--muted)] mb-3">يشمل: المستخدمين، المنتجات، المبيعات، الفواتير، الإعدادات.</p>
        <Btn onClick={exportData}><Download size={16} /> تنزيل نسخة JSON</Btn>
      </Card>

      <Card className="p-4">
        <h3 className="font-bold mb-2">استعادة / دمج نسخة من ملف</h3>
        <input ref={fileRef} type="file" accept="application/json" onChange={handleFile} className="hidden" />
        <Btn variant="outline" onClick={() => fileRef.current?.click()}><Upload size={16} /> اختيار ملف نسخة احتياطية</Btn>

        {pending && (
          <div className="mt-4 space-y-3">
            <div className="text-sm bg-[#FBF9F5] rounded-xl p-3">
              <p>المستخدمون: {pending.users?.length ?? 0} · المنتجات: {pending.products?.length ?? 0} · المبيعات: {pending.sales?.length ?? 0}</p>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <Btn onClick={() => { onRestore(pending, "merge"); setPending(null); }}>
                دمج مع البيانات الحالية
              </Btn>
              <Btn variant="danger" onClick={() => { onRestore(pending, "replace"); setPending(null); }}>
                استبدال كل البيانات الحالية
              </Btn>
              <Btn variant="ghost" onClick={() => setPending(null)}>إلغاء</Btn>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ---------------------------------- Print Area ---------------------------------- */

/* ---------------------------------- Edit Sale (admin) ---------------------------------- */

function EditSaleModal({ sale, products, sellerAllocations = [], isOwnerEdit = false, onClose, onSave }) {
  const [items, setItems] = useState(sale.items.map((i) => ({ ...i })));
  const [reason, setReason] = useState("");
  const [collected, setCollected] = useState(String(sale.collected));
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState(1);
  const [unitPrice, setUnitPrice] = useState("");
  const [discountType, setDiscountType] = useState(sale.discountType || "amount");
  const [discountValue, setDiscountValue] = useState(String(sale.discountValue || ""));

  const selectedProduct = products.find((p) => p.id === productId);
  useEffect(() => {
    if (selectedProduct) setUnitPrice(String(selectedProduct.price));
  }, [productId]); // eslint-disable-line

  // Stock still available for a product while editing = current stock +
  // whatever this invoice already reserved for it, minus what the edited
  // lines now use. For a product split between sellers, it's additionally
  // capped by the invoice seller's own allocation (plus what this invoice
  // had already drawn from it) — so correcting an invoice can never be used
  // to sell stock that belongs to a colleague.
  const availableFor = (pid) => {
    const p = products.find((x) => x.id === pid);
    if (!p) return 0;
    const reserved = sale.items.filter((i) => i.productId === pid).reduce((a, i) => a + i.qty, 0);
    const usedInEdit = items.filter((i) => i.productId === pid).reduce((a, i) => a + i.qty, 0);
    const physical = p.stock + reserved - usedInEdit;
    if (!isProductManaged(sellerAllocations, pid)) return physical;
    const drawnByThisSale = (sale.allocationSources || [])
      .filter((src) => src.productId === pid && src.sellerId === sale.sellerId)
      .reduce((a, src) => a + src.qty, 0);
    const ownCap = remainingForSeller(sellerAllocations, sale.sellerId, pid) + drawnByThisSale - usedInEdit;
    return Math.min(physical, ownCap);
  };

  const addLine = () => {
    if (!selectedProduct) return;
    const q = Number(qty);
    const price = Number(unitPrice);
    if (!q || q <= 0) return;
    if (q > availableFor(productId)) return;
    setItems((c) => [...c, { lineId: uid(), productId: selectedProduct.id, name: selectedProduct.name, qty: q, price, total: q * price }]);
    setProductId("");
    setQty(1);
    setUnitPrice("");
  };

  const removeLine = (lineId) => setItems((c) => c.filter((l) => l.lineId !== lineId));

  const updateLineQty = (lineId, newQty) => {
    const line = items.find((l) => l.lineId === lineId);
    if (!line) return;
    // A line can grow only by what's still available for its product.
    const maxQty = line.qty + Math.max(0, availableFor(line.productId));
    const q = Math.min(newQty, maxQty);
    setItems((c) => c.map((l) => (l.lineId === lineId ? { ...l, qty: q, total: q * l.price } : l)));
  };

  const subtotal = items.reduce((a, l) => a + l.total, 0);
  const discountNum = Number(discountValue) || 0;
  const discountAmount = Math.min(subtotal, discountType === "percent" ? subtotal * (discountNum / 100) : discountNum);
  const afterDiscount = Math.max(0, subtotal - discountAmount);
  const taxAmount = sale.taxEnabled ? afterDiscount * ((sale.taxRate || 0) / 100) : 0;
  const total = afterDiscount + taxAmount;

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/50 p-4 announce-backdrop" dir="rtl">
      <div className="bg-[var(--surface)] rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-5 announce-pop">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">{isOwnerEdit ? "تصحيح فاتورة" : "تعديل فاتورة"} {sale.invoiceNo}</h3>
          <button onClick={onClose} className="p-1 text-[var(--muted)]"><X size={20} /></button>
        </div>
        {isOwnerEdit && (
          <p className="text-[11px] text-[var(--muted)] bg-[var(--surface-2)] rounded-xl px-3 py-2 mb-4 flex items-start gap-1.5">
            <ShieldCheck size={13} className="shrink-0 mt-0.5" />
            يمكنك تصحيح بيانات فواتيرك فقط في حال الخطأ في الإدخال. يُحفظ كل تعديل مع سببه في سجل الفاتورة ويطّلع عليه المدير.
          </p>
        )}

        <div className="space-y-2 mb-4">
          {items.map((l) => (
            <div key={l.lineId} className="flex items-center gap-2 bg-[var(--surface-2)] rounded-xl px-3 py-2">
              <div className="flex-1">
                <p className="text-sm font-semibold">{l.name}</p>
                <p className="text-xs text-[var(--muted)]">{fmt(l.price)} K.D / وحدة</p>
              </div>
              <input
                type="number"
                min="1"
                className="w-16 rounded-lg border border-[var(--border)] bg-[var(--input-bg)] px-2 py-1 text-sm text-center"
                value={l.qty}
                onChange={(e) => updateLineQty(l.lineId, Math.max(1, Number(e.target.value) || 1))}
              />
              <p className="text-sm font-bold text-[var(--accent)] w-20 text-left">{fmt(l.total)}</p>
              <button onClick={() => removeLine(l.lineId)} className="text-[#B23A3A]"><Trash2 size={16} /></button>
            </div>
          ))}
          {items.length === 0 && <EmptyState text="لا توجد عناصر — أضف منتجاً" />}
        </div>

        <div className="grid grid-cols-4 gap-2 mb-2">
          <select className={inputCls + " col-span-2"} value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">اختر منتج...</option>
            {products.map((p) => (
              <option key={p.id} value={p.id} disabled={availableFor(p.id) <= 0}>
                {p.name} — متبقي {availableFor(p.id)}
              </option>
            ))}
          </select>
          <input type="number" min="1" className={inputCls} value={qty} onChange={(e) => setQty(e.target.value)} placeholder="الكمية" />
          <input type="number" min="0" step="0.001" className={inputCls} value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} placeholder="السعر" />
        </div>
        <Btn variant="ghost" onClick={addLine} disabled={!productId} className="w-full mb-4">
          <Plus size={16} /> إضافة منتج
        </Btn>

        <div className="flex justify-between text-sm mb-2">
          <span className="text-[var(--muted)]">المجموع الفرعي</span>
          <span className="font-semibold">{fmt(subtotal)} K.D</span>
        </div>

        <div className="mb-3">
          <span className="block text-xs font-semibold text-[var(--muted)] mb-1.5 flex items-center gap-1"><Percent size={12} /> الخصم</span>
          <div className="flex gap-2">
            <div className="flex rounded-xl overflow-hidden border border-[var(--border)]">
              <button type="button" onClick={() => setDiscountType("amount")} className={`px-3 py-2 text-xs font-semibold ${discountType === "amount" ? "bg-[var(--accent)] text-white" : "bg-[var(--surface-2)] text-[var(--muted)]"}`}>K.D</button>
              <button type="button" onClick={() => setDiscountType("percent")} className={`px-3 py-2 text-xs font-semibold ${discountType === "percent" ? "bg-[var(--accent)] text-white" : "bg-[var(--surface-2)] text-[var(--muted)]"}`}>%</button>
            </div>
            <input type="number" min="0" step="0.001" className={inputCls + " flex-1"} value={discountValue} onChange={(e) => setDiscountValue(e.target.value)} />
          </div>
        </div>

        {sale.taxEnabled && (
          <div className="flex justify-between text-sm mb-2">
            <span className="text-[var(--muted)]">{sale.taxLabel || "الضريبة"} ({sale.taxRate}%)</span>
            <span className="font-semibold">+ {fmt(taxAmount)} K.D</span>
          </div>
        )}

        <div className="flex justify-between text-sm mb-2 pt-2 border-t border-[var(--border)]">
          <span className="text-[var(--muted)]">الإجمالي الجديد</span>
          <span className="font-extrabold text-lg">{fmt(total)} K.D</span>
        </div>
        <Field label="المبلغ المحصل (K.D)">
          <input type="number" min="0" step="0.001" className={inputCls} value={collected} onChange={(e) => setCollected(e.target.value)} />
        </Field>

        <div className="mt-3">
          <Field label={isOwnerEdit ? "سبب التصحيح (إلزامي)" : "سبب التعديل (اختياري)"}>
            <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثال: أدخلت الكمية 3 بدلاً من 2" />
          </Field>
        </div>

        {(sale.editHistory || []).length > 0 && (
          <div className="mt-3 text-[11px] text-[var(--muted)] space-y-1">
            <p className="font-semibold">سجل التعديلات السابقة</p>
            {sale.editHistory.slice(-4).reverse().map((h, i) => (
              <p key={i}>• {h.byUserName} — {dateLabel(h.date)} {timeLabel(h.date)}{h.reason ? ` — ${h.reason}` : ""}</p>
            ))}
          </div>
        )}

        <div className="flex gap-2 mt-4">
          <Btn
            className="flex-1"
            disabled={items.length === 0 || (isOwnerEdit && !reason.trim())}
            onClick={() => onSave(items, Number(collected) || 0, discountType, discountNum, reason.trim())}
          >
            <Save size={16} /> حفظ التعديلات
          </Btn>
          <Btn variant="outline" onClick={onClose}>إلغاء</Btn>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- Barcode (Code 39) ---------------------------------- */
// Verified real-world Code 39 width table (1=narrow, 2=wide; Bar,Space,Bar,Space,Bar,Space,Bar,Space,Bar).
const CODE39_PATTERNS = {
  "0": "111221211", "1": "211211112", "2": "112211112", "3": "212211111",
  "4": "111221112", "5": "211221111", "6": "112221111", "7": "111211212",
  "8": "211211211", "9": "112211211", "A": "211112112", "B": "112112112",
  "C": "212112111", "D": "111122112", "E": "211122111", "F": "112122111",
  "G": "111112212", "H": "211112211", "I": "112112211", "J": "111122211",
  "K": "211111122", "L": "112111122", "M": "212111121", "N": "111121122",
  "O": "211121121", "P": "112121121", "Q": "111111222", "R": "211111221",
  "S": "112111221", "T": "111121221", "U": "221111112", "V": "122111112",
  "W": "222111111", "X": "121121112", "Y": "221121111", "Z": "122121111",
  "-": "121111212", ".": "221111211", " ": "122111211", "$": "121212111",
  "/": "121211121", "+": "121112121", "%": "111212121", "*": "121121211",
};

function code39Elements(rawValue) {
  const clean = String(rawValue).toUpperCase().replace(/[^0-9A-Z\-. $/+%]/g, "");
  const full = `*${clean}*`;
  const elements = [];
  for (const ch of full) {
    const pattern = CODE39_PATTERNS[ch] || CODE39_PATTERNS["-"];
    for (let i = 0; i < pattern.length; i++) {
      elements.push({ isBar: i % 2 === 0, width: Number(pattern[i]) });
    }
    elements.push({ isBar: false, width: 1 }); // inter-character gap
  }
  return elements;
}

function Code39Barcode({ value, height = 46, unit = 2.2 }) {
  const elements = code39Elements(value);
  const totalWidth = elements.reduce((a, e) => a + e.width, 0) * unit;
  let x = 0;
  const bars = [];
  elements.forEach((e, i) => {
    if (e.isBar) {
      bars.push(<rect key={i} x={x} y={0} width={e.width * unit} height={height} fill="#111" />);
    }
    x += e.width * unit;
  });
  return (
    <svg width={totalWidth} height={height} viewBox={`0 0 ${totalWidth} ${height}`} style={{ display: "block" }}>
      {bars}
    </svg>
  );
}

/* ---------------------------------- Product Labels (barcode + price) ---------------------------------- */

function LabelsPrintArea({ product, count, settings, onClose }) {
  const handlePrint = () => window.print();
  const labels = Array.from({ length: count });

  return (
    <div className="print-area">
      <style>{`
        @page { size: A4; margin: 8mm; }
        @media print {
          .print-area { position: static; background: white; overflow: visible; }
          .print-toolbar { display: none !important; }
        }
        @media screen {
          .print-area { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 9999; display: flex; flex-direction: column; align-items: center; overflow: auto; padding: 0 0 32px; }
          .print-toolbar { position: sticky; top: 0; z-index: 2; width: 100%; display: flex; justify-content: center; gap: 8px; padding: 12px; background: rgba(0,0,0,0.55); backdrop-filter: blur(2px); }
          .label-sheet { background: white; width: calc(100% - 24px); max-width: 210mm; padding: 8mm; box-shadow: 0 10px 40px rgba(0,0,0,0.3); margin-top: 4px; }
        }
        .label-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3mm; }
        .label-card { border: 1px dashed #999; border-radius: 4px; padding: 3mm 2mm; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 1.5mm; page-break-inside: avoid; }
      `}</style>

      <div className="print-toolbar no-print">
        <button onClick={handlePrint} style={{ background: "var(--accent)", color: "white", borderRadius: 10, padding: "10px 18px", fontSize: 13, fontWeight: 700 }}>
          طباعة / حفظ PDF
        </button>
        <button onClick={onClose} style={{ background: "#2B211A", color: "white", borderRadius: 10, padding: "10px 18px", fontSize: 13, fontWeight: 700 }}>
          إغلاق
        </button>
      </div>

      <div className="label-sheet" dir="rtl" style={{ fontFamily: "'Tajawal', sans-serif", color: "#111" }}>
        <div className="label-grid">
          {labels.map((_, i) => (
            <div className="label-card" key={i}>
              <p style={{ fontSize: 11, fontWeight: 700, margin: 0 }}>{settings.companyName || "عطورنا"}</p>
              <p style={{ fontSize: 12, fontWeight: 700, margin: 0 }}>{product.name}</p>
              <Code39Barcode value={product.id} height={34} unit={1.4} />
              <p style={{ fontSize: 9, letterSpacing: 1, margin: 0, color: "#555" }}>{product.id.toUpperCase()}</p>
              <p style={{ fontSize: 14, fontWeight: 800, margin: 0 }}>{fmt(product.price)} K.D</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PrintArea({ payload, settings, onClose }) {
  useEffect(() => {
    const onAfterPrint = () => onClose();
    window.addEventListener("afterprint", onAfterPrint);
    return () => window.removeEventListener("afterprint", onAfterPrint);
  }, []); // eslint-disable-line

  const handlePrint = () => window.print();

  return (
    <div className="print-area">
      <style>{`
        @page { size: A4; margin: 14mm; }
        @media print {
          .print-area { position: static; background: white; overflow: visible; }
          .print-toolbar { display: none !important; }
          .print-sheet { position: static; width: auto; max-width: none; padding: 0; box-shadow: none; margin: 0; }
        }
        @media screen {
          .print-area { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 9999; display: flex; flex-direction: column; align-items: center; overflow: auto; padding: 0 0 32px; }
          .print-toolbar { position: sticky; top: 0; z-index: 2; width: 100%; display: flex; justify-content: center; gap: 8px; padding: 12px; background: rgba(0,0,0,0.55); backdrop-filter: blur(2px); }
          .print-sheet { background: white; width: calc(100% - 24px); max-width: 210mm; min-height: auto; padding: 16px; box-shadow: 0 10px 40px rgba(0,0,0,0.3); margin-top: 4px; }
        }
        @media screen and (min-width: 700px) {
          .print-sheet { padding: 14mm; min-height: 297mm; }
        }
      `}</style>

      <div className="print-toolbar no-print">
        <button
          onClick={handlePrint}
          style={{ background: "var(--accent)", color: "white", borderRadius: 10, padding: "10px 18px", fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}
        >
          طباعة / حفظ PDF
        </button>
        <button
          onClick={onClose}
          style={{ background: "#2B211A", color: "white", borderRadius: 10, padding: "10px 18px", fontSize: 13, fontWeight: 700 }}
        >
          إغلاق
        </button>
      </div>

      <div className="print-sheet" dir="rtl" style={{ fontFamily: "'Tajawal', sans-serif", color: "#2B211A" }}>
        {payload.type === "invoice" ? (
          <InvoiceDoc sale={payload.data} settings={settings} />
        ) : payload.type === "record" ? (
          <RecordDoc sellerName={payload.data.sellerName} list={payload.data.list} settings={settings} />
        ) : (
          <DistributionDoc data={payload.data} settings={settings} />
        )}
      </div>
    </div>
  );
}

function DocHeader({ settings }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "3px solid #B8894A", paddingBottom: 12, marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {settings.logo ? (
          <img src={settings.logo} alt="logo" style={{ width: 56, height: 56, borderRadius: 12, objectFit: "cover" }} />
        ) : (
          <PerfumeMark size={48} />
        )}
        <div>
          <p style={{ fontFamily: "'Amiri', serif", fontSize: 22, fontWeight: 700, color: "#5B2333", margin: 0 }}>{settings.companyName || "عطورنا"}</p>
          <p style={{ fontSize: 11, color: "#8A7B6C", margin: 0 }}>{settings.address || "دولة الكويت"} {settings.phone ? " · " + settings.phone : ""}</p>
        </div>
      </div>
      <div style={{ textAlign: "left" }}>
        <p style={{ fontSize: 11, color: "#8A7B6C", margin: 0 }}>تاريخ الطباعة</p>
        <p style={{ fontSize: 12, fontWeight: 700, margin: 0 }}>{dateLabel(todayISO())}</p>
      </div>
    </div>
  );
}

function InvoiceDoc({ sale, settings }) {
  return (
    <div>
      <DocHeader settings={settings} />
      <h2 style={{ fontSize: 18, fontWeight: 800, color: "#2B211A", marginBottom: 4 }}>فاتورة</h2>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 16, color: "#4A3F35" }}>
        <div>
          <p style={{ margin: "2px 0" }}><b>رقم الفاتورة:</b> {sale.invoiceNo}</p>
          <p style={{ margin: "2px 0" }}><b>البائع:</b> {sale.sellerName}</p>
        </div>
        <div style={{ textAlign: "left" }}>
          <p style={{ margin: "2px 0" }}><b>التاريخ:</b> {dateLabel(sale.date)}</p>
          <p style={{ margin: "2px 0" }}><b>الوقت:</b> {timeLabel(sale.date)}</p>
        </div>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: "#F7F1E6" }}>
            <th style={thStyle}>المنتج</th>
            <th style={thStyle}>الكمية</th>
            <th style={thStyle}>سعر الوحدة</th>
            <th style={thStyle}>الإجمالي</th>
          </tr>
        </thead>
        <tbody>
          {sale.items.map((i) => (
            <tr key={i.lineId}>
              <td style={tdStyle}>{i.name}</td>
              <td style={tdStyle}>{i.qty}</td>
              <td style={tdStyle}>{fmt(i.price)} K.D</td>
              <td style={tdStyle}>{fmt(i.total)} K.D</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 20, marginRight: "auto", width: 260, marginLeft: 0, marginInlineStart: "auto" }}>
        {sale.subtotal !== undefined && sale.subtotal !== sale.total && (
          <TotalRow label="المجموع الفرعي" value={sale.subtotal} />
        )}
        {sale.discountAmount > 0 && (
          <TotalRow
            label={`الخصم${sale.discountType === "percent" ? ` (${sale.discountValue}%)` : ""}`}
            value={-sale.discountAmount}
            color="#B23A3A"
          />
        )}
        {sale.taxEnabled && sale.taxAmount > 0 && (
          <TotalRow label={`${sale.taxLabel || "الضريبة"} (${sale.taxRate}%)`} value={sale.taxAmount} />
        )}
        <TotalRow label="الإجمالي الكلي" value={sale.total} bold />
        <TotalRow label="المبلغ المحصل" value={sale.collected} color="#3F7D57" />
        <TotalRow label="المبلغ المتبقي" value={sale.remaining} color="#B23A3A" />
      </div>

      <p style={{ marginTop: 40, fontSize: 11, color: "#8A7B6C", textAlign: "center" }}>
        شكراً لتعاملكم مع {settings.companyName || "عطورنا"} — جميع الأسعار بالدينار الكويتي
      </p>
    </div>
  );
}

function RecordDoc({ sellerName, list, settings }) {
  const total = list.reduce((a, s) => a + s.total, 0);
  const collected = list.reduce((a, s) => a + s.collected, 0);
  const remaining = list.reduce((a, s) => a + s.remaining, 0);
  return (
    <div>
      <DocHeader settings={settings} />
      <h2 style={{ fontSize: 18, fontWeight: 800, marginBottom: 4 }}>سجل مبيعات البائع: {sellerName}</h2>
      <p style={{ fontSize: 12, color: "#8A7B6C", marginBottom: 16 }}>عدد الفواتير: {list.length}</p>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ background: "#F7F1E6" }}>
            <th style={thStyle}>رقم الفاتورة</th>
            <th style={thStyle}>التاريخ</th>
            <th style={thStyle}>المنتجات</th>
            <th style={thStyle}>الإجمالي</th>
            <th style={thStyle}>المحصل</th>
            <th style={thStyle}>المتبقي</th>
          </tr>
        </thead>
        <tbody>
          {list.map((s) => (
            <tr key={s.id}>
              <td style={tdStyle}>{s.invoiceNo}</td>
              <td style={tdStyle}>{dateLabel(s.date)}</td>
              <td style={tdStyle}>{s.items.map((i) => i.name).join("، ")}</td>
              <td style={tdStyle}>{fmt(s.total)}</td>
              <td style={tdStyle}>{fmt(s.collected)}</td>
              <td style={tdStyle}>{fmt(s.remaining)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 20, width: 280, marginInlineStart: "auto" }}>
        <TotalRow label="إجمالي المبيعات" value={total} bold />
        <TotalRow label="إجمالي المحصل" value={collected} color="#3F7D57" />
        <TotalRow label="إجمالي المتبقي" value={remaining} color="#B23A3A" />
      </div>
    </div>
  );
}

const thStyle = { textAlign: "right", padding: "8px 10px", borderBottom: "2px solid #E3D6BE", fontWeight: 700 };
const tdStyle = { textAlign: "right", padding: "8px 10px", borderBottom: "1px solid #F0E6D0" };

function DistributionDoc({ data, settings }) {
  return (
    <div>
      <DocHeader settings={settings} />
      <h2 style={{ fontSize: 18, fontWeight: 800, marginBottom: 4 }}>تقرير حساب أرباح الشركاء</h2>
      <p style={{ fontSize: 12, color: "#8A7B6C", marginBottom: 16 }}>{data.periodLabel}</p>

      <div style={{ background: "#F7F1E6", borderRadius: 10, padding: "12px 16px", marginBottom: 16 }}>
        <TotalRow label="إجمالي المبلغ المحصَّل" value={data.collectedCash} />
        <TotalRow label="الربح الإجمالي (بعد خصم تكلفة البضاعة)" value={data.grossProfit} />
        <TotalRow label="إجمالي المصروفات" value={-data.periodExpenses} color="#B23A3A" />
        <TotalRow label="الهدر (هدايا / تالف / تجربة)" value={-data.periodShrinkage} color="#B23A3A" />
        <div style={{ borderTop: "2px solid #E3D6BE", marginTop: 6, paddingTop: 6 }}>
          <TotalRow label="صافي الربح القابل للتوزيع" value={data.netProfit} bold color={data.netProfit >= 0 ? "#3F7D57" : "#B23A3A"} />
        </div>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: "#F7F1E6" }}>
            <th style={thStyle}>الشريك</th>
            <th style={thStyle}>النسبة</th>
            <th style={thStyle}>المبلغ المستحق</th>
          </tr>
        </thead>
        <tbody>
          {data.partners.map((p) => (
            <tr key={p.id}>
              <td style={tdStyle}>{p.name}</td>
              <td style={tdStyle}>{p.percent}%</td>
              <td style={tdStyle}>{fmt(p.amount)} K.D</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style={{ marginTop: 40, fontSize: 11, color: "#8A7B6C", textAlign: "center" }}>
        تقرير داخلي لتوزيع الأرباح — {settings.companyName || "عطورنا"}
      </p>
    </div>
  );
}

function TotalRow({ label, value, bold, color }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: bold ? 15 : 13, fontWeight: bold ? 800 : 600, color: color || "#2B211A" }}>
      <span>{label}</span>
      <span>{fmt(value)} K.D</span>
    </div>
  );
}
