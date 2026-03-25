require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());

const REQUIRED_ENV_VARS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ADMIN_DASHBOARD_KEY"
];

const missingEnvVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missingEnvVars.length > 0) {
  console.error(`Missing required environment variables: ${missingEnvVars.join(", ")}`);
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const MAMO_BASE = (process.env.MAMO_API_BASE_URL || "https://business.mamopay.com/manage_api/v1").replace(/\/$/, "");

function requireAdmin(req, res, next) {
  const incomingKey = req.headers["x-admin-key"];
  if (incomingKey !== process.env.ADMIN_DASHBOARD_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

function getClientIp(req) {
  return req.ip || (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || null;
}

function jsonFromGeminiText(text) {
  if (!text) return null;
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)); } catch {}
  }
  return null;
}

function sanitizeDriverResult(result) {
  if (!result || typeof result !== "object") {
    return { status: "unknown", latest: null, download_url: null, note: "No structured Gemini result returned." };
  }
  const status = ["outdated","up-to-date","unknown"].includes(result.status) ? result.status : "unknown";
  const latest = typeof result.latest === "string" && result.latest.trim() ? result.latest.trim() : null;
  let downloadUrl = typeof result.download_url === "string" && result.download_url.trim() ? result.download_url.trim() : null;
  const note = typeof result.note === "string" && result.note.trim() ? result.note.trim() : null;
  if (downloadUrl) {
    const lower = downloadUrl.toLowerCase();
    const bad =
      lower.includes("nvidia.com/download/index.aspx") ||
      lower.includes("nvidia.com/download/find.aspx") ||
      lower.includes("nvidia.com/en-us/drivers/") ||
      lower.includes("nvidia.com/en-eu/drivers/") ||
      lower.includes("/drivers/results/") ||
      lower.includes("amd.com/en/support") ||
      (lower.includes("amd.com") && !lower.endsWith(".exe") && !lower.includes("download"));
    if (bad) downloadUrl = null;
  }
  return { status, latest, download_url: downloadUrl, note };
}

function getMaintenanceFlags(licenseRow) {
  return {
    recommended_maintenance: Boolean(licenseRow.recommended_maintenance ?? false),
    recommended_maintenance_message: licenseRow.recommended_maintenance_message || "Recommended maintenance available from Voltech."
  };
}

function isLicenseExpired(licenseRow) {
  return Boolean(licenseRow.expires_at && new Date(licenseRow.expires_at) < new Date());
}

function isPaymentSatisfied(licenseRow) {
  return licenseRow.is_legacy === true || licenseRow.payment_required === false || licenseRow.payment_status === "paid";
}

function generateOrderRef() {
  return `ORD-${Date.now()}-${Math.random().toString(36).slice(2,8).toUpperCase()}`;
}

