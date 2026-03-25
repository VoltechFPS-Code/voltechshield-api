require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(cors());
app.use(express.json());

const REQUIRED_ENV_VARS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ADMIN_DASHBOARD_KEY"
];

const missingEnvVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);

if (missingEnvVars.length > 0) {
  console.error(
    `Missing required environment variables: ${missingEnvVars.join(", ")}`
  );
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── MAMO BASE URL ────────────────────────────────────────────────────────────
// Reads MAMO_API_BASE_URL from env (already set on Render).
// Falls back to live production URL if not set.
const MAMO_BASE =
  (process.env.MAMO_API_BASE_URL || "https://business.mamopay.com/manage_api/v1").replace(/\/$/, "");


// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const incomingKey = req.headers["x-admin-key"];
  if (incomingKey !== process.env.ADMIN_DASHBOARD_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function jsonFromGeminiText(text) {
  if (!text) return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const slice = trimmed.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(slice);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function sanitizeDriverResult(result) {
  if (!result || typeof result !== "object") {
    return {
      status: "unknown",
      latest: null,
      download_url: null,
      note: "No structured Gemini result returned."
    };
  }

  const status =
    result.status === "outdated" ||
    result.status === "up-to-date" ||
    result.status === "unknown"
      ? result.status
      : "unknown";

  const latest =
    typeof result.latest === "string" && result.latest.trim()
      ? result.latest.trim()
      : null;

  let downloadUrl =
    typeof result.download_url === "string" && result.download_url.trim()
      ? result.download_url.trim()
      : null;

  const note =
    typeof result.note === "string" && result.note.trim()
      ? result.note.trim()
      : null;

  if (downloadUrl) {
    const lower = downloadUrl.toLowerCase();
    const obviouslyBad =
      lower.includes("nvidia.com/download/index.aspx") ||
      lower.includes("nvidia.com/download/find.aspx") ||
      lower.includes("nvidia.com/en-us/drivers/") ||
      lower.includes("nvidia.com/en-eu/drivers/") ||
      lower.includes("/drivers/results/");
    if (obviouslyBad) downloadUrl = null;
  }

  return { status, latest, download_url: downloadUrl, note };
}

function getMaintenanceFlags(licenseRow) {
  return {
    recommended_maintenance: Boolean(licenseRow.recommended_maintenance ?? false),
    recommended_maintenance_message:
      licenseRow.recommended_maintenance_message ||
      "Recommended maintenance available from Voltech."
  };
}

function isLicenseExpired(licenseRow) {
  return Boolean(
    licenseRow.expires_at && new Date(licenseRow.expires_at) < new Date()
  );
}

function isPaymentSatisfied(licenseRow) {
  return (
    licenseRow.is_legacy === true ||
    licenseRow.payment_required === false ||
    licenseRow.payment_status === "paid"
  );
}

function generateOrderRef() {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `ORD-${Date.now()}-${rand}`;
}

function generateSubRef() {
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `SUB-${Date.now()}-${rand}`;
}

function addDaysIso(baseDateLike, daysToAdd) {
  const base =
    baseDateLike && new Date(baseDateLike) > new Date()
      ? new Date(baseDateLike)
      : new Date();
  base.setDate(base.getDate() + daysToAdd);
  return base.toISOString();
}

// ─── MAMO HELPERS ─────────────────────────────────────────────────────────────

/**
 * Fetch all payments for a Mamo subscription (recurring payment item).
 * Optionally filter by customer email.
 * Endpoint: GET /subscriptions/{subscriptionId}/payments
 */
async function fetchMamoSubscriptionPayments(providerSubscriptionId, email = null) {
  if (!process.env.MAMO_API_KEY) throw new Error("Missing MAMO_API_KEY");

  let url = `${MAMO_BASE}/subscriptions/${providerSubscriptionId}/payments`;
  if (email) url += `?email=${encodeURIComponent(email)}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${process.env.MAMO_API_KEY}`,
      "Content-Type": "application/json"
    }
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Mamo subscription payments ${res.status}: ${text}`);

  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Mamo non-JSON: ${text}`); }
  return data;
}

/**
 * Determine whether a subscription is currently paid based on Mamo payment list.
 * Mamo uses "captured" for successful charges.
 * Logic: find the most recent payment — if it's captured, the sub is active.
 * If the most recent is failed/cancelled and it's past the expected billing date,
 * treat as past_due.
 */
