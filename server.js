require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

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

function requireAdmin(req, res, next) {
  const incomingKey = req.headers["x-admin-key"];

  if (incomingKey !== process.env.ADMIN_DASHBOARD_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }

  next();
}

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

    if (obviouslyBad) {
      downloadUrl = null;
    }
  }

  return {
    status,
    latest,
    download_url: downloadUrl,
    note
  };
}

function getMaintenanceFlags(licenseRow) {
  return {
    recommended_maintenance: Boolean(
      licenseRow.recommended_maintenance ?? false
    ),
    recommended_maintenance_message:
      licenseRow.recommended_maintenance_message ||
      "Recommended maintenance available from Voltech."
  };
}

function normalizePositiveInteger(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function safeTrim(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeBoolean(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function addDaysToIso(baseDate, days) {
  const date = new Date(baseDate);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

async function getPlanByCode(planCode) {
  if (!planCode) return null;

  const { data, error } = await supabase
    .from("license_plans")
    .select("*")
    .ilike("code", planCode)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function getLicenseByKey(licenseKey) {
  const { data, error } = await supabase
    .from("licenses")
    .select("*")
    .eq("license_key", licenseKey)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function insertAdminAudit(action, targetType, targetId, details = {}) {
  try {
    await supabase.from("admin_audit_log").insert({
      action,
      target_type: targetType,
      target_id: targetId || null,
      details
    });
  } catch (err) {
    console.error("Admin audit log insert failed:", err);
  }
}

async function lookupDriverWithGemini({
  gpu_name,
  gpu_driver_version,
  gpu_is_laptop
}) {
  if (!process.env.GEMINI_API_KEY) {
    return null;
  }

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
{
  "status": "outdated" or "up-to-date" or "unknown",
  "latest": "xxx.xx",
  "download_url": "https://...",
  "note": "short explanation"
}
`.trim();

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        tools: [{ googleSearch: {} }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.05
        }
      })
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini HTTP ${response.status} // ${text}`);
  }

  const data = await response.json();
  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("") || "";

  const parsed = jsonFromGeminiText(text);
  return sanitizeDriverResult(parsed);
}

app.get("/", (_req, res) => {
  return res.json({
    ok: true,
    service: "voltechshield-api",
    status: "online"
  });
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
    version: "1.0.0",
    notes: "First Public Release",
    url: "https://github.com/VoltechFPS-Code/voltechshield-api/releases/download/v1.0.0/VoltechShield_1.0.0_x64-setup.exe"
  });
});

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

    if (licenseRow.status !== "active") {
      await supabase.from("activations").insert({
        license_key: license,
        license_id: licenseRow.id,
        hwid,
        result: "inactive",
        app_version: app_version || null
      });

      return res.json({
        valid: false,
        reason: "inactive",
        ...maintenanceFlags
      });
    }

    if (licenseRow.expires_at && new Date(licenseRow.expires_at) < new Date()) {
      await supabase.from("activations").insert({
        license_key: license,
        license_id: licenseRow.id,
        hwid,
        result: "expired",
        app_version: app_version || null
      });

      return res.json({
        valid: false,
        reason: "expired",
        ...maintenanceFlags
      });
    }

    if (!licenseRow.hwid) {
      const nowIso = new Date().toISOString();

      const { error: bindError } = await supabase
        .from("licenses")
        .update({
          hwid,
          last_activated_at: nowIso,
          last_validated_at: nowIso,
          updated_at: nowIso
        })
        .eq("license_key", license);

      if (bindError) {
        await supabase.from("activations").insert({
          license_key: license,
          license_id: licenseRow.id,
          hwid,
          result: "bind_failed",
          app_version: app_version || null
        });

        return res.json({
          valid: false,
          reason: "bind_failed",
          ...maintenanceFlags
        });
      }

      await supabase.from("activations").insert({
        license_key: license,
        license_id: licenseRow.id,
        hwid,
        result: "first_activation_success",
        app_version: app_version || null
      });

      return res.json({
        valid: true,
        reason: "first_activation_success",
        ...maintenanceFlags
      });
    }

    if (licenseRow.hwid !== hwid) {
      await supabase.from("activations").insert({
        license_key: license,
        license_id: licenseRow.id,
        hwid,
        result: "hwid_mismatch",
        app_version: app_version || null
      });

      return res.json({
        valid: false,
        reason: "hwid_mismatch",
        ...maintenanceFlags
      });
    }

    const nowIso = new Date().toISOString();

    await supabase
      .from("licenses")
      .update({
        last_validated_at: nowIso,
        last_activated_at: nowIso,
        updated_at: nowIso
      })
      .eq("license_key", license);

    await supabase.from("activations").insert({
      license_key: license,
      license_id: licenseRow.id,
      hwid,
      result: "validation_success",
      app_version: app_version || null
    });

    return res.json({
      valid: true,
      reason: "validation_success",
      ...maintenanceFlags
    });
  } catch (err) {
    console.error("Activation route error:", err);
    return res.status(500).json({
      valid: false,
      reason: "server_error"
    });
  }
});