function generateSubRef() {
  return `SUB-${Date.now()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
}

function addDaysIso(baseDateLike, daysToAdd) {
  const base = baseDateLike && new Date(baseDateLike) > new Date() ? new Date(baseDateLike) : new Date();
  base.setDate(base.getDate() + daysToAdd);
  return base.toISOString();
}

// ─── GEMINI DRIVER LOOKUP (NVIDIA + AMD) ─────────────────────────────────────
async function lookupDriverWithGemini({ gpu_name, gpu_driver_version, gpu_is_laptop, gpu_brand }) {
  if (!process.env.GEMINI_API_KEY) return null;

  const isAmd = gpu_brand === "AMD" || gpu_name.toLowerCase().includes("amd") || gpu_name.toLowerCase().includes("radeon");

  const prompt = isAmd ? `
You are checking AMD Radeon driver availability and MUST return a DIRECT DOWNLOAD LINK to the actual driver installer when possible.
Use Google Search and return only valid JSON.
Target GPU: ${gpu_name}
Installed Driver Version: ${gpu_driver_version}
Platform: ${gpu_is_laptop ? "Laptop / Notebook" : "Desktop"}
Your task:
1. Determine whether a newer AMD Radeon Software / Adrenalin driver exists for this exact GPU and platform.
2. Find the newest correct AMD driver version.
3. Return a DIRECT download URL to the actual installer file if possible.
Very important URL rules:
- Prefer a direct AMD installer link ending in .exe.
- DO NOT return generic AMD support pages.
- DO NOT return: https://www.amd.com/en/support or any generic support landing pages.
- If you cannot find a direct installer URL, return an empty string for download_url.
Decision rules:
- If installed driver is older than newest, set status to "outdated".
- If installed driver matches newest, set status to "up-to-date".
- If uncertain, set status to "unknown".
Return only this JSON:
{"status":"outdated" or "up-to-date" or "unknown","latest":"xx.xx.x","download_url":"https://...","note":"short explanation"}
`.trim() : `
You are checking NVIDIA driver availability and MUST return a DIRECT DOWNLOAD LINK to the actual driver installer when possible.
Use Google Search and return only valid JSON.
Target GPU: ${gpu_name}
Installed Driver Version: ${gpu_driver_version}
Platform: ${gpu_is_laptop ? "Laptop / Notebook" : "Desktop"}
Your task:
1. Determine whether a newer NVIDIA WHQL driver exists for this exact GPU and platform.
2. Find the newest correct NVIDIA driver version.
3. Return a DIRECT download URL to the actual installer file if possible.
Very important URL rules:
- Prefer a direct NVIDIA installer link ending in .exe.
- Prefer actual downloadable NVIDIA package links, not landing pages.
- DO NOT return generic NVIDIA search pages.
- DO NOT return:
  - https://www.nvidia.com/Download/index.aspx
  - https://www.nvidia.com/en-us/drivers/
  - https://www.nvidia.com/en-eu/drivers/
  - driver results pages unless no direct .exe can be found
- If you cannot confidently find a direct installer URL, return an empty string for download_url.
Decision rules:
- If installed driver is older than the newest correct one, set status to "outdated".
- If installed driver matches the newest correct one, set status to "up-to-date".
- If uncertain, set status to "unknown".
Return only this JSON:
{"status":"outdated" or "up-to-date" or "unknown","latest":"xxx.xx","download_url":"https://...","note":"short explanation"}
`.trim();

  const controller = new AbortController();
  const fetchTimeout = setTimeout(() => controller.abort(), 30000);

  let response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          tools: [{ googleSearch: {} }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.05 }
        })
      }
    );
  } finally {
    clearTimeout(fetchTimeout);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini HTTP ${response.status} // ${text}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
  return sanitizeDriverResult(jsonFromGeminiText(text));
}

// ─── MAMO HELPERS ────────────────────────────────────────────────────────────
async function fetchMamoSubscriptionPayments(providerSubscriptionId, email = null) {
  if (!process.env.MAMO_API_KEY) throw new Error("Missing MAMO_API_KEY");
  let url = `${MAMO_BASE}/subscriptions/${providerSubscriptionId}/payments`;
  if (email) url += `?email=${encodeURIComponent(email)}`;
  const res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${process.env.MAMO_API_KEY}`, "Content-Type": "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Mamo subscription payments ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { throw new Error(`Mamo non-JSON: ${text}`); }
}

function resolveSubscriptionStatus(paymentsData, email = null) {
  const list = Array.isArray(paymentsData) ? paymentsData : paymentsData?.results || paymentsData?.payments || paymentsData?.data || [];
  const relevant = email ? list.filter(p => (p.email || p.customer_email || "").toLowerCase() === email.toLowerCase()) : list;
  if (!relevant.length) return { subStatus: "incomplete", licenseStatus: "inactive", paymentStatus: "pending", latestPayment: null };
  function parseMamoDate(d) {
    if (!d) return 0;
    const parts = String(d).split("-");
    if (parts.length === 6) return new Date(`${parts[0]}-${parts[1]}-${parts[2]}T${parts[3]}:${parts[4]}:${parts[5]}`).getTime();
    return new Date(d).getTime() || 0;
  }
  const sorted = [...relevant].sort((a, b) => parseMamoDate(b.created_date || b.created_at) - parseMamoDate(a.created_date || a.created_at));
  const latest = sorted[0];
  const rawStatus = String(latest.status || "unknown").toLowerCase();
  if (["captured","paid","success","completed","settled"].includes(rawStatus)) return { subStatus: "active", licenseStatus: "active", paymentStatus: "paid", latestPayment: latest };
  if (["failed","declined","cancelled","canceled","refunded","expired","reversed"].includes(rawStatus)) return { subStatus: "past_due", licenseStatus: "inactive", paymentStatus: "failed", latestPayment: latest };
  return { subStatus: "pending", licenseStatus: null, paymentStatus: null, latestPayment: latest };
}