function resolveSubscriptionStatus(paymentsData, email = null) {
  // Mamo returns { results: [...] } or { payments: [...] } or a plain array
  const list = Array.isArray(paymentsData)
    ? paymentsData
    : paymentsData?.results || paymentsData?.payments || paymentsData?.data || [];

  // Filter by email if provided (Mamo recommends this to isolate a single subscriber)
  const relevant = email
    ? list.filter(p => (p.email || p.customer_email || "").toLowerCase() === email.toLowerCase())
    : list;

  if (!relevant.length) {
    return { subStatus: "incomplete", licenseStatus: "inactive", paymentStatus: "pending", latestPayment: null };
  }

  // Mamo uses created_date in format "2026-03-23-00-03-23" (not standard ISO)
  function parseMamoDate(d) {
    if (!d) return 0;
    const parts = String(d).split("-");
    if (parts.length === 6) {
      return new Date(`${parts[0]}-${parts[1]}-${parts[2]}T${parts[3]}:${parts[4]}:${parts[5]}`).getTime();
    }
    return new Date(d).getTime() || 0;
  }

  // Sort descending by created_date (newest first)
  const sorted = [...relevant].sort(
    (a, b) => parseMamoDate(b.created_date || b.created_at) - parseMamoDate(a.created_date || a.created_at)
  );

  const latest = sorted[0];
  const rawStatus = String(latest.status || "unknown").toLowerCase();

  const PAID_STATUSES = ["captured", "paid", "success", "completed", "settled"];
  const FAILED_STATUSES = ["failed", "declined", "cancelled", "canceled", "refunded", "expired", "reversed"];

  if (PAID_STATUSES.includes(rawStatus)) {
    return { subStatus: "active", licenseStatus: "active", paymentStatus: "paid", latestPayment: latest };
  }
  if (FAILED_STATUSES.includes(rawStatus)) {
    return { subStatus: "past_due", licenseStatus: "inactive", paymentStatus: "failed", latestPayment: latest };
  }

  // Pending / unknown — don't change what we have
  return { subStatus: "pending", licenseStatus: null, paymentStatus: null, latestPayment: latest };
}

// ─── CORE SYNC LOGIC (reused by cron and manual route) ───────────────────────

async function runSubscriptionSync() {
  // Only pull subs that are not permanently cancelled/expired
  const { data: subs, error: subsError } = await supabase
    .from("payment_subscriptions")
    .select("*")
    .in("status", ["pending", "active", "past_due", "incomplete"]);

  if (subsError) throw subsError;

  const results = [];

  for (const sub of subs || []) {
    try {
      if (!sub.provider_subscription_id) {
        results.push({ ref: sub.subscription_ref, ok: false, reason: "missing_provider_subscription_id" });
        continue;
      }

      const paymentsData = await fetchMamoSubscriptionPayments(
        sub.provider_subscription_id,
        null
      );

      const { subStatus, licenseStatus, paymentStatus, latestPayment } =
        resolveSubscriptionStatus(paymentsData, null);

      const nowIso = new Date().toISOString();

      // Update payment_subscriptions row
      await supabase
        .from("payment_subscriptions")
        .update({
          status: subStatus,
          latest_payment_status: latestPayment
            ? String(latestPayment.status || "unknown").toLowerCase()
            : sub.latest_payment_status,
          latest_payment_at: latestPayment?.created_at || sub.latest_payment_at,
          last_checked_at: nowIso,
          metadata: {
            ...(sub.metadata || {}),
            last_mamo_sync: paymentsData
          },
          updated_at: nowIso
        })
        .eq("id", sub.id);

      // Update linked license only if we have a definitive new status
      if (sub.linked_license_id && licenseStatus && paymentStatus) {
        const { data: linkedLicense } = await supabase
          .from("licenses")
          .select("id, is_legacy, plan, expires_at")
          .eq("id", sub.linked_license_id)
          .single();

        if (linkedLicense && linkedLicense.is_legacy !== true) {
          const licenseUpdate = {
            payment_status: paymentStatus,
            status: licenseStatus,
            updated_at: nowIso
          };

          // Extend expiry on successful payment if not already future-dated
          if (licenseStatus === "active" && paymentStatus === "paid") {
            const plan = sub.plan_code || linkedLicense.plan;
            const extensionDays =
              plan === "monthly" ? 30 :
              plan === "6months" ? 180 :
              plan === "yearly" ? 365 : 0;

            if (extensionDays > 0) {
              // Only extend if current expiry is in the past or missing
              const currentExpiry = linkedLicense.expires_at
                ? new Date(linkedLicense.expires_at)
                : null;
              const isExpiredOrMissing = !currentExpiry || currentExpiry < new Date();

              if (isExpiredOrMissing) {
                licenseUpdate.expires_at = addDaysIso(null, extensionDays);
              }
            }
          }

          await supabase
            .from("licenses")
            .update(licenseUpdate)
            .eq("id", sub.linked_license_id);
        }
      }

      results.push({
        ref: sub.subscription_ref,
        ok: true,
        provider_subscription_id: sub.provider_subscription_id,
        sub_status: subStatus,
        license_status: licenseStatus,
        payment_status: paymentStatus,
        latest_payment_raw: latestPayment?.status || null
      });
    } catch (innerErr) {
      console.error(`[sync] Error on sub ${sub.subscription_ref}:`, innerErr.message);
      results.push({
        ref: sub.subscription_ref,
        ok: false,
        reason: String(innerErr.message || innerErr)
      });
    }
  }

  return results;
}

// ─── AUTO-SYNC CRON ───────────────────────────────────────────────────────────
// Runs every 20 minutes to match the app's own re-validation interval.
// No external cron library needed — plain setInterval is fine for a long-running
// Node process on Render.

const SYNC_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes

