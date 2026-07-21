import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Plus, Trash2, Printer, Download, Upload, LogOut, Package, Receipt,
  BarChart3, Settings as SettingsIcon, Users as UsersIcon, Search, X, Check,
  Menu, Save, Image as ImageIcon, ShoppingCart, Home, AlertTriangle, Eye, EyeOff,
  Sun, Moon, Pencil, Wallet
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
  return v.toLocaleString("en-GB", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
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

const COLORS = ["#B8894A", "#5B2333", "#3F7D57", "#8A7B6C", "#C9A227", "#7A4B63"];

function exportSalesCsv(label, list) {
  const header = ["رقم الفاتورة", "البائع", "التاريخ", "المنتجات", "الإجمالي", "المحصل", "المتبقي"];
  const rows = list.map((s) => [
    s.invoiceNo,
    s.sellerName,
    dateLabel(s.date),
    s.items.map((i) => `${i.name} (${i.qty})`).join(" / "),
    s.total.toFixed(3),
    s.collected.toFixed(3),
    s.remaining.toFixed(3),
  ]);
  const csv = [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `سجل-مبيعات-${label}-${new Date().toISOString().slice(0, 10)}.csv`;
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
          <stop offset="100%" stopColor="#B8894A" />
        </linearGradient>
        <linearGradient id="bottleGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#7A4B63" />
          <stop offset="100%" stopColor="#5B2333" />
        </linearGradient>
      </defs>
      <rect x="24" y="6" width="16" height="10" rx="2" fill="url(#capGrad)" />
      <rect x="28" y="14" width="8" height="6" fill="#D8B978" />
      <path d="M18 24C18 20.7 20.7 18 24 18H40C43.3 18 46 20.7 46 24V50C46 54.4 42.4 58 38 58H26C21.6 58 18 54.4 18 50V24Z" fill="url(#bottleGrad)" />
      <path d="M22 30H42V50C42 52.2 40.2 54 38 54H26C23.8 54 22 52.2 22 50V30Z" fill="#8A5470" opacity="0.5" />
      <circle cx="32" cy="40" r="3.2" fill="#F4E7C9" opacity="0.9" />
    </svg>
  );
}

/* ---------------------------------- shared UI atoms ---------------------------------- */

function Btn({ children, variant = "primary", className = "", ...props }) {
  const base = "inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-semibold transition active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none";
  const variants = {
    primary: "bg-[#B8894A] text-white hover:bg-[#a67a3e] shadow-sm shadow-[#B8894A]/30",
    dark: "bg-[#5B2333] text-white hover:bg-[#4a1c29] shadow-sm",
    ghost: "bg-[var(--surface-3)] text-[#5B2333] hover:bg-[var(--border)]",
    outline: "border border-[var(--border)] text-[var(--text)] hover:bg-[var(--surface-2)]",
    danger: "bg-[#B23A3A] text-white hover:bg-[#9c3131]",
  };
  return (
    <button className={`${base} ${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
}

function Card({ children, className = "" }) {
  return (
    <div className={`bg-[var(--surface)] rounded-2xl border border-[var(--border)] shadow-[0_2px_12px_rgba(91,35,51,0.06)] ${className}`}>
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-[var(--muted)] mb-1">{label}</span>
      {children}
    </label>
  );
}

const inputCls = "w-full rounded-xl border border-[var(--border)] bg-[var(--input-bg)] px-3 py-2.5 text-sm text-[var(--text)] outline-none focus:ring-2 focus:ring-[#B8894A]/40 focus:border-[#B8894A]";

/* ---------------------------------- Login ---------------------------------- */

function LoginScreen({ users, onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState("");

  const submit = (e) => {
    e.preventDefault();
    const u = users.find(
      (x) => x.username.trim().toLowerCase() === username.trim().toLowerCase() && x.password === password
    );
    if (!u) {
      setErr("اسم المستخدم أو كلمة المرور غير صحيحة");
      return;
    }
    setErr("");
    onLogin(u);
  };

  return (
    <div className="min-h-screen w-full bg-[var(--bg)] flex items-center justify-center px-4" dir="rtl">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <PerfumeMark size={64} />
          <h1 className="mt-3 text-3xl font-bold text-[#5B2333]" style={{ fontFamily: "'Amiri', serif" }}>
            عطورنا
          </h1>
          <p className="text-[#8A7B6C] text-sm mt-1">نظام إدارة مبيعات العطور والبخور</p>
        </div>
        <Card className="p-6">
          <form onSubmit={submit} className="space-y-4">
            <Field label="اسم المستخدم">
              <input className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="مثال: admin" autoFocus />
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
                <button type="button" onClick={() => setShowPw((s) => !s)} className="absolute left-2 top-1/2 -translate-y-1/2 text-[#8A7B6C]">
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
        </Card>
        <p className="text-center text-xs text-[#B8AFA0] mt-4">
          الدخول الافتراضي للمدير: admin / admin123
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
  { key: "users", label: "المستخدمون", icon: UsersIcon, roles: ["admin"] },
  { key: "settings", label: "الإعدادات", icon: SettingsIcon, roles: ["admin"] },
  { key: "backup", label: "النسخ الاحتياطي", icon: Save, roles: ["admin"] },
];

/* ---------------------------------- App Shell ---------------------------------- */

export default function App() {
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState([]);
  const [products, setProducts] = useState([]);
  const [sales, setSales] = useState([]);
  const [seq, setSeq] = useState({});
  const [settings, setSettings] = useState({ companyName: "عطورنا للعطور والبخور", logo: "", phone: "", address: "" });
  const [currentUser, setCurrentUser] = useState(null);
  const [view, setView] = useState("dashboard");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [printPayload, setPrintPayload] = useState(null); // {type:'invoice'|'record', data}
  const [editingSale, setEditingSale] = useState(null);
  const [darkMode, setDarkMode] = useState(false);
  const [toast, setToast] = useState("");

  // Keeps the last-synced snapshot so the periodic refresh below can skip
  // re-rendering when nothing actually changed on the shared database.
  const lastSnapshot = useRef("");

  const loadAll = useCallback(async (isInitial) => {
    let u = await storeGet("perfume_users", null);
    if (!u || u.length === 0) {
      u = [{ id: uid(), username: "admin", password: "admin123", name: "المدير", role: "admin" }];
      await storeSet("perfume_users", u);
    }
    const p = await storeGet("perfume_products", []);
    const s = await storeGet("perfume_sales", []);
    const sq = await storeGet("perfume_seq", {});
    const st = await storeGet("perfume_settings", { companyName: "عطورنا للعطور والبخور", logo: "", phone: "", address: "" });

    const snapshot = JSON.stringify({ u, p, s, sq, st });
    if (snapshot === lastSnapshot.current) return; // nothing new, avoid needless re-render
    lastSnapshot.current = snapshot;

    setUsers(u);
    setProducts(p);
    setSales(s);
    setSeq(sq);
    setSettings(st);
    if (isInitial) setLoading(false);
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

  // Dark mode is a per-device preference, not shared business data.
  useEffect(() => {
    (async () => {
      const saved = await storeGet("perfume_darkmode", false, false);
      setDarkMode(!!saved);
    })();
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

  const toggleDarkMode = () => {
    setDarkMode((d) => {
      const next = !d;
      storeSet("perfume_darkmode", next, false);
      return next;
    });
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

  const updateSale = async (id, updates) => {
    const next = sales.map((s) => (s.id === id ? { ...s, ...updates } : s));
    await persistSales(next);
  };

  // Full invoice edit (admin only): replaces items/collected and reconciles stock deltas.
  const editSaleWithStock = async (id, newItems, newCollected) => {
    const oldSale = sales.find((s) => s.id === id);
    if (!oldSale) return;
    const total = newItems.reduce((a, l) => a + l.total, 0);
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
    await updateSale(id, { items: newItems, total, collected, remaining });
  };

  const isAdmin = currentUser?.role === "admin";

  const visibleNav = NAV_ITEMS.filter((n) => n.roles.includes(currentUser?.role));

  const doPrint = () => {
    setTimeout(() => window.print(), 50);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center" dir="rtl">
        <div className="flex flex-col items-center gap-3">
          <PerfumeMark size={48} />
          <p className="text-[#8A7B6C] text-sm">جارِ التحميل...</p>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <>
        <GlobalStyle />
        <LoginScreen users={users} onLogin={(u) => { setCurrentUser(u); setView("dashboard"); }} />
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

      {editingSale && (
        <EditSaleModal
          sale={editingSale}
          products={products}
          onClose={() => setEditingSale(null)}
          onSave={async (newItems, newCollected) => {
            await editSaleWithStock(editingSale.id, newItems, newCollected);
            setEditingSale(null);
            showToast("تم تعديل الفاتورة بنجاح");
          }}
        />
      )}

      {/* Top bar */}
      <header className="no-print sticky top-0 z-30 bg-[var(--bg)]/95 backdrop-blur border-b border-[var(--border)]">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <button className="md:hidden p-2 -mr-2 text-[#5B2333]" onClick={() => setMobileNavOpen(true)}>
              <Menu size={22} />
            </button>
            <PerfumeMark size={32} />
            <span className="font-bold text-[#5B2333] text-lg" style={{ fontFamily: "'Amiri', serif" }}>
              {settings.companyName || "عطورنا"}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-left hidden sm:block">
              <p className="text-xs text-[var(--muted)] leading-tight">{isAdmin ? "مدير النظام" : "بائع"}</p>
              <p className="text-sm font-semibold leading-tight">{currentUser.name}</p>
            </div>
            <button
              onClick={toggleDarkMode}
              className="p-2 rounded-lg text-[#B8894A] hover:bg-[var(--surface-3)]"
              title={darkMode ? "الوضع الفاتح" : "الوضع الداكن"}
            >
              {darkMode ? <Sun size={20} /> : <Moon size={20} />}
            </button>
            <button
              onClick={() => setCurrentUser(null)}
              className="p-2 rounded-lg text-[#B23A3A] hover:bg-[#FBEAEA]"
              title="تسجيل الخروج"
            >
              <LogOut size={20} />
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto md:flex">
        {/* Sidebar (desktop) */}
        <aside className="no-print hidden md:flex md:flex-col md:w-56 shrink-0 border-l border-[var(--border)] py-4 px-2 gap-1 min-h-[calc(100vh-61px)]">
          {visibleNav.map((n) => (
            <NavBtn key={n.key} item={n} active={view === n.key} onClick={() => setView(n.key)} />
          ))}
        </aside>

        {/* Mobile nav drawer */}
        {mobileNavOpen && (
          <div className="no-print fixed inset-0 z-40 md:hidden">
            <div className="absolute inset-0 bg-black/30" onClick={() => setMobileNavOpen(false)} />
            <div className="absolute right-0 top-0 bottom-0 w-64 bg-[var(--surface)] shadow-xl p-3 flex flex-col gap-1">
              <div className="flex items-center justify-between px-2 py-2 mb-2">
                <div className="flex items-center gap-2">
                  <PerfumeMark size={28} />
                  <span className="font-bold text-[#5B2333]" style={{ fontFamily: "'Amiri', serif" }}>عطورنا</span>
                </div>
                <button onClick={() => setMobileNavOpen(false)} className="p-1 text-[var(--muted)]">
                  <X size={20} />
                </button>
              </div>
              {visibleNav.map((n) => (
                <NavBtn
                  key={n.key}
                  item={n}
                  active={view === n.key}
                  onClick={() => { setView(n.key); setMobileNavOpen(false); }}
                />
              ))}
            </div>
          </div>
        )}

        {/* Main content */}
        <main className="no-print flex-1 min-w-0 px-4 py-5 pb-24 md:pb-8">
          {view === "dashboard" && (
            <Dashboard sales={sales} products={products} currentUser={currentUser} setView={setView} />
          )}
          {view === "newsale" && (
            <NewSale
              products={products}
              users={users}
              currentUser={currentUser}
              sales={sales}
              seq={seq}
              onCreate={async (sale, updatedProducts, newSeq) => {
                await persistProducts(updatedProducts);
                await persistSales([sale, ...sales]);
                await persistSeq(newSeq);
                showToast("تم تسجيل عملية البيع وإصدار الفاتورة بنجاح");
                setPrintPayload({ type: "invoice", data: sale });
                setView("records");
              }}
            />
          )}
          {view === "records" && (
            <SalesRecords
              sales={sales}
              users={users}
              currentUser={currentUser}
              isAdmin={isAdmin}
              onDelete={async (id) => {
                await persistSales(sales.filter((s) => s.id !== id));
                showToast("تم حذف السجل");
              }}
              onPrintInvoice={(sale) => setPrintPayload({ type: "invoice", data: sale })}
              onPrintRecord={(sellerName, list) => setPrintPayload({ type: "record", data: { sellerName, list } })}
              onCollectPayment={async (id, amount) => {
                const sale = sales.find((s) => s.id === id);
                if (!sale) return;
                const collected = Math.min(sale.total, sale.collected + amount);
                await updateSale(id, { collected, remaining: Math.max(0, sale.total - collected) });
                showToast("تم تسجيل التحصيل");
              }}
              onEditSale={(sale) => setEditingSale(sale)}
            />
          )}
          {view === "stats" && <Stats sales={sales} users={users} currentUser={currentUser} isAdmin={isAdmin} />}
          {view === "inventory" && (
            <Inventory
              products={products}
              isAdmin={isAdmin}
              onSave={async (next) => { await persistProducts(next); showToast("تم حفظ المخزون"); }}
            />
          )}
          {view === "users" && isAdmin && (
            <UsersAdmin users={users} onSave={async (next) => { await persistUsers(next); showToast("تم حفظ المستخدمين"); }} />
          )}
          {view === "settings" && isAdmin && (
            <SettingsPage settings={settings} onSave={async (next) => { await persistSettings(next); showToast("تم حفظ الإعدادات"); }} />
          )}
          {view === "backup" && isAdmin && (
            <BackupPage
              data={{ users, products, sales, seq, settings }}
              onRestore={async (next, mode) => {
                if (mode === "replace") {
                  await persistUsers(next.users || users);
                  await persistProducts(next.products || products);
                  await persistSales(next.sales || sales);
                  await persistSeq(next.seq || seq);
                  await persistSettings(next.settings || settings);
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
                }
                showToast("تمت استعادة البيانات بنجاح");
              }}
            />
          )}
        </main>
      </div>

      {/* Mobile bottom nav */}
      <nav className="no-print md:hidden fixed bottom-0 inset-x-0 z-30 bg-[var(--surface)] border-t border-[var(--border)] flex justify-around py-1.5">
        {visibleNav.slice(0, 5).map((n) => {
          const Icon = n.icon;
          const active = view === n.key;
          return (
            <button
              key={n.key}
              onClick={() => setView(n.key)}
              className={`flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg text-[10px] font-semibold ${active ? "text-[#B8894A]" : "text-[#8A7B6C]"}`}
            >
              <Icon size={20} />
              {n.label}
            </button>
          );
        })}
      </nav>

      {toast && (
        <div className="no-print fixed bottom-20 md:bottom-6 inset-x-0 flex justify-center z-50">
          <div className="bg-[#2B211A] text-white text-sm px-4 py-2.5 rounded-xl shadow-lg flex items-center gap-2">
            <Check size={16} className="text-[#8FD19E]" /> {toast}
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
        active ? "bg-[#5B2333] text-white" : "text-[var(--text)] hover:bg-[var(--surface-3)]"
      }`}
    >
      <Icon size={18} />
      {item.label}
    </button>
  );
}

function GlobalStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Tajawal:wght@400;500;700;900&display=swap');
      * { font-family: 'Tajawal', sans-serif; }

      :root {
        --bg: #ffffff;
        --surface: #ffffff;
        --surface-2: #FBF9F5;
        --surface-3: #F7F1E6;
        --border: #F0E6D0;
        --text: #2B211A;
        --muted: #8A7B6C;
        --input-bg: #FBF9F5;
      }
      html.dark {
        --bg: #16110F;
        --surface: #211A18;
        --surface-2: #291F1C;
        --surface-3: #2F2420;
        --border: #3D2E28;
        --text: #F3E9DE;
        --muted: #C2AC9B;
        --input-bg: #291F1C;
      }
      html, body { background: var(--bg); }
      body { color: var(--text); transition: background-color .2s ease, color .2s ease; }

      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 8px; }
      @media print {
        .no-print { display: none !important; }
        html, body { background: white !important; }
      }
    `}</style>
  );
}


/* ---------------------------------- Dashboard ---------------------------------- */

function Dashboard({ sales, products, currentUser, setView }) {
  const isAdmin = currentUser.role === "admin";
  const mySales = sales; // everyone can see overall store sales now
  const totalRevenue = mySales.reduce((a, s) => a + s.total, 0);
  const totalCollected = mySales.reduce((a, s) => a + s.collected, 0);
  const totalRemaining = mySales.reduce((a, s) => a + s.remaining, 0);
  const lowStock = products.filter((p) => p.stock <= (p.minStock ?? 5));

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold text-[var(--text)]">مرحباً، {currentUser.name} 🌸</h2>
        <p className="text-sm text-[var(--muted)]">نظرة عامة على أداء المتجر</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="عدد الفواتير" value={mySales.length} color="#5B2333" />
        <StatCard label="إجمالي المبيعات" value={fmt(totalRevenue) + " د.ك"} color="#B8894A" />
        <StatCard label="المحصل" value={fmt(totalCollected) + " د.ك"} color="#3F7D57" />
        <StatCard label="المتبقي" value={fmt(totalRemaining) + " د.ك"} color="#B23A3A" />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-4">
          <h3 className="font-bold mb-3">آخر المبيعات</h3>
          {mySales.length === 0 ? (
            <EmptyState text="لا توجد مبيعات مسجلة بعد" />
          ) : (
            <div className="space-y-2">
              {mySales.slice(0, 5).map((s) => (
                <div key={s.id} className="flex items-center justify-between text-sm border-b border-[#F5EEDF] pb-2 last:border-0">
                  <div>
                    <p className="font-semibold">{s.invoiceNo}</p>
                    <p className="text-xs text-[#8A7B6C]">{s.sellerName} · {dateLabel(s.date)}</p>
                  </div>
                  <p className="font-bold text-[#B8894A]">{fmt(s.total)} د.ك</p>
                </div>
              ))}
            </div>
          )}
          <button onClick={() => setView("newsale")} className="mt-3 text-sm font-semibold text-[#B8894A] flex items-center gap-1">
            <Plus size={16} /> تسجيل عملية بيع جديدة
          </button>
        </Card>

        <Card className="p-4">
          <h3 className="font-bold mb-3">تنبيهات المخزون</h3>
          {lowStock.length === 0 ? (
            <EmptyState text="جميع المنتجات بكميات كافية" />
          ) : (
            <div className="space-y-2">
              {lowStock.slice(0, 6).map((p) => (
                <div key={p.id} className="flex items-center justify-between text-sm">
                  <p className="font-semibold flex items-center gap-1.5"><AlertTriangle size={14} className="text-[#B23A3A]" />{p.name}</p>
                  <p className="text-[#B23A3A] font-bold">{p.stock} متبقي</p>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-[#8A7B6C] mb-1">{label}</p>
      <p className="text-lg font-extrabold" style={{ color }}>{value}</p>
    </Card>
  );
}

function EmptyState({ text }) {
  return (
    <div className="text-center py-6 text-sm text-[#B8AFA0]">
      <p>{text}</p>
    </div>
  );
}

/* ---------------------------------- New Sale ---------------------------------- */

function NewSale({ products, users, currentUser, sales, seq, onCreate }) {
  const isAdmin = currentUser.role === "admin";
  const sellers = users.filter((u) => u.role === "seller" || u.role === "admin");
  const [sellerId, setSellerId] = useState(currentUser.id);
  const [cart, setCart] = useState([]);
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState(1);
  const [unitPrice, setUnitPrice] = useState("");
  const [collected, setCollected] = useState("");

  const seller = users.find((u) => u.id === sellerId) || currentUser;
  const selectedProduct = products.find((p) => p.id === productId);

  useEffect(() => {
    if (selectedProduct) setUnitPrice(String(selectedProduct.price));
  }, [productId]); // eslint-disable-line

  const addToCart = () => {
    if (!selectedProduct) return;
    const q = Number(qty);
    const price = Number(unitPrice);
    if (!q || q <= 0) return;
    const availableStock = selectedProduct.stock - cart.filter((c) => c.productId === productId).reduce((a, c) => a + c.qty, 0);
    if (q > availableStock) return;
    setCart((c) => [...c, { lineId: uid(), productId: selectedProduct.id, name: selectedProduct.name, qty: q, price, total: q * price }]);
    setProductId("");
    setQty(1);
    setUnitPrice("");
  };

  const removeLine = (lineId) => setCart((c) => c.filter((l) => l.lineId !== lineId));

  const total = cart.reduce((a, l) => a + l.total, 0);
  const collectedNum = collected === "" ? total : Number(collected);
  const remaining = Math.max(0, total - collectedNum);

  const submit = async () => {
    if (cart.length === 0) return;
    const updatedProducts = products.map((p) => {
      const used = cart.filter((c) => c.productId === p.id).reduce((a, c) => a + c.qty, 0);
      return used ? { ...p, stock: p.stock - used } : p;
    });
    const key = seller.name;
    const nextNum = (seq[key] || 0) + 1;
    const newSeq = { ...seq, [key]: nextNum };
    const invoiceNo = `${seller.name.replace(/\s+/g, "").slice(0, 4).toUpperCase()}-${String(nextNum).padStart(4, "0")}`;
    const sale = {
      id: uid(),
      invoiceNo,
      sellerId: seller.id,
      sellerName: seller.name,
      date: todayISO(),
      items: cart,
      total,
      collected: collectedNum,
      remaining,
    };
    await onCreate(sale, updatedProducts, newSeq);
    setCart([]);
    setCollected("");
  };

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

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="col-span-2 md:col-span-2">
            <Field label="المنتج">
              <select className={inputCls} value={productId} onChange={(e) => setProductId(e.target.value)}>
                <option value="">اختر منتج...</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id} disabled={p.stock <= 0}>
                    {p.name} — متبقي {p.stock}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="الكمية">
            <input type="number" min="1" className={inputCls} value={qty} onChange={(e) => setQty(e.target.value)} />
          </Field>
          <Field label="سعر الوحدة (د.ك)">
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
              <div key={l.lineId} className="flex items-center justify-between text-sm bg-[#FBF9F5] rounded-xl px-3 py-2">
                <div>
                  <p className="font-semibold">{l.name}</p>
                  <p className="text-xs text-[#8A7B6C]">{l.qty} × {fmt(l.price)} د.ك</p>
                </div>
                <div className="flex items-center gap-3">
                  <p className="font-bold text-[#B8894A]">{fmt(l.total)} د.ك</p>
                  <button onClick={() => removeLine(l.lineId)} className="text-[#B23A3A]"><Trash2 size={16} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {cart.length > 0 && (
        <Card className="p-4 space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-[#8A7B6C]">الإجمالي</span>
            <span className="font-extrabold text-lg">{fmt(total)} د.ك</span>
          </div>
          <Field label="المبلغ المحصل (د.ك)">
            <input type="number" min="0" step="0.001" className={inputCls} value={collected} placeholder={fmt(total)} onChange={(e) => setCollected(e.target.value)} />
          </Field>
          <div className="flex justify-between text-sm">
            <span className="text-[#8A7B6C]">المبلغ المتبقي</span>
            <span className={`font-bold ${remaining > 0 ? "text-[#B23A3A]" : "text-[#3F7D57]"}`}>{fmt(remaining)} د.ك</span>
          </div>
          <Btn onClick={submit} className="w-full">
            <Receipt size={16} /> إصدار الفاتورة وحفظ عملية البيع
          </Btn>
        </Card>
      )}
    </div>
  );
}

/* ---------------------------------- Sales Records ---------------------------------- */

function SalesRecords({ sales, users, currentUser, isAdmin, onDelete, onPrintInvoice, onPrintRecord, onCollectPayment, onEditSale }) {
  const [sellerFilter, setSellerFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [payingId, setPayingId] = useState(null);
  const [payAmount, setPayAmount] = useState("");

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

  const sellerName = sellerFilter !== "all" ? sellers.find(([id]) => id === sellerFilter)?.[1] : currentUser.name;

  const submitPayment = (sale) => {
    const amount = Number(payAmount);
    if (!amount || amount <= 0) return;
    onCollectPayment(sale.id, amount);
    setPayingId(null);
    setPayAmount("");
  };

  const PayRow = ({ sale }) => (
    <div className="mt-2 flex gap-2 items-center bg-[var(--surface-2)] rounded-xl p-2">
      <input
        type="number"
        min="0"
        step="0.001"
        autoFocus
        className={inputCls + " flex-1 !py-2"}
        placeholder={`حتى ${fmt(sale.remaining)} د.ك`}
        value={payAmount}
        onChange={(e) => setPayAmount(e.target.value)}
      />
      <Btn className="!py-2 !px-3 text-xs" onClick={() => submitPayment(sale)}>
        <Check size={14} /> تأكيد
      </Btn>
      <button onClick={() => { setPayingId(null); setPayAmount(""); }} className="p-2 text-[var(--muted)]">
        <X size={16} />
      </button>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-xl font-bold">سجل المبيعات</h2>
        <div className="flex gap-2">
          <Btn variant="outline" onClick={() => onPrintRecord(sellerFilter === "all" ? "الكل" : sellerName, list)}>
            <Printer size={16} /> طباعة السجل PDF
          </Btn>
          <Btn variant="ghost" onClick={() => exportSalesCsv(sellerFilter === "all" ? "الكل" : sellerName, list)}>
            <Download size={16} /> تصدير Excel
          </Btn>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
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
        <Card className="p-8"><EmptyState text="لا توجد سجلات مطابقة" /></Card>
      ) : (
        <>
          {/* Mobile cards */}
          <div className="space-y-3 md:hidden">
            {list.map((s) => (
              <Card key={s.id} className="p-4">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <p className="font-bold">{s.invoiceNo}</p>
                    <p className="text-xs text-[var(--muted)]">{s.sellerName} · {dateLabel(s.date)} {timeLabel(s.date)}</p>
                  </div>
                  <p className="font-extrabold text-[#B8894A]">{fmt(s.total)} د.ك</p>
                </div>
                <div className="text-xs text-[var(--muted)] mb-2">{s.items.map((i) => i.name).join("، ")}</div>
                <div className="flex justify-between text-xs mb-3">
                  <span className="text-[#3F7D57] font-semibold">محصل: {fmt(s.collected)}</span>
                  <span className="text-[#B23A3A] font-semibold">متبقي: {fmt(s.remaining)}</span>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <Btn variant="ghost" className="flex-1 py-2 text-xs" onClick={() => onPrintInvoice(s)}>
                    <Printer size={14} /> طباعة الفاتورة
                  </Btn>
                  {s.remaining > 0 && (
                    <Btn variant="dark" className="flex-1 py-2 text-xs" onClick={() => { setPayingId(s.id); setPayAmount(""); }}>
                      <Wallet size={14} /> تسجيل تحصيل
                    </Btn>
                  )}
                  {isAdmin && (
                    <>
                      <button onClick={() => onEditSale(s)} className="p-2.5 rounded-xl bg-[var(--surface-3)] text-[#5B2333]"><Pencil size={16} /></button>
                      <button onClick={() => onDelete(s.id)} className="p-2.5 rounded-xl bg-[#FBEAEA] text-[#B23A3A]"><Trash2 size={16} /></button>
                    </>
                  )}
                </div>
                {payingId === s.id && <PayRow sale={s} />}
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
                      <td className="px-4 py-3 font-bold">{s.invoiceNo}</td>
                      <td className="px-4 py-3">{s.sellerName}</td>
                      <td className="px-4 py-3 text-[var(--muted)]">{dateLabel(s.date)}</td>
                      <td className="px-4 py-3 text-[var(--muted)] max-w-[220px] truncate">{s.items.map((i) => i.name).join("، ")}</td>
                      <td className="px-4 py-3 font-bold text-[#B8894A]">{fmt(s.total)}</td>
                      <td className="px-4 py-3 text-[#3F7D57] font-semibold">{fmt(s.collected)}</td>
                      <td className="px-4 py-3 text-[#B23A3A] font-semibold">{fmt(s.remaining)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button onClick={() => onPrintInvoice(s)} className="p-1.5 rounded-lg text-[#5B2333] hover:bg-[var(--surface-3)]" title="طباعة"><Printer size={16} /></button>
                          {s.remaining > 0 && (
                            <button onClick={() => { setPayingId(payingId === s.id ? null : s.id); setPayAmount(""); }} className="p-1.5 rounded-lg text-[#3F7D57] hover:bg-[var(--surface-3)]" title="تسجيل تحصيل"><Wallet size={16} /></button>
                          )}
                          {isAdmin && (
                            <>
                              <button onClick={() => onEditSale(s)} className="p-1.5 rounded-lg text-[#5B2333] hover:bg-[var(--surface-3)]" title="تعديل"><Pencil size={16} /></button>
                              <button onClick={() => onDelete(s.id)} className="p-1.5 rounded-lg text-[#B23A3A] hover:bg-[#FBEAEA]" title="حذف"><Trash2 size={16} /></button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                    {payingId === s.id && (
                      <tr>
                        <td colSpan={8} className="px-4 pb-3">
                          <PayRow sale={s} />
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

/* ---------------------------------- Stats ---------------------------------- */

function Stats({ sales, users, currentUser, isAdmin }) {
  const [sellerFilter, setSellerFilter] = useState("all");
  const sellers = users.filter((u) => u.role === "seller" || u.role === "admin");

  let list = sales;
  if (sellerFilter !== "all") list = list.filter((s) => s.sellerId === sellerFilter);

  const totalRevenue = list.reduce((a, s) => a + s.total, 0);
  const totalCollected = list.reduce((a, s) => a + s.collected, 0);
  const totalRemaining = list.reduce((a, s) => a + s.remaining, 0);

  const bySeller = useMemo(() => {
    const map = new Map();
    sales.forEach((s) => {
      const cur = map.get(s.sellerName) || { name: s.sellerName, total: 0, count: 0 };
      cur.total += s.total;
      cur.count += 1;
      map.set(s.sellerName, cur);
    });
    return Array.from(map.values());
  }, [sales]);

  const byProduct = useMemo(() => {
    const map = new Map();
    list.forEach((s) => s.items.forEach((i) => {
      const cur = map.get(i.name) || { name: i.name, qty: 0 };
      cur.qty += i.qty;
      map.set(i.name, cur);
    }));
    return Array.from(map.values()).sort((a, b) => b.qty - a.qty).slice(0, 6);
  }, [list]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-xl font-bold">إحصائيات المبيعات</h2>
        <select className={inputCls + " sm:w-56"} value={sellerFilter} onChange={(e) => setSellerFilter(e.target.value)}>
          <option value="all">كل البائعين</option>
          {sellers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="عدد الفواتير" value={list.length} color="#5B2333" />
        <StatCard label="إجمالي المبيعات" value={fmt(totalRevenue) + " د.ك"} color="#B8894A" />
        <StatCard label="المحصل" value={fmt(totalCollected) + " د.ك"} color="#3F7D57" />
        <StatCard label="المتبقي" value={fmt(totalRemaining) + " د.ك"} color="#B23A3A" />
      </div>

      {sellerFilter === "all" && bySeller.length > 0 && (
        <Card className="p-4">
          <h3 className="font-bold mb-3">مبيعات كل بائع</h3>
          <div style={{ width: "100%", height: 260 }}>
            <ResponsiveContainer>
              <BarChart data={bySeller}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F0E6D0" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v) => fmt(v) + " د.ك"} />
                <Bar dataKey="total" fill="#B8894A" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {byProduct.length > 0 && (
        <Card className="p-4">
          <h3 className="font-bold mb-3">الأكثر مبيعاً</h3>
          <div style={{ width: "100%", height: 260 }}>
            <ResponsiveContainer>
              <PieChart>
                <Pie data={byProduct} dataKey="qty" nameKey="name" outerRadius={90} label={(e) => e.name}>
                  {byProduct.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ---------------------------------- Inventory ---------------------------------- */

function Inventory({ products, isAdmin, onSave }) {
  const [form, setForm] = useState({ name: "", price: "", stock: "", minStock: "5" });
  const [editingId, setEditingId] = useState(null);

  const resetForm = () => { setForm({ name: "", price: "", stock: "", minStock: "5" }); setEditingId(null); };

  const submit = () => {
    if (!form.name || form.price === "" || form.stock === "") return;
    if (editingId) {
      onSave(products.map((p) => p.id === editingId ? { ...p, name: form.name, price: Number(form.price), stock: Number(form.stock), minStock: Number(form.minStock || 5) } : p));
    } else {
      onSave([...products, { id: uid(), name: form.name, price: Number(form.price), stock: Number(form.stock), minStock: Number(form.minStock || 5) }]);
    }
    resetForm();
  };

  const startEdit = (p) => { setForm({ name: p.name, price: String(p.price), stock: String(p.stock), minStock: String(p.minStock ?? 5) }); setEditingId(p.id); };

  return (
    <div className="space-y-5">
      <h2 className="text-xl font-bold">المخزون والمنتجات</h2>

      {isAdmin && (
        <Card className="p-4">
          <h3 className="font-bold mb-3">{editingId ? "تعديل منتج" : "إضافة منتج جديد"}</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="col-span-2 md:col-span-1">
              <Field label="اسم المنتج"><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="عود كمبودي" /></Field>
            </div>
            <Field label="السعر (د.ك)"><input type="number" step="0.001" className={inputCls} value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></Field>
            <Field label="الكمية بالمخزون"><input type="number" className={inputCls} value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} /></Field>
            <Field label="حد التنبيه"><input type="number" className={inputCls} value={form.minStock} onChange={(e) => setForm({ ...form, minStock: e.target.value })} /></Field>
          </div>
          <div className="flex gap-2 mt-3">
            <Btn onClick={submit}><Plus size={16} /> {editingId ? "حفظ التعديل" : "إضافة المنتج"}</Btn>
            {editingId && <Btn variant="outline" onClick={resetForm}>إلغاء</Btn>}
          </div>
        </Card>
      )}

      {products.length === 0 ? (
        <Card className="p-8"><EmptyState text="لا توجد منتجات مضافة بعد" /></Card>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {products.map((p) => (
            <Card key={p.id} className="p-4">
              <div className="flex justify-between items-start">
                <div>
                  <p className="font-bold">{p.name}</p>
                  <p className="text-xs text-[#8A7B6C]">{fmt(p.price)} د.ك / وحدة</p>
                </div>
                {p.stock <= (p.minStock ?? 5) && <AlertTriangle size={16} className="text-[#B23A3A]" />}
              </div>
              <p className={`mt-2 text-sm font-bold ${p.stock <= (p.minStock ?? 5) ? "text-[#B23A3A]" : "text-[#3F7D57]"}`}>
                الكمية المتبقية: {p.stock}
              </p>
              {isAdmin && (
                <div className="flex gap-2 mt-3">
                  <button onClick={() => startEdit(p)} className="text-xs font-semibold text-[#5B2333] bg-[#F7F1E6] rounded-lg px-3 py-1.5">تعديل</button>
                  <button onClick={() => onSave(products.filter((x) => x.id !== p.id))} className="text-xs font-semibold text-[#B23A3A] bg-[#FBEAEA] rounded-lg px-3 py-1.5">حذف</button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------- Users Admin ---------------------------------- */

function UsersAdmin({ users, onSave }) {
  const [form, setForm] = useState({ username: "", password: "", name: "", role: "seller" });

  const submit = () => {
    if (!form.username || !form.password || !form.name) return;
    if (users.some((u) => u.username.toLowerCase() === form.username.toLowerCase())) return;
    onSave([...users, { id: uid(), ...form }]);
    setForm({ username: "", password: "", name: "", role: "seller" });
  };

  return (
    <div className="space-y-5">
      <h2 className="text-xl font-bold">إدارة المستخدمين والصلاحيات</h2>

      <Card className="p-4">
        <h3 className="font-bold mb-3">إضافة مستخدم جديد</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="الاسم"><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="الدور">
            <select className={inputCls} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="seller">بائع</option>
              <option value="admin">مدير</option>
            </select>
          </Field>
          <Field label="اسم المستخدم"><input className={inputCls} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></Field>
          <Field label="كلمة المرور"><input className={inputCls} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
        </div>
        <Btn onClick={submit} className="mt-3"><Plus size={16} /> إضافة المستخدم</Btn>
      </Card>

      <div className="space-y-2">
        {users.map((u) => (
          <Card key={u.id} className="p-4 flex items-center justify-between">
            <div>
              <p className="font-bold">{u.name} <span className="text-xs font-normal text-[#8A7B6C]">({u.username})</span></p>
              <p className="text-xs text-[#8A7B6C]">{u.role === "admin" ? "مدير" : "بائع"}</p>
            </div>
            {users.length > 1 && (
              <button onClick={() => onSave(users.filter((x) => x.id !== u.id))} className="p-2 rounded-lg text-[#B23A3A] hover:bg-[#FBEAEA]"><Trash2 size={16} /></button>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------- Settings ---------------------------------- */

function SettingsPage({ settings, onSave }) {
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
          <span className="block text-xs font-semibold text-[#8A7B6C] mb-2">شعار الشركة (Logo)</span>
          <div className="flex items-center gap-3">
            {form.logo ? (
              <img src={form.logo} alt="logo" className="w-16 h-16 rounded-xl object-cover border border-[#E3D6BE]" />
            ) : (
              <div className="w-16 h-16 rounded-xl bg-[#FBF9F5] border border-dashed border-[#E3D6BE] flex items-center justify-center text-[#B8AFA0]">
                <ImageIcon size={22} />
              </div>
            )}
            <input ref={fileRef} type="file" accept="image/*" onChange={handleLogo} className="hidden" />
            <Btn variant="outline" onClick={() => fileRef.current?.click()}><Upload size={16} /> رفع شعار</Btn>
            {form.logo && <Btn variant="ghost" onClick={() => setForm({ ...form, logo: "" })}>إزالة</Btn>}
          </div>
        </div>
        <Btn onClick={() => onSave(form)} className="w-full"><Save size={16} /> حفظ الإعدادات</Btn>
      </Card>
      <p className="text-xs text-[#B8AFA0]">سيظهر اسم الشركة والشعار تلقائياً في جميع الفواتير المطبوعة.</p>
    </div>
  );
}

/* ---------------------------------- Backup ---------------------------------- */

function BackupPage({ data, onRestore }) {
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
        <h3 className="font-bold mb-2">تنزيل نسخة احتياطية</h3>
        <p className="text-sm text-[#8A7B6C] mb-3">يشمل: المستخدمين، المنتجات، المبيعات، الفواتير، الإعدادات.</p>
        <Btn onClick={exportData}><Download size={16} /> تنزيل نسخة JSON</Btn>
      </Card>

      <Card className="p-4">
        <h3 className="font-bold mb-2">استعادة / دمج نسخة</h3>
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

function EditSaleModal({ sale, products, onClose, onSave }) {
  const [items, setItems] = useState(sale.items.map((i) => ({ ...i })));
  const [collected, setCollected] = useState(String(sale.collected));
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState(1);
  const [unitPrice, setUnitPrice] = useState("");

  const selectedProduct = products.find((p) => p.id === productId);
  useEffect(() => {
    if (selectedProduct) setUnitPrice(String(selectedProduct.price));
  }, [productId]); // eslint-disable-line

  // Stock available for a product = current stock + whatever this invoice already reserved for it.
  const availableFor = (pid) => {
    const p = products.find((x) => x.id === pid);
    if (!p) return 0;
    const reserved = sale.items.filter((i) => i.productId === pid).reduce((a, i) => a + i.qty, 0);
    const usedInEdit = items.filter((i) => i.productId === pid).reduce((a, i) => a + i.qty, 0);
    return p.stock + reserved - usedInEdit;
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
    setItems((c) => c.map((l) => (l.lineId === lineId ? { ...l, qty: newQty, total: newQty * l.price } : l)));
  };

  const total = items.reduce((a, l) => a + l.total, 0);

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/50 p-4" dir="rtl">
      <div className="bg-[var(--surface)] rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">تعديل فاتورة {sale.invoiceNo}</h3>
          <button onClick={onClose} className="p-1 text-[var(--muted)]"><X size={20} /></button>
        </div>

        <div className="space-y-2 mb-4">
          {items.map((l) => (
            <div key={l.lineId} className="flex items-center gap-2 bg-[var(--surface-2)] rounded-xl px-3 py-2">
              <div className="flex-1">
                <p className="text-sm font-semibold">{l.name}</p>
                <p className="text-xs text-[var(--muted)]">{fmt(l.price)} د.ك / وحدة</p>
              </div>
              <input
                type="number"
                min="1"
                className="w-16 rounded-lg border border-[var(--border)] bg-[var(--input-bg)] px-2 py-1 text-sm text-center"
                value={l.qty}
                onChange={(e) => updateLineQty(l.lineId, Math.max(1, Number(e.target.value) || 1))}
              />
              <p className="text-sm font-bold text-[#B8894A] w-20 text-left">{fmt(l.total)}</p>
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
          <span className="text-[var(--muted)]">الإجمالي الجديد</span>
          <span className="font-extrabold text-lg">{fmt(total)} د.ك</span>
        </div>
        <Field label="المبلغ المحصل (د.ك)">
          <input type="number" min="0" step="0.001" className={inputCls} value={collected} onChange={(e) => setCollected(e.target.value)} />
        </Field>

        <div className="flex gap-2 mt-4">
          <Btn className="flex-1" onClick={() => onSave(items, Number(collected) || 0)}>
            <Save size={16} /> حفظ التعديلات
          </Btn>
          <Btn variant="outline" onClick={onClose}>إلغاء</Btn>
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
          .print-area { position: fixed; inset: 0; background: white; z-index: 9999; overflow: visible; }
          .print-toolbar { display: none !important; }
          .print-sheet { width: auto; max-width: none; padding: 0; box-shadow: none; }
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
          style={{ background: "#B8894A", color: "white", borderRadius: 10, padding: "10px 18px", fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}
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
        ) : (
          <RecordDoc sellerName={payload.data.sellerName} list={payload.data.list} settings={settings} />
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
      <h2 style={{ fontSize: 18, fontWeight: 800, color: "#2B211A", marginBottom: 4 }}>فاتورة مبيعة</h2>
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
              <td style={tdStyle}>{fmt(i.price)} د.ك</td>
              <td style={tdStyle}>{fmt(i.total)} د.ك</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 20, marginRight: "auto", width: 260, marginLeft: 0, marginInlineStart: "auto" }}>
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

function TotalRow({ label, value, bold, color }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: bold ? 15 : 13, fontWeight: bold ? 800 : 600, color: color || "#2B211A" }}>
      <span>{label}</span>
      <span>{fmt(value)} د.ك</span>
    </div>
  );
}