async function runSubscriptionSync() {
  const { data: subs, error: subsError } = await supabase.from("payment_subscriptions").select("*").in("status", ["pending","active","past_due","incomplete"]);
  if (subsError) throw subsError;
  const results = [];
  for (const sub of subs || []) {
    try {
      if (!sub.provider_subscription_id) { results.push({ ref: sub.subscription_ref, ok: false, reason: "missing_provider_subscription_id" }); continue; }
      const paymentsData = await fetchMamoSubscriptionPayments(sub.provider_subscription_id, null);
      const { subStatus, licenseStatus, paymentStatus, latestPayment } = resolveSubscriptionStatus(paymentsData, null);
      const nowIso = new Date().toISOString();
      await supabase.from("payment_subscriptions").update({ status: subStatus, latest_payment_status: latestPayment ? String(latestPayment.status || "unknown").toLowerCase() : sub.latest_payment_status, latest_payment_at: latestPayment?.created_at || sub.latest_payment_at, last_checked_at: nowIso, metadata: { ...(sub.metadata || {}), last_mamo_sync: paymentsData }, updated_at: nowIso }).eq("id", sub.id);
      if (sub.linked_license_id && licenseStatus && paymentStatus) {
        const { data: linkedLicense } = await supabase.from("licenses").select("id, is_legacy, plan, expires_at").eq("id", sub.linked_license_id).single();
        if (linkedLicense && linkedLicense.is_legacy !== true) {
          const licenseUpdate = { payment_status: paymentStatus, status: licenseStatus, updated_at: nowIso };
          if (licenseStatus === "active" && paymentStatus === "paid") {
            const plan = sub.plan_code || linkedLicense.plan;
            const days = plan === "monthly" ? 30 : plan === "6months" ? 180 : plan === "yearly" ? 365 : 0;
            if (days > 0) { const cur = linkedLicense.expires_at ? new Date(linkedLicense.expires_at) : null; if (!cur || cur < new Date()) licenseUpdate.expires_at = addDaysIso(null, days); }
          }
          await supabase.from("licenses").update(licenseUpdate).eq("id", sub.linked_license_id);
        }
      }
      results.push({ ref: sub.subscription_ref, ok: true, provider_subscription_id: sub.provider_subscription_id, sub_status: subStatus, license_status: licenseStatus, payment_status: paymentStatus, latest_payment_raw: latestPayment?.status || null });
    } catch (innerErr) {
      console.error(`[sync] Error on sub ${sub.subscription_ref}:`, innerErr.message);
      results.push({ ref: sub.subscription_ref, ok: false, reason: String(innerErr.message || innerErr) });
    }
  }
  return results;
}