function startSyncCron() {
  console.log(`[cron] Subscription sync scheduled every ${SYNC_INTERVAL_MS / 60000} minutes`);

  setInterval(async () => {
    console.log(`[cron] Running subscription sync at ${new Date().toISOString()}`);
    try {
      const results = await runSubscriptionSync();
      const ok = results.filter(r => r.ok).length;
      const fail = results.filter(r => !r.ok).length;
      console.log(`[cron] Sync complete — ${ok} ok, ${fail} failed`);
    } catch (err) {
      console.error("[cron] Sync error:", err.message);
    }
  }, SYNC_INTERVAL_MS);
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// TEMPORARY DEBUG
app.get("/debug-mamo-payments/:subscriptionId", requireAdmin, async (req, res) => {
  try {
    const data = await fetchMamoSubscriptionPayments(req.params.subscriptionId, null);
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/", (_req, res) => {
  return res.json({ ok: true, service: "voltechshield-api", status: "online" });
});

app.get("/health", (_req, res) => {
  return res.json({
    ok: true,
    service: "voltechshield-api",
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get("/version", (_req, res) => {
  return res.json({
    version: "2.0.1",
    notes:
      "تعال واكتشف التطبيق الجديد",
    url: "https://github.com/VoltechFPS-Code/voltechshield-api/releases/download/v2.0.1/VoltechShield_2.0.1_x64-setup.exe"
  });
});


// ─── ANNOUNCEMENT (Supabase-backed, survives redeploys) ──────────────────────
const ANNOUNCEMENT_KEY = "announcement";
const ANNOUNCEMENT_FALLBACK = { active: true, message: "" };

async function getAnnouncement() {
  try {
    const { data, error } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", ANNOUNCEMENT_KEY)
      .single();
    if (error || !data) return ANNOUNCEMENT_FALLBACK;
    return { active: Boolean(data.value.active), message: String(data.value.message || "") };
  } catch {
    return ANNOUNCEMENT_FALLBACK;
  }
}

async function setAnnouncement(active, message) {
  const value = { active: Boolean(active), message: typeof message === "string" ? message.trim() : "" };
  await supabase.from("app_config").upsert(
    { key: ANNOUNCEMENT_KEY, value, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  return value;
}

app.get("/announcement", async (_req, res) => {
  const ann = await getAnnouncement();
  return res.json({ active: ann.active, message: ann.active ? ann.message : "" });
});

app.post("/admin/announcement", requireAdmin, async (req, res) => {
  try {
    const { active, message } = req.body;
    const ann = await setAnnouncement(active, message);
    console.log(`Announcement updated: active=${ann.active} message="${ann.message}"`);
    return res.json({ success: true, active: ann.active, message: ann.message });
  } catch (err) {
    console.error("Announcement update error:", err);
    return res.status(500).json({ error: "announcement_update_failed" });
  }
});


// ─── ACTIVATE ─────────────────────────────────────────────────────────────────
app.post("/activate", async (req, res) => {
  try {
    const { license, hwid, app_version } = req.body;

    if (!license || !hwid) {
      return res.json({ valid: false, reason: "missing_fields" });
    }

    const { data: licenseRow, error: licenseError } = await supabase
      .from("licenses")
      .select("*")
      .eq("license_key", license)
      .single();

    if (licenseError || !licenseRow) {
      await supabase.from("activations").insert({
        license_key: license,
        hwid,
        result: "license_not_found",
        app_version: app_version || null
      });
      return res.json({ valid: false, reason: "license_not_found" });
    }

    const maintenanceFlags = getMaintenanceFlags(licenseRow);
    const expired = isLicenseExpired(licenseRow);
    const paymentSatisfied = isPaymentSatisfied(licenseRow);

    if (licenseRow.status !== "active") {
      await supabase.from("activations").insert({
        license_key: license, hwid, result: "inactive", app_version: app_version || null
      });
      return res.json({ valid: false, reason: "inactive", ...maintenanceFlags });
    }

    if (expired) {
      await supabase.from("activations").insert({
        license_key: license, hwid, result: "expired", app_version: app_version || null
      });
      return res.json({ valid: false, reason: "expired", ...maintenanceFlags });
    }

    if (!paymentSatisfied) {
      await supabase.from("activations").insert({
        license_key: license, hwid, result: "payment_required", app_version: app_version || null
      });
      return res.json({ valid: false, reason: "payment_required", ...maintenanceFlags });
    }

    if (!licenseRow.hwid) {
      const { error: bindError } = await supabase
        .from("licenses")
        .update({
          hwid,
          last_validated_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq("license_key", license);

      if (bindError) {
        await supabase.from("activations").insert({
          license_key: license, hwid, result: "bind_failed", app_version: app_version || null
        });
        return res.json({ valid: false, reason: "bind_failed", ...maintenanceFlags });
      }

      await supabase.from("activations").insert({
        license_key: license, hwid, result: "first_activation_success", app_version: app_version || null
      });
      return res.json({ valid: true, reason: "first_activation_success", ...maintenanceFlags });
    }

    if (licenseRow.hwid !== hwid) {
      await supabase.from("activations").insert({
        license_key: license, hwid, result: "hwid_mismatch", app_version: app_version || null
      });
      return res.json({ valid: false, reason: "hwid_mismatch", ...maintenanceFlags });
    }

    await supabase
      .from("licenses")
      .update({ last_validated_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("license_key", license);

    await supabase.from("activations").insert({
      license_key: license, hwid, result: "validation_success", app_version: app_version || null
    });

    return res.json({ valid: true, reason: "validation_success", ...maintenanceFlags });
  } catch (err) {
    console.error("Activation route error:", err);
    return res.status(500).json({ valid: false, reason: "server_error" });
  }
});

// ─── REPORT GPU ───────────────────────────────────────────────────────────────
app.post("/report-gpu", async (req, res) => {
  try {
    const {
      license, hwid, app_version,
      gpu_name, gpu_driver_version, gpu_raw_driver_version, gpu_is_laptop, reported_at
    } = req.body;

    if (!license || !hwid || !gpu_name || !gpu_driver_version) {
      return res.status(400).json({ ok: false, reason: "missing_fields" });
    }

    const { data: licenseRow, error: licenseError } = await supabase
      .from("licenses").select("*").eq("license_key", license).single();

    if (licenseError || !licenseRow) {
      return res.status(404).json({ ok: false, reason: "license_not_found" });
    }

    if (licenseRow.hwid && licenseRow.hwid !== hwid) {
      return res.status(403).json({ ok: false, reason: "hwid_mismatch" });
    }

    const updatePayload = {
      gpu_name,
      gpu_driver_version,
      gpu_raw_driver_version: gpu_raw_driver_version || null,
      gpu_is_laptop: Boolean(gpu_is_laptop),
      last_gpu_reported_at: reported_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { error: gpuUpdateError } = await supabase
      .from("licenses").update(updatePayload).eq("license_key", license);

    if (gpuUpdateError) console.error("GPU update columns error:", gpuUpdateError);

    let suggested = null;

    try {
      if (gpu_name.toLowerCase().includes("nvidia")) {
        suggested = await lookupDriverWithGemini({ gpu_name, gpu_driver_version, gpu_is_laptop: Boolean(gpu_is_laptop) });
        console.log("Gemini suggested result:", suggested);
      }
    } catch (geminiError) {
      console.error("Gemini lookup error:", geminiError);
    }

    if (suggested) {
      const suggestedPayload = {
        suggested_driver_status: suggested.status || null,
        suggested_driver_latest: suggested.latest || null,
        suggested_driver_download_url: suggested.download_url || null,
        suggested_driver_checked_at: new Date().toISOString(),
        driver_note: licenseRow.driver_note || suggested.note || null,
        updated_at: new Date().toISOString()
      };

      const { error: suggestedUpdateError } = await supabase
        .from("licenses").update(suggestedPayload).eq("license_key", license);

      if (suggestedUpdateError) console.error("Suggested driver columns error:", suggestedUpdateError);
    }

    const refreshedLicense = {
      ...licenseRow,
      suggested_driver_status: suggested?.status || licenseRow.suggested_driver_status || null,
      suggested_driver_latest: suggested?.latest || licenseRow.suggested_driver_latest || null,
      suggested_driver_download_url: suggested?.download_url || licenseRow.suggested_driver_download_url || null,
      driver_note: licenseRow.driver_note || suggested?.note || null
    };

    const preferredUrl = refreshedLicense.approved_driver_download_url || refreshedLicense.suggested_driver_download_url || null;
    const preferredLatest = refreshedLicense.approved_driver_latest || refreshedLicense.suggested_driver_latest || null;
    const preferredNote = refreshedLicense.driver_note || null;
    const driverUpdateAvailable =
      Boolean(preferredUrl) &&
      (Boolean(refreshedLicense.approved_driver_download_url) || refreshedLicense.suggested_driver_status === "outdated");

    return res.json({
      ok: true,
      gpu_name,
      gpu_driver_version,
      driver_update_available: driverUpdateAvailable,
      driver_download_url: preferredUrl,
      driver_note: preferredNote,
      driver_latest_version: preferredLatest,
      driver_status: refreshedLicense.suggested_driver_status || "unknown"
    });
  } catch (err) {
    console.error("Report GPU route error:", err);
    return res.status(500).json({ ok: false, reason: "server_error" });
  }
});

async function lookupDriverWithGemini({ gpu_name, gpu_driver_version, gpu_is_laptop }) {
  if (!process.env.GEMINI_API_KEY) return null;

  const prompt = `
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
- DO NOT return generic NVIDIA search pages.
- DO NOT return: https://www.nvidia.com/Download/index.aspx, https://www.nvidia.com/en-us/drivers/, /drivers/results/ pages
- If you cannot find a direct installer URL, return an empty string for download_url.
Decision rules:
- If installed driver is older than newest, set status to "outdated".
- If installed driver matches newest, set status to "up-to-date".
- If uncertain, set status to "unknown".
Return only this JSON:
{"status":"outdated" or "up-to-date" or "unknown","latest":"xxx.xx","download_url":"https://...","note":"short explanation"}
`.trim();

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.05 }
      })
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini HTTP ${response.status} // ${text}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  return sanitizeDriverResult(jsonFromGeminiText(text));
}

// ─── ADMIN: ANALYTICS ─────────────────────────────────────────────────────────
app.get("/admin/analytics/summary", requireAdmin, async (_req, res) => {
  try {
    const { count: totalLicenses } = await supabase
      .from("licenses").select("*", { count: "exact", head: true });
    const { count: activeLicenses } = await supabase
      .from("licenses").select("*", { count: "exact", head: true }).eq("status", "active");
    const { count: totalActivations } = await supabase
      .from("activations").select("*", { count: "exact", head: true });
    const { count: recentSuccesses } = await supabase
      .from("activations").select("*", { count: "exact", head: true }).eq("result", "validation_success");
    const { count: activeSubscriptions } = await supabase
      .from("payment_subscriptions").select("*", { count: "exact", head: true }).eq("status", "active");

    return res.json({
      totalLicenses: totalLicenses || 0,
      activeLicenses: activeLicenses || 0,
      totalActivations: totalActivations || 0,
      recentSuccesses: recentSuccesses || 0,
      activeSubscriptions: activeSubscriptions || 0
    });
  } catch (err) {
    console.error("Summary route error:", err);
    return res.status(500).json({ error: "summary_failed" });
  }
});

app.get("/admin/activations/recent", requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("activations").select("*").order("created_at", { ascending: false }).limit(25);
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    console.error("Recent activations route error:", err);
    return res.status(500).json({ error: "recent_activations_failed" });
  }
});

app.get("/admin/licenses/search", requireAdmin, async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    if (!q) return res.json([]);

    const { data, error } = await supabase
      .from("licenses")
      .select("*")
      .or(`license_key.ilike.%${q}%,hwid.ilike.%${q}%,email.ilike.%${q}%,discord.ilike.%${q}%`)
      .order("created_at", { ascending: false })
      .limit(25);

    if (error) throw error;
    return res.json(data);
  } catch (err) {
    console.error("License search route error:", err);
    return res.status(500).json({ error: "search_failed" });
  }
});

app.post("/admin/licenses/reset-hwid", requireAdmin, async (req, res) => {
  try {
    const { license_key } = req.body;
    if (!license_key) return res.status(400).json({ error: "missing_license_key" });

    const { error } = await supabase
      .from("licenses")
      .update({
        hwid: null,
        gpu_name: null, gpu_driver_version: null, gpu_raw_driver_version: null,
        gpu_is_laptop: null, last_gpu_reported_at: null,
        suggested_driver_status: null, suggested_driver_latest: null,
        suggested_driver_download_url: null, suggested_driver_checked_at: null,
        approved_driver_latest: null, approved_driver_download_url: null,
        driver_note: null, updated_at: new Date().toISOString()
      })
      .eq("license_key", license_key);

    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error("Reset HWID route error:", err);
    return res.status(500).json({ error: "reset_hwid_failed" });
  }
});

app.post("/admin/licenses/set-maintenance", requireAdmin, async (req, res) => {
  try {
    const { license_key, recommended_maintenance, recommended_maintenance_message } = req.body;
    if (!license_key) return res.status(400).json({ error: "missing_license_key" });

    const updatePayload = {
      recommended_maintenance: Boolean(recommended_maintenance),
      recommended_maintenance_message:
        typeof recommended_maintenance_message === "string" && recommended_maintenance_message.trim()
          ? recommended_maintenance_message.trim() : null,
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase.from("licenses").update(updatePayload).eq("license_key", license_key);
    if (error) throw error;
    return res.json({ success: true, ...updatePayload });
  } catch (err) {
    console.error("Set maintenance route error:", err);
    return res.status(500).json({ error: "set_maintenance_failed" });
  }
});

app.post("/admin/licenses/clear-maintenance", requireAdmin, async (req, res) => {
  try {
    const { license_key } = req.body;
    if (!license_key) return res.status(400).json({ error: "missing_license_key" });

    const { error } = await supabase
      .from("licenses")
      .update({ recommended_maintenance: false, recommended_maintenance_message: null, updated_at: new Date().toISOString() })
      .eq("license_key", license_key);

    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error("Clear maintenance route error:", err);
    return res.status(500).json({ error: "clear_maintenance_failed" });
  }
});

app.post("/admin/licenses/revoke", requireAdmin, async (req, res) => {
  try {
    const { license_key } = req.body;
    if (!license_key) return res.status(400).json({ error: "missing_license_key" });

    const { error } = await supabase
      .from("licenses")
      .update({ status: "inactive", updated_at: new Date().toISOString() })
      .eq("license_key", license_key);

    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error("Revoke route error:", err);
    return res.status(500).json({ error: "revoke_failed" });
  }
});

app.post("/admin/licenses/set-discord", requireAdmin, async (req, res) => {
  try {
    const { license_key, discord } = req.body;
    if (!license_key) return res.status(400).json({ error: "missing_license_key" });

    const { error } = await supabase
      .from("licenses")
      .update({
        discord: typeof discord === "string" && discord.trim() ? discord.trim() : null,
        updated_at: new Date().toISOString()
      })
      .eq("license_key", license_key);

    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error("Set discord route error:", err);
    return res.status(500).json({ error: "set_discord_failed" });
  }
});

app.post("/admin/licenses/create", requireAdmin, async (req, res) => {
  try {
    const { license_key, email, discord, plan, status, expires_at, issued_by } = req.body;
    if (!license_key || !email) return res.status(400).json({ error: "missing_fields" });

    const nowIso = new Date().toISOString();
    const payload = {
      license_key, hwid: null, email,
      discord: typeof discord === "string" && discord.trim() ? discord.trim() : null,
      plan: plan || "monthly",
      status: status || "active",
      expires_at: expires_at || null,
      created_manually: true,
      issued_by: typeof issued_by === "string" && issued_by.trim() ? issued_by.trim() : "technician",
      payment_required: false,
      payment_status: "waived",
      is_legacy: true,
      created_at: nowIso, updated_at: nowIso
    };

    const { error } = await supabase.from("licenses").upsert(payload, { onConflict: "license_key", ignoreDuplicates: true });
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error("Create license route error:", err);
    return res.status(500).json({ error: "create_license_failed" });
  }
});

app.post("/admin/licenses/create-paid", requireAdmin, async (req, res) => {
  try {
    const { license_key, email, discord, plan, expires_at } = req.body;
    if (!license_key || !email) return res.status(400).json({ error: "missing_fields" });

    const nowIso = new Date().toISOString();
    const payload = {
      license_key, hwid: null, email,
      discord: typeof discord === "string" && discord.trim() ? discord.trim() : null,
      plan: plan || "monthly",
      status: "inactive",
      expires_at: expires_at || null,
      created_manually: false,
      issued_by: "payment_system",
      payment_required: true,
      payment_status: "pending",
      is_legacy: false,
      created_at: nowIso, updated_at: nowIso
    };

    const { error } = await supabase.from("licenses").upsert(payload, { onConflict: "license_key", ignoreDuplicates: true });
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error("Create paid license route error:", err);
    return res.status(500).json({ error: "create_paid_license_failed" });
  }
});

// ─── ADMIN: SUBSCRIPTIONS ─────────────────────────────────────────────────────

/**
 * POST /admin/subscriptions/create
 * Creates a payment_subscription record and links it to an existing license.
 * Body: { license_key, provider_subscription_id, email, discord?, customer_name?, phone?, plan_code? }
 *
 * Flow:
 *  1. Validate license exists
 *  2. Insert into payment_subscriptions
 *  3. Update license with linked_subscription_ref, is_legacy=false, payment_required=true
 *  4. Immediately run a single sync for this subscription so status reflects current state
 */
app.post("/admin/subscriptions/create", requireAdmin, async (req, res) => {
  try {
    const {
      license_key,
      provider_subscription_id,
      email,
      discord,
      customer_name,
      phone,
      plan_code
    } = req.body;

    if (!license_key || !provider_subscription_id || !email) {
      return res.status(400).json({ error: "missing_fields", required: ["license_key", "provider_subscription_id", "email"] });
    }

    // 1. Fetch the license
    const { data: licenseRow, error: licenseError } = await supabase
      .from("licenses")
      .select("id, license_key, is_legacy, plan")
      .eq("license_key", license_key)
      .single();

    if (licenseError || !licenseRow) {
      return res.status(404).json({ error: "license_not_found" });
    }

    if (licenseRow.is_legacy === true) {
      return res.status(400).json({
        error: "license_is_legacy",
        message: "Cannot link a subscription to a legacy/manual license. Set is_legacy=false first."
      });
    }

    const nowIso = new Date().toISOString();
    const subscriptionRef = generateSubRef();

    // 2. Insert subscription record
    const { error: insertError } = await supabase
      .from("payment_subscriptions")
      .insert({
        subscription_ref: subscriptionRef,
        provider: "mamopay",
        provider_subscription_id,
        linked_license_id: licenseRow.id,
        customer_name: customer_name || null,
        email,
        discord: typeof discord === "string" && discord.trim() ? discord.trim() : null,
        phone: phone || null,
        plan_code: plan_code || licenseRow.plan || "monthly",
        status: "pending",
        created_at: nowIso,
        updated_at: nowIso
      });

    if (insertError) throw insertError;

    // 3. Link subscription ref back on the license
    const { error: linkError } = await supabase
      .from("licenses")
      .update({
        linked_subscription_ref: subscriptionRef,
        payment_required: true,
        payment_status: "pending",
        updated_at: nowIso
      })
      .eq("license_key", license_key);

    if (linkError) throw linkError;

    // 4. Immediate sync for this subscription only
    let syncResult = null;
    try {
      const paymentsData = await fetchMamoSubscriptionPayments(provider_subscription_id, null);
      const resolved = resolveSubscriptionStatus(paymentsData, null);
      syncResult = resolved;

      await supabase
        .from("payment_subscriptions")
        .update({
          status: resolved.subStatus,
          latest_payment_status: resolved.latestPayment
            ? String(resolved.latestPayment.status || "unknown").toLowerCase()
            : null,
          latest_payment_at: resolved.latestPayment?.created_at || null,
          last_checked_at: nowIso,
          updated_at: nowIso
        })
        .eq("subscription_ref", subscriptionRef);

      if (resolved.licenseStatus && resolved.paymentStatus) {
        await supabase
          .from("licenses")
          .update({
            status: resolved.licenseStatus,
            payment_status: resolved.paymentStatus,
            updated_at: nowIso
          })
          .eq("license_key", license_key);
      }
    } catch (syncErr) {
      console.error("[create-subscription] Immediate sync failed (non-fatal):", syncErr.message);
    }

    return res.json({
      success: true,
      subscription_ref: subscriptionRef,
      license_key,
      linked_license_id: licenseRow.id,
      immediate_sync: syncResult
        ? {
            sub_status: syncResult.subStatus,
            license_status: syncResult.licenseStatus,
            payment_status: syncResult.paymentStatus
          }
        : null
    });
  } catch (err) {
    console.error("Create subscription route error:", err);
    return res.status(500).json({ error: "create_subscription_failed", details: String(err.message || err) });
  }
});

/**
 * GET /admin/subscriptions/list
 * Returns all subscriptions with their linked license info.
 */
app.get("/admin/subscriptions/list", requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("payment_subscriptions")
      .select("*, licenses(license_key, email, status, payment_status)")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;
    return res.json(data);
  } catch (err) {
    console.error("List subscriptions error:", err);
    return res.status(500).json({ error: "list_subscriptions_failed" });
  }
});

/**
 * POST /admin/subscriptions/sync
 * Manually trigger a full subscription sync against Mamo.
 * The cron runs this automatically every 20 minutes.
 */
app.post("/admin/subscriptions/sync", requireAdmin, async (_req, res) => {
  try {
    const results = await runSubscriptionSync();
    return res.json({
      success: true,
      checked: results.length,
      ok: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
      results
    });
  } catch (err) {
    console.error("Manual sync route error:", err);
    return res.status(500).json({ error: "sync_failed", details: String(err.message || err) });
  }
});

/**
 * DELETE /admin/subscriptions/:subscription_ref
 * Cancels (soft-deletes) a subscription — marks it cancelled and deactivates the license.
 * Does NOT call Mamo to cancel — that's done manually in the Mamo dashboard.
 */
app.delete("/admin/subscriptions/:subscription_ref", requireAdmin, async (req, res) => {
  try {
    const { subscription_ref } = req.params;

    const { data: sub, error: fetchError } = await supabase
      .from("payment_subscriptions")
      .select("id, linked_license_id")
      .eq("subscription_ref", subscription_ref)
      .single();

    if (fetchError || !sub) return res.status(404).json({ error: "subscription_not_found" });

    const nowIso = new Date().toISOString();

    await supabase
      .from("payment_subscriptions")
      .update({ status: "cancelled", cancelled_at: nowIso, updated_at: nowIso })
      .eq("subscription_ref", subscription_ref);

    if (sub.linked_license_id) {
      await supabase
        .from("licenses")
        .update({ status: "inactive", payment_status: "failed", updated_at: nowIso })
        .eq("id", sub.linked_license_id);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Cancel subscription error:", err);
    return res.status(500).json({ error: "cancel_subscription_failed" });
  }
});

// ─── ADMIN: MAMO PAYMENT ORDERS (unchanged from original) ─────────────────────
app.post("/admin/payments/create-mamo-order", requireAdmin, async (req, res) => {
  try {
    const { license_key, email, discord, customer_name, phone, plan_code, amount, currency, expires_at } = req.body;
    if (!license_key || !email || !plan_code || !amount) return res.status(400).json({ error: "missing_fields" });

    const nowIso = new Date().toISOString();

    const paidLicensePayload = {
      license_key, hwid: null, email,
      discord: typeof discord === "string" && discord.trim() ? discord.trim() : null,
      plan: plan_code, status: "inactive", expires_at: expires_at || null,
      created_manually: false, issued_by: "payment_system",
      payment_required: true, payment_status: "pending", is_legacy: false,
      created_at: nowIso, updated_at: nowIso
    };

    const { data: insertedLicense, error: licenseError } = await supabase
      .from("licenses").insert(paidLicensePayload).select("id, license_key").single();
    if (licenseError) throw licenseError;

    const orderRef = generateOrderRef();

    const { data: insertedOrder, error: orderError } = await supabase
      .from("payment_orders")
      .insert({
        order_ref: orderRef, customer_name: customer_name || null, email,
        discord: typeof discord === "string" && discord.trim() ? discord.trim() : null,
        phone: phone || null, provider: "mamopay", plan_code, amount,
        currency: currency || "AED", status: "pending",
        linked_license_id: insertedLicense.id, auto_create_license: false,
        metadata: { license_key, source: "admin_create_mamo_order" },
        created_at: nowIso, updated_at: nowIso
      })
      .select("*").single();
    if (orderError) throw orderError;

    const mamoResult = await createMamoPaymentLink({
      amount, currency: currency || "AED",
      description: `VoltechShield ${plan_code} license ${license_key}`,
      customer_name: customer_name || "", customer_email: email, order_ref: orderRef
    });

    const providerOrderId = mamoResult.id || mamoResult.link_id || mamoResult.payment_link_id || mamoResult.external_id || null;
    const checkoutUrl = mamoResult.checkout_url || mamoResult.url || mamoResult.payment_url || null;
    const providerPaymentId = mamoResult.payment_id || mamoResult.charge_id || null;

    await supabase.from("payment_orders")
      .update({ provider_order_id: providerOrderId, provider_payment_id: providerPaymentId, provider_checkout_url: checkoutUrl, payment_link: checkoutUrl, updated_at: new Date().toISOString() })
      .eq("id", insertedOrder.id);

    return res.json({ success: true, order_ref: orderRef, license_key, linked_license_id: insertedLicense.id, provider_order_id: providerOrderId, checkout_url: checkoutUrl, raw: mamoResult });
  } catch (err) {
    console.error("Create Mamo order route error:", err);
    return res.status(500).json({ error: "create_mamo_order_failed", details: String(err.message || err) });
  }
});

app.post("/admin/payments/sync-mamo", requireAdmin, async (_req, res) => {
  try {
    const { data: pendingOrders, error: pendingError } = await supabase
      .from("payment_orders").select("*").eq("provider", "mamopay").in("status", ["draft", "pending"]);
    if (pendingError) throw pendingError;

    const results = [];

    for (const order of pendingOrders || []) {
      try {
        if (!order.provider_order_id) {
          results.push({ order_ref: order.order_ref, ok: false, reason: "missing_provider_order_id" });
          continue;
        }

        const mamoStatus = await fetchMamoPaymentStatus(order.provider_order_id);
        const rawStatus = String(mamoStatus.status || mamoStatus.payment_status || mamoStatus.state || "unknown").toLowerCase();

        let nextOrderStatus = order.status, nextLicenseStatus = null, nextPaymentStatus = null, paidAt = null;

        if (["paid", "captured", "success", "completed"].includes(rawStatus)) {
          nextOrderStatus = "paid"; nextLicenseStatus = "active"; nextPaymentStatus = "paid"; paidAt = new Date().toISOString();
        } else if (rawStatus === "failed") {
          nextOrderStatus = "failed"; nextLicenseStatus = "inactive"; nextPaymentStatus = "failed";
        } else if (rawStatus === "refunded") {
          nextOrderStatus = "refunded"; nextLicenseStatus = "inactive"; nextPaymentStatus = "refunded";
        } else if (["cancelled", "canceled"].includes(rawStatus)) {
          nextOrderStatus = "cancelled"; nextLicenseStatus = "inactive"; nextPaymentStatus = "unpaid";
        } else if (rawStatus === "expired") {
          nextOrderStatus = "expired"; nextLicenseStatus = "inactive"; nextPaymentStatus = "unpaid";
        }

        const providerPaymentId = mamoStatus.payment_id || mamoStatus.charge_id || order.provider_payment_id || null;
        const providerCheckoutUrl = mamoStatus.checkout_url || mamoStatus.url || order.provider_checkout_url || null;

        await supabase.from("payment_orders")
          .update({ status: nextOrderStatus, provider_payment_id: providerPaymentId, provider_checkout_url: providerCheckoutUrl, payment_link: providerCheckoutUrl, paid_at: paidAt || order.paid_at, last_checked_at: new Date().toISOString(), metadata: { ...(order.metadata || {}), last_mamo_sync: mamoStatus }, updated_at: new Date().toISOString() })
          .eq("id", order.id);

        if (order.linked_license_id && nextLicenseStatus && nextPaymentStatus) {
          const { data: linkedLicense } = await supabase.from("licenses").select("id, is_legacy, plan, expires_at").eq("id", order.linked_license_id).single();

          const licenseUpdate = { payment_status: nextPaymentStatus, updated_at: new Date().toISOString() };
          if (linkedLicense?.is_legacy !== true) licenseUpdate.status = nextLicenseStatus;

          if (nextPaymentStatus === "paid") {
            let newExpiry = linkedLicense?.expires_at;
            if (order.plan_code === "monthly") newExpiry = addDaysIso(newExpiry, 30);
            else if (order.plan_code === "6months") newExpiry = addDaysIso(newExpiry, 180);
            else if (order.plan_code === "yearly") newExpiry = addDaysIso(newExpiry, 365);
            else if (order.plan_code === "lifetime") newExpiry = null;
            licenseUpdate.expires_at = newExpiry;
            licenseUpdate.last_activated_at = new Date().toISOString();
            licenseUpdate.source_order_id_text = order.provider_order_id || null;
            licenseUpdate.source_payment_id_text = providerPaymentId || null;
          }

          await supabase.from("licenses").update(licenseUpdate).eq("id", order.linked_license_id);
        }

        results.push({ order_ref: order.order_ref, ok: true, raw_status: rawStatus, final_order_status: nextOrderStatus, final_payment_status: nextPaymentStatus });
      } catch (innerErr) {
        console.error("Sync order error:", order.order_ref, innerErr);
        results.push({ order_ref: order.order_ref, ok: false, reason: String(innerErr.message || innerErr) });
      }
    }

    return res.json({ success: true, checked: results.length, results });
  } catch (err) {
    console.error("Sync Mamo route error:", err);
    return res.status(500).json({ error: "sync_mamo_failed", details: String(err.message || err) });
  }
});

async function createMamoPaymentLink({ amount, currency, description, customer_name, customer_email, order_ref }) {
  if (!process.env.MAMO_API_KEY || !process.env.MAMO_API_BASE_URL) throw new Error("Missing MAMO env vars");

  const response = await fetch(`${process.env.MAMO_API_BASE_URL}/links`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.MAMO_API_KEY}` },
    body: JSON.stringify({ title: description, description, amount, currency, external_id: order_ref, customer: { name: customer_name || "", email: customer_email || "" } })
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Mamo create link failed: ${response.status} // ${text}`);

  try { return JSON.parse(text); } catch { throw new Error(`Mamo create link non-JSON: ${text}`); }
}

async function fetchMamoPaymentStatus(providerOrderId) {
  if (!process.env.MAMO_API_KEY || !process.env.MAMO_API_BASE_URL) throw new Error("Missing MAMO env vars");

  const response = await fetch(`${process.env.MAMO_API_BASE_URL}/links/${providerOrderId}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${process.env.MAMO_API_KEY}` }
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Mamo fetch status failed: ${response.status} // ${text}`);

  try { return JSON.parse(text); } catch { throw new Error(`Mamo status non-JSON: ${text}`); }
}

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Voltech Shield license server running on port ${PORT}`);
  startSyncCron();
});