app.post("/report-gpu", async (req, res) => {
  try {
    const {
      license,
      hwid,
      app_version,
      gpu_name,
      gpu_driver_version,
      gpu_raw_driver_version,
      gpu_is_laptop,
      reported_at
    } = req.body;

    if (!license || !hwid || !gpu_name || !gpu_driver_version) {
      return res.status(400).json({
        ok: false,
        reason: "missing_fields"
      });
    }

    const { data: licenseRow, error: licenseError } = await supabase
      .from("licenses")
      .select("*")
      .eq("license_key", license)
      .single();

    if (licenseError || !licenseRow) {
      return res.status(404).json({
        ok: false,
        reason: "license_not_found"
      });
    }

    if (licenseRow.hwid && licenseRow.hwid !== hwid) {
      return res.status(403).json({
        ok: false,
        reason: "hwid_mismatch"
      });
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
      .from("licenses")
      .update(updatePayload)
      .eq("license_key", license);

    if (gpuUpdateError) {
      console.error("GPU update columns error:", gpuUpdateError);
    }

    let suggested = null;

    try {
      if (gpu_name.toLowerCase().includes("nvidia")) {
        suggested = await lookupDriverWithGemini({
          gpu_name,
          gpu_driver_version,
          gpu_is_laptop: Boolean(gpu_is_laptop)
        });
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
        .from("licenses")
        .update(suggestedPayload)
        .eq("license_key", license);

      if (suggestedUpdateError) {
        console.error("Suggested driver columns error:", suggestedUpdateError);
      }
    }

    const refreshedLicense = {
      ...licenseRow,
      suggested_driver_status:
        suggested?.status || licenseRow.suggested_driver_status || null,
      suggested_driver_latest:
        suggested?.latest || licenseRow.suggested_driver_latest || null,
      suggested_driver_download_url:
        suggested?.download_url ||
        licenseRow.suggested_driver_download_url ||
        null,
      driver_note: licenseRow.driver_note || suggested?.note || null
    };

    const preferredUrl =
      refreshedLicense.approved_driver_download_url ||
      refreshedLicense.suggested_driver_download_url ||
      null;

    const preferredLatest =
      refreshedLicense.approved_driver_latest ||
      refreshedLicense.suggested_driver_latest ||
      null;

    const preferredNote = refreshedLicense.driver_note || null;

    const driverUpdateAvailable =
      Boolean(preferredUrl) &&
      (Boolean(refreshedLicense.approved_driver_download_url) ||
        refreshedLicense.suggested_driver_status === "outdated");

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
    return res.status(500).json({
      ok: false,
      reason: "server_error"
    });
  }
});

app.get("/admin/analytics/summary", requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("v_dashboard_summary")
      .select("*")
      .maybeSingle();

    if (error) throw error;

    return res.json(
      data || {
        total_licenses: 0,
        active_licenses: 0,
        total_activations: 0,
        successful_validations: 0,
        total_orders: 0,
        paid_orders: 0,
        revenue_total_aed: 0,
        maintenance_flagged: 0,
        outdated_drivers: 0,
        unpaid_licenses: 0
      }
    );
  } catch (err) {
    console.error("Summary route error:", err);
    return res.status(500).json({ error: "summary_failed" });
  }
});

app.get("/admin/activations/recent", requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("activations")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;

    return res.json(data || []);
  } catch (err) {
    console.error("Recent activations route error:", err);
    return res.status(500).json({ error: "recent_activations_failed" });
  }
});