const SYNC_INTERVAL_MS = 20 * 60 * 1000;
function startSyncCron() {
  console.log(`[cron] Subscription sync scheduled every ${SYNC_INTERVAL_MS / 60000} minutes`);
  setInterval(async () => {
    console.log(`[cron] Running subscription sync at ${new Date().toISOString()}`);
    try {
      const results = await runSubscriptionSync();
      console.log(`[cron] Sync complete — ${results.filter(r=>r.ok).length} ok, ${results.filter(r=>!r.ok).length} failed`);
    } catch (err) { console.error("[cron] Sync error:", err.message); }
  }, SYNC_INTERVAL_MS);
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────
app.get("/debug-mamo-payments/:subscriptionId", requireAdmin, async (req, res) => {
  try { return res.json(await fetchMamoSubscriptionPayments(req.params.subscriptionId, null)); }
  catch (err) { return res.status(500).json({ error: err.message }); }
});
app.get("/", (_req, res) => res.json({ ok: true, service: "voltechshield-api", status: "online" }));
app.get("/health", (_req, res) => res.json({ ok: true, service: "voltechshield-api", uptime: process.uptime(), timestamp: new Date().toISOString() }));
app.get("/version", (_req, res) => res.json({ version: "2.0.1", notes: "تعال واكتشف التطبيب الجديد", url: "https://github.com/VoltechFPS-Code/voltechshield-api/releases/download/v2.0.1/VoltechShield_2.0.1_x64-setup.exe" }));

// ─── ANNOUNCEMENT ────────────────────────────────────────────────────────────
const ANNOUNCEMENT_KEY = "announcement";
const ANNOUNCEMENT_FALLBACK = { active: true, message: "" };
async function getAnnouncement() {
  try {
    const { data, error } = await supabase.from("app_config").select("value").eq("key", ANNOUNCEMENT_KEY).single();
    if (error || !data) return ANNOUNCEMENT_FALLBACK;
    return { active: Boolean(data.value.active), message: String(data.value.message || "") };
  } catch { return ANNOUNCEMENT_FALLBACK; }
}
async function setAnnouncement(active, message) {
  const value = { active: Boolean(active), message: typeof message === "string" ? message.trim() : "" };
  await supabase.from("app_config").upsert({ key: ANNOUNCEMENT_KEY, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  return value;
}
app.get("/announcement", async (_req, res) => { const ann = await getAnnouncement(); return res.json({ active: ann.active, message: ann.active ? ann.message : "" }); });
app.post("/admin/announcement", requireAdmin, async (req, res) => {
  try {
    const ann = await setAnnouncement(req.body.active, req.body.message);
    console.log(`Announcement updated: active=${ann.active} message="${ann.message}"`);
    return res.json({ success: true, active: ann.active, message: ann.message });
  } catch (err) { console.error("Announcement update error:", err); return res.status(500).json({ error: "announcement_update_failed" }); }
});

// ─── ACTIVATE ────────────────────────────────────────────────────────────────
app.post("/activate", async (req, res) => {
  try {
    const { license, hwid, app_version } = req.body;
    const last_ip = getClientIp(req);
    if (!license || !hwid) return res.json({ valid: false, reason: "missing_fields" });
    const { data: licenseRow, error: licenseError } = await supabase.from("licenses").select("*").eq("license_key", license).single();
    if (licenseError || !licenseRow) {
      await supabase.from("activations").insert({ license_key: license, hwid, result: "license_not_found", app_version: app_version || null, ip: last_ip });
      return res.json({ valid: false, reason: "license_not_found" });
    }
    const maintenanceFlags = getMaintenanceFlags(licenseRow);
    if (licenseRow.status !== "active") {
      await supabase.from("activations").insert({ license_key: license, hwid, result: "inactive", app_version: app_version || null, ip: last_ip });
      return res.json({ valid: false, reason: "inactive", ...maintenanceFlags });
    }
    if (isLicenseExpired(licenseRow)) {
      await supabase.from("activations").insert({ license_key: license, hwid, result: "expired", app_version: app_version || null, ip: last_ip });
      return res.json({ valid: false, reason: "expired", ...maintenanceFlags });
    }
    if (!isPaymentSatisfied(licenseRow)) {
      await supabase.from("activations").insert({ license_key: license, hwid, result: "payment_required", app_version: app_version || null, ip: last_ip });
      return res.json({ valid: false, reason: "payment_required", ...maintenanceFlags });
    }
    if (!licenseRow.hwid) {
      const { error: bindError } = await supabase.from("licenses").update({ hwid, last_ip, last_validated_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("license_key", license);
      if (bindError) {
        await supabase.from("activations").insert({ license_key: license, hwid, result: "bind_failed", app_version: app_version || null, ip: last_ip });
        return res.json({ valid: false, reason: "bind_failed", ...maintenanceFlags });
      }
      await supabase.from("activations").insert({ license_key: license, hwid, result: "first_activation_success", app_version: app_version || null, ip: last_ip });
      return res.json({ valid: true, reason: "first_activation_success", ...maintenanceFlags });
    }
    if (licenseRow.hwid !== hwid) {
      await supabase.from("activations").insert({ license_key: license, hwid, result: "hwid_mismatch", app_version: app_version || null, ip: last_ip });
      return res.json({ valid: false, reason: "hwid_mismatch", ...maintenanceFlags });
    }
    await supabase.from("licenses").update({ last_ip, last_validated_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("license_key", license);
    await supabase.from("activations").insert({ license_key: license, hwid, result: "validation_success", app_version: app_version || null, ip: last_ip });
    return res.json({ valid: true, reason: "validation_success", ...maintenanceFlags });
  } catch (err) { console.error("Activation route error:", err); return res.status(500).json({ valid: false, reason: "server_error" }); }
});

// ─── REPORT GPU ──────────────────────────────────────────────────────────────
app.post("/report-gpu", async (req, res) => {
  try {
    const { license, hwid, app_version, gpu_name, gpu_driver_version, gpu_raw_driver_version, gpu_is_laptop, gpu_brand, cpu_brand, reported_at } = req.body;
    if (!license || !hwid || !gpu_name || !gpu_driver_version) return res.status(400).json({ ok: false, reason: "missing_fields" });
    const { data: licenseRow, error: licenseError } = await supabase.from("licenses").select("*").eq("license_key", license).single();
    if (licenseError || !licenseRow) return res.status(404).json({ ok: false, reason: "license_not_found" });
    if (licenseRow.hwid && licenseRow.hwid !== hwid) return res.status(403).json({ ok: false, reason: "hwid_mismatch" });
    await supabase.from("licenses").update({ gpu_name, gpu_driver_version, gpu_raw_driver_version: gpu_raw_driver_version || null, gpu_is_laptop: Boolean(gpu_is_laptop), gpu_brand: gpu_brand || null, cpu_brand: cpu_brand || null, last_gpu_reported_at: reported_at || new Date().toISOString(), updated_at: new Date().toISOString() }).eq("license_key", license);
    let suggested = null;
    try {
      const isNvidia = gpu_brand === "NVIDIA" || gpu_name.toLowerCase().includes("nvidia");
      const isAmd    = gpu_brand === "AMD"    || gpu_name.toLowerCase().includes("amd") || gpu_name.toLowerCase().includes("radeon");
      if (isNvidia || isAmd) {
        suggested = await lookupDriverWithGemini({ gpu_name, gpu_driver_version, gpu_is_laptop: Boolean(gpu_is_laptop), gpu_brand: gpu_brand || (isAmd ? "AMD" : "NVIDIA") });
        console.log("Gemini suggested result:", suggested);
      }
    } catch (geminiError) { console.error("Gemini lookup error:", geminiError); }
    if (suggested) {
      await supabase.from("licenses").update({ suggested_driver_status: finalStatus || null, suggested_driver_latest: suggested.latest || null, suggested_driver_download_url: suggested.download_url || null, suggested_driver_checked_at: new Date().toISOString(), driver_note: licenseRow.driver_note || suggested.note || null, updated_at: new Date().toISOString() }).eq("license_key", license);
    }
    // Sanity-check Gemini's status against a direct version comparison.
    // Gemini sometimes returns "outdated" in the status field while its own
    // note and latest field confirm the driver is current — contradictory.
    // If installed version matches Gemini's latest, force "up-to-date".
    let finalStatus = suggested?.status || licenseRow.suggested_driver_status || null;
    if (finalStatus === "outdated" && suggested?.latest) {
      const normalize = (v) => String(v || "").trim().replace(/\s+/g, "").toLowerCase();
      if (normalize(gpu_driver_version) === normalize(suggested.latest)) {
        finalStatus = "up-to-date";
        console.log(`[driver] Overriding Gemini status: installed ${gpu_driver_version} === latest ${suggested.latest} -> up-to-date`);
      }
    }

    const refreshed = {
      ...licenseRow,
      suggested_driver_status: finalStatus,
      suggested_driver_latest: suggested?.latest || licenseRow.suggested_driver_latest || null,
      suggested_driver_download_url: suggested?.download_url || licenseRow.suggested_driver_download_url || null,
      driver_note: licenseRow.driver_note || suggested?.note || null
    };
    const preferredUrl = refreshed.approved_driver_download_url || refreshed.suggested_driver_download_url || null;
    const preferredLatest = refreshed.approved_driver_latest || refreshed.suggested_driver_latest || null;
    const effectiveStatus = refreshed.suggested_driver_status || "unknown";
    const driverUpdateAvailable = Boolean(preferredUrl) && effectiveStatus === "outdated";
    return res.json({ ok: true, gpu_name, gpu_driver_version, driver_update_available: driverUpdateAvailable, driver_download_url: preferredUrl, driver_note: refreshed.driver_note || null, driver_latest_version: preferredLatest, driver_status: refreshed.suggested_driver_status || "unknown" });
  } catch (err) { console.error("Report GPU route error:", err); return res.status(500).json({ ok: false, reason: "server_error" }); }
});

// ─── ADMIN ROUTES ────────────────────────────────────────────────────────────
app.get("/admin/analytics/summary", requireAdmin, async (_req, res) => {
  try {
    const [{ count: tl }, { count: al }, { count: ta }, { count: rs }, { count: as_ }] = await Promise.all([
      supabase.from("licenses").select("*", { count: "exact", head: true }),
      supabase.from("licenses").select("*", { count: "exact", head: true }).eq("status", "active"),
      supabase.from("activations").select("*", { count: "exact", head: true }),
      supabase.from("activations").select("*", { count: "exact", head: true }).eq("result", "validation_success"),
      supabase.from("payment_subscriptions").select("*", { count: "exact", head: true }).eq("status", "active"),
    ]);
    return res.json({ totalLicenses: tl||0, activeLicenses: al||0, totalActivations: ta||0, recentSuccesses: rs||0, activeSubscriptions: as_||0 });
  } catch (err) { return res.status(500).json({ error: "summary_failed" }); }
});

app.get("/admin/activations/recent", requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabase.from("activations").select("*").order("created_at", { ascending: false }).limit(25);
    if (error) throw error;
    return res.json(data);
  } catch (err) { return res.status(500).json({ error: "recent_activations_failed" }); }
});

app.get("/admin/licenses/search", requireAdmin, async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    if (!q) return res.json([]);
    const { data, error } = await supabase.from("licenses").select("*").or(`license_key.ilike.%${q}%,hwid.ilike.%${q}%,email.ilike.%${q}%,discord.ilike.%${q}%`).order("created_at", { ascending: false }).limit(25);
    if (error) throw error;
    return res.json(data);
  } catch (err) { return res.status(500).json({ error: "search_failed" }); }
});

app.post("/admin/licenses/reset-hwid", requireAdmin, async (req, res) => {
  try {
    const { license_key } = req.body;
    if (!license_key) return res.status(400).json({ error: "missing_license_key" });
    const { error } = await supabase.from("licenses").update({ hwid: null, gpu_name: null, gpu_driver_version: null, gpu_raw_driver_version: null, gpu_is_laptop: null, gpu_brand: null, cpu_brand: null, last_gpu_reported_at: null, suggested_driver_status: null, suggested_driver_latest: null, suggested_driver_download_url: null, suggested_driver_checked_at: null, approved_driver_latest: null, approved_driver_download_url: null, driver_note: null, updated_at: new Date().toISOString() }).eq("license_key", license_key);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: "reset_hwid_failed" }); }
});

app.post("/admin/licenses/set-maintenance", requireAdmin, async (req, res) => {
  try {
    const { license_key, recommended_maintenance, recommended_maintenance_message } = req.body;
    if (!license_key) return res.status(400).json({ error: "missing_license_key" });
    const payload = { recommended_maintenance: Boolean(recommended_maintenance), recommended_maintenance_message: typeof recommended_maintenance_message === "string" && recommended_maintenance_message.trim() ? recommended_maintenance_message.trim() : null, updated_at: new Date().toISOString() };
    const { error } = await supabase.from("licenses").update(payload).eq("license_key", license_key);
    if (error) throw error;
    return res.json({ success: true, ...payload });
  } catch (err) { return res.status(500).json({ error: "set_maintenance_failed" }); }
});

app.post("/admin/licenses/clear-maintenance", requireAdmin, async (req, res) => {
  try {
    const { license_key } = req.body;
    if (!license_key) return res.status(400).json({ error: "missing_license_key" });
    const { error } = await supabase.from("licenses").update({ recommended_maintenance: false, recommended_maintenance_message: null, updated_at: new Date().toISOString() }).eq("license_key", license_key);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: "clear_maintenance_failed" }); }
});

app.post("/admin/licenses/revoke", requireAdmin, async (req, res) => {
  try {
    const { license_key } = req.body;
    if (!license_key) return res.status(400).json({ error: "missing_license_key" });
    const { error } = await supabase.from("licenses").update({ status: "inactive", updated_at: new Date().toISOString() }).eq("license_key", license_key);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: "revoke_failed" }); }
});

app.post("/admin/licenses/set-discord", requireAdmin, async (req, res) => {
  try {
    const { license_key, discord } = req.body;
    if (!license_key) return res.status(400).json({ error: "missing_license_key" });
    const { error } = await supabase.from("licenses").update({ discord: typeof discord === "string" && discord.trim() ? discord.trim() : null, updated_at: new Date().toISOString() }).eq("license_key", license_key);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: "set_discord_failed" }); }
});

app.post("/admin/licenses/create", requireAdmin, async (req, res) => {
  try {
    const { license_key, email, discord, plan, status, expires_at, issued_by } = req.body;
    if (!license_key || !email) return res.status(400).json({ error: "missing_fields" });
    const nowIso = new Date().toISOString();
    const { error } = await supabase.from("licenses").upsert({ license_key, hwid: null, email, discord: typeof discord === "string" && discord.trim() ? discord.trim() : null, plan: plan || "monthly", status: status || "active", expires_at: expires_at || null, created_manually: true, issued_by: typeof issued_by === "string" && issued_by.trim() ? issued_by.trim() : "technician", payment_required: false, payment_status: "waived", is_legacy: true, created_at: nowIso, updated_at: nowIso }, { onConflict: "license_key", ignoreDuplicates: true });
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: "create_license_failed" }); }
});