app.get("/admin/licenses", requireAdmin, async (req, res) => {
  try {
    const limit = normalizePositiveInteger(req.query.limit, 100);
    const offset = Math.max(normalizePositiveInteger(req.query.offset, 0) || 0, 0);

    let query = supabase
      .from("licenses")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    const status = safeTrim(req.query.status);
    const plan = safeTrim(req.query.plan);
    const paymentStatus = safeTrim(req.query.payment_status);
    const q = safeTrim(req.query.q);

    if (status) query = query.eq("status", status);
    if (plan) query = query.ilike("plan", plan);
    if (paymentStatus) query = query.eq("payment_status", paymentStatus);
    if (q) {
      query = query.or(
        `license_key.ilike.%${q}%,hwid.ilike.%${q}%,email.ilike.%${q}%,discord.ilike.%${q}%`
      );
    }

    const { data, error, count } = await query;

    if (error) throw error;

    return res.json({
      items: data || [],
      total: count || 0,
      limit,
      offset
    });
  } catch (err) {
    console.error("List licenses route error:", err);
    return res.status(500).json({ error: "list_licenses_failed" });
  }
});

app.get("/admin/licenses/search", requireAdmin, async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();

    if (!q) {
      return res.json([]);
    }

    const { data, error } = await supabase
      .from("licenses")
      .select("*")
      .or(
        `license_key.ilike.%${q}%,hwid.ilike.%${q}%,email.ilike.%${q}%,discord.ilike.%${q}%`
      )
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;

    return res.json(data || []);
  } catch (err) {
    console.error("License search route error:", err);
    return res.status(500).json({ error: "search_failed" });
  }
});

app.get("/admin/licenses/:license_key", requireAdmin, async (req, res) => {
  try {
    const licenseKey = req.params.license_key;

    const license = await getLicenseByKey(licenseKey);

    if (!license) {
      return res.status(404).json({ error: "license_not_found" });
    }

    const { data: orderRows } = await supabase
      .from("payment_orders")
      .select("*")
      .eq("linked_license_id", license.id)
      .order("created_at", { ascending: false })
      .limit(10);

    const { data: activationRows } = await supabase
      .from("activations")
      .select("*")
      .eq("license_key", license.license_key)
      .order("created_at", { ascending: false })
      .limit(25);

    return res.json({
      license,
      orders: orderRows || [],
      activations: activationRows || []
    });
  } catch (err) {
    console.error("Get license details route error:", err);
    return res.status(500).json({ error: "get_license_failed" });
  }
});