app.post("/admin/licenses/create-paid", requireAdmin, async (req, res) => {
  try {
    const { license_key, email, discord, plan, expires_at } = req.body;
    if (!license_key || !email) return res.status(400).json({ error: "missing_fields" });
    const nowIso = new Date().toISOString();
    const { error } = await supabase.from("licenses").upsert({ license_key, hwid: null, email, discord: typeof discord === "string" && discord.trim() ? discord.trim() : null, plan: plan || "monthly", status: "inactive", expires_at: expires_at || null, created_manually: false, issued_by: "payment_system", payment_required: true, payment_status: "pending", is_legacy: false, created_at: nowIso, updated_at: nowIso }, { onConflict: "license_key", ignoreDuplicates: true });
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: "create_paid_license_failed" }); }
});

// ─── SUBSCRIPTIONS ───────────────────────────────────────────────────────────
app.post("/admin/subscriptions/create", requireAdmin, async (req, res) => {
  try {
    const { license_key, provider_subscription_id, email, discord, customer_name, phone, plan_code } = req.body;
    if (!license_key || !provider_subscription_id || !email) return res.status(400).json({ error: "missing_fields" });
    const { data: licenseRow, error: licenseError } = await supabase.from("licenses").select("id, license_key, is_legacy, plan").eq("license_key", license_key).single();
    if (licenseError || !licenseRow) return res.status(404).json({ error: "license_not_found" });
    if (licenseRow.is_legacy === true) return res.status(400).json({ error: "license_is_legacy" });
    const nowIso = new Date().toISOString();
    const subscriptionRef = generateSubRef();
    const { error: insertError } = await supabase.from("payment_subscriptions").insert({ subscription_ref: subscriptionRef, provider: "mamopay", provider_subscription_id, linked_license_id: licenseRow.id, customer_name: customer_name || null, email, discord: typeof discord === "string" && discord.trim() ? discord.trim() : null, phone: phone || null, plan_code: plan_code || licenseRow.plan || "monthly", status: "pending", created_at: nowIso, updated_at: nowIso });
    if (insertError) throw insertError;
    await supabase.from("licenses").update({ linked_subscription_ref: subscriptionRef, payment_required: true, payment_status: "pending", updated_at: nowIso }).eq("license_key", license_key);
    let syncResult = null;
    try {
      const paymentsData = await fetchMamoSubscriptionPayments(provider_subscription_id, null);
      const resolved = resolveSubscriptionStatus(paymentsData, null);
      syncResult = resolved;
      await supabase.from("payment_subscriptions").update({ status: resolved.subStatus, latest_payment_status: resolved.latestPayment ? String(resolved.latestPayment.status || "unknown").toLowerCase() : null, latest_payment_at: resolved.latestPayment?.created_at || null, last_checked_at: nowIso, updated_at: nowIso }).eq("subscription_ref", subscriptionRef);
      if (resolved.licenseStatus && resolved.paymentStatus) await supabase.from("licenses").update({ status: resolved.licenseStatus, payment_status: resolved.paymentStatus, updated_at: nowIso }).eq("license_key", license_key);
    } catch (syncErr) { console.error("[create-subscription] Immediate sync failed:", syncErr.message); }
    return res.json({ success: true, subscription_ref: subscriptionRef, license_key, linked_license_id: licenseRow.id, immediate_sync: syncResult ? { sub_status: syncResult.subStatus, license_status: syncResult.licenseStatus, payment_status: syncResult.paymentStatus } : null });
  } catch (err) { return res.status(500).json({ error: "create_subscription_failed", details: String(err.message || err) }); }
});