app.post("/admin/licenses/create", requireAdmin, async (req, res) => {
  try {
    const {
      license_key,
      email,
      discord,
      plan,
      status,
      payment_required,
      payment_status,
      notes
    } = req.body;

    const planCode = safeTrim(plan) || "monthly";
    const planRow = await getPlanByCode(planCode);

    let resolvedLicenseKey = safeTrim(license_key);
    if (!resolvedLicenseKey) {
      const { data, error } = await supabase.rpc("generate_license_key", {
        prefix: "VTS"
      });

      if (error) throw error;
      resolvedLicenseKey = data;
    }

    let expiresAt = null;
    let planId = null;

    if (planRow) {
      planId = planRow.id;
      if (Number.isInteger(planRow.duration_days)) {
        expiresAt = addDaysToIso(new Date().toISOString(), planRow.duration_days);
      }
    }

    const insertPayload = {
      license_key: resolvedLicenseKey,
      hwid: null,
      email: safeTrim(email),
      discord: safeTrim(discord),
      plan: planCode,
      plan_id: planId,
      status: safeTrim(status) || "active",
      expires_at: expiresAt,
      payment_required: normalizeBoolean(payment_required),
      payment_status: safeTrim(payment_status) || "unpaid",
      notes: safeTrim(notes),
      created_manually: true,
      issued_by: "admin_dashboard",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from("licenses")
      .insert(insertPayload)
      .select("*")
      .single();

    if (error) throw error;

    await insertAdminAudit("create_license", "license", resolvedLicenseKey, {
      email: insertPayload.email,
      plan: insertPayload.plan,
      status: insertPayload.status
    });

    return res.json({ success: true, license: data });
  } catch (err) {
    console.error("Create license route error:", err);
    return res.status(500).json({
      error: "create_license_failed",
      details: err.message
    });
  }
});

app.post("/admin/licenses/reset-hwid", requireAdmin, async (req, res) => {
  try {
    const { license_key } = req.body;

    if (!license_key) {
      return res.status(400).json({ error: "missing_license_key" });
    }

    const { error } = await supabase
      .from("licenses")
      .update({
        hwid: null,
        gpu_name: null,
        gpu_driver_version: null,
        gpu_raw_driver_version: null,
        gpu_is_laptop: null,
        last_gpu_reported_at: null,
        suggested_driver_status: null,
        suggested_driver_latest: null,
        suggested_driver_download_url: null,
        suggested_driver_checked_at: null,
        approved_driver_latest: null,
        approved_driver_download_url: null,
        driver_note: null,
        last_activated_at: null,
        updated_at: new Date().toISOString()
      })
      .eq("license_key", license_key);

    if (error) throw error;

    await insertAdminAudit("reset_hwid", "license", license_key, { license_key });

    return res.json({ success: true });
  } catch (err) {
    console.error("Reset HWID route error:", err);
    return res.status(500).json({ error: "reset_hwid_failed" });
  }
});

app.post("/admin/licenses/set-maintenance", requireAdmin, async (req, res) => {
  try {
    const {
      license_key,
      recommended_maintenance,
      recommended_maintenance_message
    } = req.body;

    if (!license_key) {
      return res.status(400).json({ error: "missing_license_key" });
    }

    const updatePayload = {
      recommended_maintenance: Boolean(recommended_maintenance),
      recommended_maintenance_message:
        typeof recommended_maintenance_message === "string" &&
        recommended_maintenance_message.trim()
          ? recommended_maintenance_message.trim()
          : null,
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase
      .from("licenses")
      .update(updatePayload)
      .eq("license_key", license_key);

    if (error) throw error;

    await insertAdminAudit("set_maintenance", "license", license_key, {
      license_key,
      recommended_maintenance: updatePayload.recommended_maintenance
    });

    return res.json({
      success: true,
      recommended_maintenance: updatePayload.recommended_maintenance,
      recommended_maintenance_message:
        updatePayload.recommended_maintenance_message
    });
  } catch (err) {
    console.error("Set maintenance route error:", err);
    return res.status(500).json({ error: "set_maintenance_failed" });
  }
});

app.post("/admin/licenses/clear-maintenance", requireAdmin, async (req, res) => {
  try {
    const { license_key } = req.body;

    if (!license_key) {
      return res.status(400).json({ error: "missing_license_key" });
    }

    const { error } = await supabase
      .from("licenses")
      .update({
        recommended_maintenance: false,
        recommended_maintenance_message: null,
        updated_at: new Date().toISOString()
      })
      .eq("license_key", license_key);

    if (error) throw error;

    await insertAdminAudit("clear_maintenance", "license", license_key, {
      license_key
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Clear maintenance route error:", err);
    return res.status(500).json({ error: "clear_maintenance_failed" });
  }
});

app.post("/admin/licenses/revoke", requireAdmin, async (req, res) => {
  try {
    const { license_key } = req.body;

    if (!license_key) {
      return res.status(400).json({ error: "missing_license_key" });
    }

    const { error } = await supabase
      .from("licenses")
      .update({
        status: "inactive",
        updated_at: new Date().toISOString()
      })
      .eq("license_key", license_key);

    if (error) throw error;

    await insertAdminAudit("revoke_license", "license", license_key, {
      license_key
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Revoke route error:", err);
    return res.status(500).json({ error: "revoke_failed" });
  }
});

app.post("/admin/licenses/set-discord", requireAdmin, async (req, res) => {
  try {
    const { license_key, discord } = req.body;

    if (!license_key) {
      return res.status(400).json({ error: "missing_license_key" });
    }

    const discordValue =
      typeof discord === "string" && discord.trim() ? discord.trim() : null;

    const { error } = await supabase
      .from("licenses")
      .update({
        discord: discordValue,
        updated_at: new Date().toISOString()
      })
      .eq("license_key", license_key);

    if (error) throw error;

    await insertAdminAudit("set_discord", "license", license_key, {
      license_key,
      discord: discordValue
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Set discord route error:", err);
    return res.status(500).json({ error: "set_discord_failed" });
  }
});

app.post("/admin/licenses/extend-expiry", requireAdmin, async (req, res) => {
  try {
    const { license_key, days } = req.body;

    if (!license_key || !Number.isFinite(Number(days))) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const extraDays = Number.parseInt(days, 10);
    if (extraDays <= 0) {
      return res.status(400).json({ error: "invalid_days" });
    }

    const license = await getLicenseByKey(license_key);
    if (!license) {
      return res.status(404).json({ error: "license_not_found" });
    }

    const baseDate =
      license.expires_at && new Date(license.expires_at) > new Date()
        ? license.expires_at
        : new Date().toISOString();

    const newExpiry = addDaysToIso(baseDate, extraDays);

    const { data, error } = await supabase
      .from("licenses")
      .update({
        expires_at: newExpiry,
        updated_at: new Date().toISOString()
      })
      .eq("license_key", license_key)
      .select("*")
      .single();

    if (error) throw error;

    await insertAdminAudit("extend_expiry", "license", license_key, {
      license_key,
      days: extraDays,
      new_expiry: newExpiry
    });

    return res.json({ success: true, license: data });
  } catch (err) {
    console.error("Extend expiry route error:", err);
    return res.status(500).json({ error: "extend_expiry_failed" });
  }
});

app.post("/admin/licenses/change-plan", requireAdmin, async (req, res) => {
  try {
    const { license_key, plan } = req.body;

    if (!license_key || !plan) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const license = await getLicenseByKey(license_key);
    if (!license) {
      return res.status(404).json({ error: "license_not_found" });
    }

    const planRow = await getPlanByCode(plan);
    if (!planRow) {
      return res.status(404).json({ error: "plan_not_found" });
    }

    let expiresAt = license.expires_at;

    if (Number.isInteger(planRow.duration_days)) {
      expiresAt = addDaysToIso(new Date().toISOString(), planRow.duration_days);
    } else if (planRow.code.toLowerCase() === "lifetime") {
      expiresAt = null;
    }

    const { data, error } = await supabase
      .from("licenses")
      .update({
        plan: planRow.code,
        plan_id: planRow.id,
        expires_at: expiresAt,
        updated_at: new Date().toISOString()
      })
      .eq("license_key", license_key)
      .select("*")
      .single();

    if (error) throw error;

    await insertAdminAudit("change_plan", "license", license_key, {
      license_key,
      old_plan: license.plan,
      new_plan: planRow.code
    });

    return res.json({ success: true, license: data });
  } catch (err) {
    console.error("Change plan route error:", err);
    return res.status(500).json({ error: "change_plan_failed" });
  }
});

app.post("/admin/licenses/set-payment-status", requireAdmin, async (req, res) => {
  try {
    const { license_key, payment_status, payment_required } = req.body;

    if (!license_key || !payment_status) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const { data, error } = await supabase
      .from("licenses")
      .update({
        payment_status,
        ...(payment_required !== undefined
          ? { payment_required: normalizeBoolean(payment_required) }
          : {}),
        updated_at: new Date().toISOString()
      })
      .eq("license_key", license_key)
      .select("*")
      .single();

    if (error) throw error;

    await insertAdminAudit("set_payment_status", "license", license_key, {
      license_key,
      payment_status
    });

    return res.json({ success: true, license: data });
  } catch (err) {
    console.error("Set payment status route error:", err);
    return res.status(500).json({ error: "set_payment_status_failed" });
  }
});

app.post("/admin/licenses/link-order", requireAdmin, async (req, res) => {
  try {
    const { license_key, order_id } = req.body;

    if (!license_key || !order_id) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const license = await getLicenseByKey(license_key);
    if (!license) {
      return res.status(404).json({ error: "license_not_found" });
    }

    const { data: order, error: orderError } = await supabase
      .from("payment_orders")
      .select("*")
      .eq("id", order_id)
      .single();

    if (orderError || !order) {
      return res.status(404).json({ error: "order_not_found" });
    }

    const nowIso = new Date().toISOString();

    const { error: licenseError } = await supabase
      .from("licenses")
      .update({
        source_order_id: order.id,
        payment_status: order.status === "paid" ? "paid" : license.payment_status,
        updated_at: nowIso
      })
      .eq("id", license.id);

    if (licenseError) throw licenseError;

    const { error: orderUpdateError } = await supabase
      .from("payment_orders")
      .update({
        linked_license_id: license.id,
        updated_at: nowIso
      })
      .eq("id", order.id);

    if (orderUpdateError) throw orderUpdateError;

    await insertAdminAudit("link_order", "license", license_key, {
      license_key,
      order_id: order.id
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Link order route error:", err);
    return res.status(500).json({ error: "link_order_failed" });
  }
});

app.get("/admin/orders", requireAdmin, async (req, res) => {
  try {
    const limit = normalizePositiveInteger(req.query.limit, 100);
    const offset = Math.max(normalizePositiveInteger(req.query.offset, 0) || 0, 0);

    let query = supabase
      .from("payment_orders")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    const status = safeTrim(req.query.status);
    const provider = safeTrim(req.query.provider);
    const linked = safeTrim(req.query.linked);
    const q = safeTrim(req.query.q);

    if (status) query = query.eq("status", status);
    if (provider) query = query.eq("provider", provider);
    if (linked === "linked") query = query.not("linked_license_id", "is", null);
    if (linked === "unlinked") query = query.is("linked_license_id", null);
    if (q) {
      query = query.or(
        `order_ref.ilike.%${q}%,email.ilike.%${q}%,discord.ilike.%${q}%,provider_order_id.ilike.%${q}%,provider_payment_id.ilike.%${q}%`
      );
    }

    const { data, error, count } = await query;

    if (error) throw error;

    return res.json({
      items: data || [],
      total: count || 0,
      limit,
      offset
    });
  } catch (err) {
    console.error("List orders route error:", err);
    return res.status(500).json({ error: "list_orders_failed" });
  }
});

app.get("/admin/orders/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);

    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "invalid_order_id" });
    }

    const { data, error } = await supabase
      .from("payment_orders")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "order_not_found" });
    }

    return res.json(data);
  } catch (err) {
    console.error("Get order route error:", err);
    return res.status(500).json({ error: "get_order_failed" });
  }
});

app.post("/admin/orders/link-license", requireAdmin, async (req, res) => {
  try {
    const { order_id, license_key } = req.body;

    if (!order_id || !license_key) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const license = await getLicenseByKey(license_key);
    if (!license) {
      return res.status(404).json({ error: "license_not_found" });
    }

    const { data: order, error: orderError } = await supabase
      .from("payment_orders")
      .select("*")
      .eq("id", order_id)
      .single();

    if (orderError || !order) {
      return res.status(404).json({ error: "order_not_found" });
    }

    const nowIso = new Date().toISOString();

    const { error: orderUpdateError } = await supabase
      .from("payment_orders")
      .update({
        linked_license_id: license.id,
        updated_at: nowIso
      })
      .eq("id", order_id);

    if (orderUpdateError) throw orderUpdateError;

    const licenseUpdates = {
      source_order_id: order_id,
      updated_at: nowIso
    };

    if (order.status === "paid") {
      licenseUpdates.payment_status = "paid";
    }

    const { error: licenseUpdateError } = await supabase
      .from("licenses")
      .update(licenseUpdates)
      .eq("id", license.id);

    if (licenseUpdateError) throw licenseUpdateError;

    await insertAdminAudit("link_license_to_order", "order", String(order_id), {
      order_id,
      license_key
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Orders link license route error:", err);
    return res.status(500).json({ error: "orders_link_license_failed" });
  }
});

app.post("/admin/orders/set-status", requireAdmin, async (req, res) => {
  try {
    const { order_id, status } = req.body;

    if (!order_id || !status) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const updatePayload = {
      status,
      updated_at: new Date().toISOString()
    };

    if (status === "paid") {
      updatePayload.paid_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from("payment_orders")
      .update(updatePayload)
      .eq("id", order_id)
      .select("*")
      .single();

    if (error) throw error;

    if (data.linked_license_id && status === "paid") {
      await supabase
        .from("licenses")
        .update({
          payment_status: "paid",
          source_order_id: data.id,
          updated_at: new Date().toISOString()
        })
        .eq("id", data.linked_license_id);
    }

    await insertAdminAudit("set_order_status", "order", String(order_id), {
      order_id,
      status
    });

    return res.json({ success: true, order: data });
  } catch (err) {
    console.error("Set order status route error:", err);
    return res.status(500).json({ error: "set_order_status_failed" });
  }
});

app.get("/admin/license-audit", requireAdmin, async (req, res) => {
  try {
    const limit = normalizePositiveInteger(req.query.limit, 100);

    const { data, error } = await supabase
      .from("license_audit_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    return res.json(data || []);
  } catch (err) {
    console.error("License audit route error:", err);
    return res.status(500).json({ error: "license_audit_failed" });
  }
});

app.get("/admin/admin-audit", requireAdmin, async (req, res) => {
  try {
    const limit = normalizePositiveInteger(req.query.limit, 100);

    const { data, error } = await supabase
      .from("admin_audit_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    return res.json(data || []);
  } catch (err) {
    console.error("Admin audit route error:", err);
    return res.status(500).json({ error: "admin_audit_failed" });
  }
});

app.get("/admin/drivers", requireAdmin, async (req, res) => {
  try {
    let query = supabase
      .from("licenses")
      .select(
        "id, license_key, email, discord, gpu_name, gpu_driver_version, gpu_raw_driver_version, gpu_is_laptop, last_gpu_reported_at, approved_driver_download_url, approved_driver_latest, driver_note, suggested_driver_status, suggested_driver_latest, suggested_driver_download_url, suggested_driver_checked_at, recommended_maintenance, recommended_maintenance_message"
      )
      .order("last_gpu_reported_at", { ascending: false });

    const status = safeTrim(req.query.status);
    if (status) {
      if (status === "none") {
        query = query.is("suggested_driver_status", null);
      } else {
        query = query.eq("suggested_driver_status", status);
      }
    }

    const { data, error } = await query.limit(200);

    if (error) throw error;

    return res.json(data || []);
  } catch (err) {
    console.error("Drivers route error:", err);
    return res.status(500).json({ error: "drivers_failed" });
  }
});

app.post("/admin/drivers/set-approved", requireAdmin, async (req, res) => {
  try {
    const {
      license_key,
      approved_driver_latest,
      approved_driver_download_url,
      driver_note
    } = req.body;

    if (!license_key) {
      return res.status(400).json({ error: "missing_license_key" });
    }

    const updatePayload = {
      updated_at: new Date().toISOString()
    };

    if (approved_driver_latest !== undefined) {
      updatePayload.approved_driver_latest = safeTrim(approved_driver_latest);
    }

    if (approved_driver_download_url !== undefined) {
      updatePayload.approved_driver_download_url = safeTrim(
        approved_driver_download_url
      );
    }

    if (driver_note !== undefined) {
      updatePayload.driver_note = safeTrim(driver_note);
    }

    const { data, error } = await supabase
      .from("licenses")
      .update(updatePayload)
      .eq("license_key", license_key)
      .select("*")
      .single();

    if (error) throw error;

    await insertAdminAudit("set_approved_driver", "license", license_key, {
      license_key,
      approved_driver_latest: updatePayload.approved_driver_latest || null
    });

    return res.json({ success: true, license: data });
  } catch (err) {
    console.error("Set approved driver route error:", err);
    return res.status(500).json({ error: "set_approved_driver_failed" });
  }
});

app.post("/admin/drivers/clear-suggested", requireAdmin, async (req, res) => {
  try {
    const { license_key } = req.body;

    if (!license_key) {
      return res.status(400).json({ error: "missing_license_key" });
    }

    const { data, error } = await supabase
      .from("licenses")
      .update({
        suggested_driver_status: null,
        suggested_driver_latest: null,
        suggested_driver_download_url: null,
        suggested_driver_checked_at: null,
        updated_at: new Date().toISOString()
      })
      .eq("license_key", license_key)
      .select("*")
      .single();

    if (error) throw error;

    await insertAdminAudit("clear_suggested_driver", "license", license_key, {
      license_key
    });

    return res.json({ success: true, license: data });
  } catch (err) {
    console.error("Clear suggested driver route error:", err);
    return res.status(500).json({ error: "clear_suggested_driver_failed" });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Voltech Shield license server running on port ${PORT}`);
});