app.get("/admin/subscriptions/list", requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabase.from("payment_subscriptions").select("*, licenses(license_key, email, status, payment_status)").order("created_at", { ascending: false }).limit(50);
    if (error) throw error;
    return res.json(data);
  } catch (err) { return res.status(500).json({ error: "list_subscriptions_failed" }); }
});

app.post("/admin/subscriptions/sync", requireAdmin, async (_req, res) => {
  try {
    const results = await runSubscriptionSync();
    return res.json({ success: true, checked: results.length, ok: results.filter(r=>r.ok).length, failed: results.filter(r=>!r.ok).length, results });
  } catch (err) { return res.status(500).json({ error: "sync_failed" }); }
});

app.delete("/admin/subscriptions/:subscription_ref", requireAdmin, async (req, res) => {
  try {
    const { subscription_ref } = req.params;
    const { data: sub, error: fetchError } = await supabase.from("payment_subscriptions").select("id, linked_license_id").eq("subscription_ref", subscription_ref).single();
    if (fetchError || !sub) return res.status(404).json({ error: "subscription_not_found" });
    const nowIso = new Date().toISOString();
    await supabase.from("payment_subscriptions").update({ status: "cancelled", cancelled_at: nowIso, updated_at: nowIso }).eq("subscription_ref", subscription_ref);
    if (sub.linked_license_id) await supabase.from("licenses").update({ status: "inactive", payment_status: "failed", updated_at: nowIso }).eq("id", sub.linked_license_id);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: "cancel_subscription_failed" }); }
});

// ─── MAMO PAYMENT ORDERS ─────────────────────────────────────────────────────
app.post("/admin/payments/create-mamo-order", requireAdmin, async (req, res) => {
  try {
    const { license_key, email, discord, customer_name, phone, plan_code, amount, currency, expires_at } = req.body;
    if (!license_key || !email || !plan_code || !amount) return res.status(400).json({ error: "missing_fields" });
    const nowIso = new Date().toISOString();
    const { data: insertedLicense, error: licenseError } = await supabase.from("licenses").insert({ license_key, hwid: null, email, discord: typeof discord === "string" && discord.trim() ? discord.trim() : null, plan: plan_code, status: "inactive", expires_at: expires_at || null, created_manually: false, issued_by: "payment_system", payment_required: true, payment_status: "pending", is_legacy: false, created_at: nowIso, updated_at: nowIso }).select("id, license_key").single();
    if (licenseError) throw licenseError;
    const orderRef = generateOrderRef();
    const { data: insertedOrder, error: orderError } = await supabase.from("payment_orders").insert({ order_ref: orderRef, customer_name: customer_name || null, email, discord: typeof discord === "string" && discord.trim() ? discord.trim() : null, phone: phone || null, provider: "mamopay", plan_code, amount, currency: currency || "AED", status: "pending", linked_license_id: insertedLicense.id, auto_create_license: false, metadata: { license_key, source: "admin_create_mamo_order" }, created_at: nowIso, updated_at: nowIso }).select("*").single();
    if (orderError) throw orderError;
    const mamoResult = await createMamoPaymentLink({ amount, currency: currency || "AED", description: `VoltechShield ${plan_code} license ${license_key}`, customer_name: customer_name || "", customer_email: email, order_ref: orderRef });
    const providerOrderId = mamoResult.id || mamoResult.link_id || mamoResult.payment_link_id || mamoResult.external_id || null;
    const checkoutUrl = mamoResult.checkout_url || mamoResult.url || mamoResult.payment_url || null;
    await supabase.from("payment_orders").update({ provider_order_id: providerOrderId, provider_payment_id: mamoResult.payment_id || mamoResult.charge_id || null, provider_checkout_url: checkoutUrl, payment_link: checkoutUrl, updated_at: new Date().toISOString() }).eq("id", insertedOrder.id);
    return res.json({ success: true, order_ref: orderRef, license_key, linked_license_id: insertedLicense.id, provider_order_id: providerOrderId, checkout_url: checkoutUrl, raw: mamoResult });
  } catch (err) { return res.status(500).json({ error: "create_mamo_order_failed", details: String(err.message || err) }); }
});

app.post("/admin/payments/sync-mamo", requireAdmin, async (_req, res) => {
  try {
    const { data: pendingOrders, error } = await supabase.from("payment_orders").select("*").eq("provider", "mamopay").in("status", ["draft","pending"]);
    if (error) throw error;
    const results = [];
    for (const order of pendingOrders || []) {
      try {
        if (!order.provider_order_id) { results.push({ order_ref: order.order_ref, ok: false, reason: "missing_provider_order_id" }); continue; }
        const mamoStatus = await fetchMamoPaymentStatus(order.provider_order_id);
        const rawStatus = String(mamoStatus.status || mamoStatus.payment_status || mamoStatus.state || "unknown").toLowerCase();
        let nextOrder = order.status, nextLicense = null, nextPayment = null, paidAt = null;
        if (["paid","captured","success","completed"].includes(rawStatus)) { nextOrder="paid"; nextLicense="active"; nextPayment="paid"; paidAt=new Date().toISOString(); }
        else if (rawStatus==="failed") { nextOrder="failed"; nextLicense="inactive"; nextPayment="failed"; }
        else if (rawStatus==="refunded") { nextOrder="refunded"; nextLicense="inactive"; nextPayment="refunded"; }
        else if (["cancelled","canceled"].includes(rawStatus)) { nextOrder="cancelled"; nextLicense="inactive"; nextPayment="unpaid"; }
        else if (rawStatus==="expired") { nextOrder="expired"; nextLicense="inactive"; nextPayment="unpaid"; }
        const providerPaymentId = mamoStatus.payment_id || mamoStatus.charge_id || order.provider_payment_id || null;
        const providerCheckoutUrl = mamoStatus.checkout_url || mamoStatus.url || order.provider_checkout_url || null;
        await supabase.from("payment_orders").update({ status: nextOrder, provider_payment_id: providerPaymentId, provider_checkout_url: providerCheckoutUrl, payment_link: providerCheckoutUrl, paid_at: paidAt||order.paid_at, last_checked_at: new Date().toISOString(), metadata: { ...(order.metadata||{}), last_mamo_sync: mamoStatus }, updated_at: new Date().toISOString() }).eq("id", order.id);
        if (order.linked_license_id && nextLicense && nextPayment) {
          const { data: ll } = await supabase.from("licenses").select("id, is_legacy, plan, expires_at").eq("id", order.linked_license_id).single();
          const lu = { payment_status: nextPayment, updated_at: new Date().toISOString() };
          if (ll?.is_legacy !== true) lu.status = nextLicense;
          if (nextPayment === "paid") {
            let exp = ll?.expires_at;
            if (order.plan_code==="monthly") exp=addDaysIso(exp,30); else if (order.plan_code==="6months") exp=addDaysIso(exp,180); else if (order.plan_code==="yearly") exp=addDaysIso(exp,365); else if (order.plan_code==="lifetime") exp=null;
            lu.expires_at=exp; lu.last_activated_at=new Date().toISOString(); lu.source_order_id_text=order.provider_order_id||null; lu.source_payment_id_text=providerPaymentId||null;
          }
          await supabase.from("licenses").update(lu).eq("id", order.linked_license_id);
        }
        results.push({ order_ref: order.order_ref, ok: true, raw_status: rawStatus, final_order_status: nextOrder, final_payment_status: nextPayment });
      } catch (innerErr) { results.push({ order_ref: order.order_ref, ok: false, reason: String(innerErr.message||innerErr) }); }
    }
    return res.json({ success: true, checked: results.length, results });
  } catch (err) { return res.status(500).json({ error: "sync_mamo_failed" }); }
});

async function createMamoPaymentLink({ amount, currency, description, customer_name, customer_email, order_ref }) {
  if (!process.env.MAMO_API_KEY || !process.env.MAMO_API_BASE_URL) throw new Error("Missing MAMO env vars");
  const response = await fetch(`${process.env.MAMO_API_BASE_URL}/links`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.MAMO_API_KEY}` }, body: JSON.stringify({ title: description, description, amount, currency, external_id: order_ref, customer: { name: customer_name||"", email: customer_email||"" } }) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Mamo create link failed: ${response.status} // ${text}`);
  try { return JSON.parse(text); } catch { throw new Error(`Mamo create link non-JSON: ${text}`); }
}

async function fetchMamoPaymentStatus(providerOrderId) {
  if (!process.env.MAMO_API_KEY || !process.env.MAMO_API_BASE_URL) throw new Error("Missing MAMO env vars");
  const response = await fetch(`${process.env.MAMO_API_BASE_URL}/links/${providerOrderId}`, { method: "GET", headers: { Authorization: `Bearer ${process.env.MAMO_API_KEY}` } });
  const text = await response.text();
  if (!response.ok) throw new Error(`Mamo fetch status failed: ${response.status} // ${text}`);
  try { return JSON.parse(text); } catch { throw new Error(`Mamo status non-JSON: ${text}`); }
}

// ─── START ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Voltech Shield license server running on port ${PORT}`);
  startSyncCron();
});
