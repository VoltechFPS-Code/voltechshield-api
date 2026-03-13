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

function isDirectNvidiaDownloadUrl(url) {
  if (!url || typeof url !== "string") return false;

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    const allowedHosts = [
      "international.download.nvidia.com",
      "us.download.nvidia.com",
      "download.nvidia.com"
    ];

    const hostAllowed = allowedHosts.some((host) => hostname === host);
    const isExe = pathname.endsWith(".exe");
    const isGenericDriverPage =
      pathname.includes("/download/index.aspx") ||
      pathname.includes("/drivers") ||
      pathname.includes("/download/driverresults.aspx");

    return hostAllowed && isExe && !isGenericDriverPage;
  } catch {
    return false;
  }
}

function normalizeGeminiDriverResult(result) {
  if (!result || typeof result !== "object") {
    return {
      status: "unknown",
      latest: null,
      download_url: null,
      note: "Gemini returned no structured result."
    };
  }

  const normalizedStatus =
    result.status === "outdated" || result.status === "up-to-date" || result.status === "unknown"
      ? result.status
      : "unknown";

  const normalizedLatest =
    typeof result.latest === "string" && result.latest.trim().length > 0
      ? result.latest.trim()
      : null;

  const rawUrl =
    typeof result.download_url === "string" && result.download_url.trim().length > 0
      ? result.download_url.trim()
      : null;

  const normalizedUrl = isDirectNvidiaDownloadUrl(rawUrl) ? rawUrl : null;

  let normalizedNote =
    typeof result.note === "string" && result.note.trim().length > 0
      ? result.note.trim()
      : "";

  if (rawUrl && !normalizedUrl) {
    normalizedNote =
      normalizedNote ||
      "Gemini returned a non-direct NVIDIA page, so the link was rejected.";
  }

  if (normalizedStatus === "outdated" && !normalizedUrl) {
    normalizedNote =
      normalizedNote ||
      "A newer driver may exist, but no direct NVIDIA installer URL was verified.";
  }

  return {
    status: normalizedStatus,
    latest: normalizedLatest,
    download_url: normalizedUrl,
    note: normalizedNote || null
  };
}

async function lookupDriverWithGemini({ gpu_name, gpu_driver_version, gpu_is_laptop }) {
  if (!process.env.GEMINI_API_KEY) {
    return null;
  }

  const prompt = `
You are checking NVIDIA driver availability.

Use Google Search and return only valid JSON.

GPU Name: ${gpu_name}
Installed Driver Version: ${gpu_driver_version}
Platform: ${gpu_is_laptop ? "Laptop / Notebook" : "Desktop"}

Rules:
1. Search only for the correct NVIDIA driver for this exact GPU family and platform.
2. Prefer WHQL drivers from NVIDIA.
3. If the installed driver is already current, set status to "up-to-date".
4. If a newer driver exists, set status to "outdated".
5. If uncertain, set status to "unknown".
6. ONLY return a direct downloadable NVIDIA installer URL that points to a .exe file on a download host such as international.download.nvidia.com.
7. DO NOT return generic NVIDIA pages like:
   - https://www.nvidia.com/Download/index.aspx
   - driver search pages
   - landing pages
8. If you cannot find a direct .exe installer URL with confidence, set download_url to an empty string.
9. Return only valid JSON.

JSON format:
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
        tools: [{ google_search: {} }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
          thinkingConfig: {
            thinkingLevel: "low"
          }
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
  const normalized = normalizeGeminiDriverResult(parsed);

  console.log("Gemini raw text:", text);
  console.log("Gemini normalized result:", normalized);

  return normalized;
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
    version: "0.1.3",
    notes: "Small UI update test.",
    url: "https://github.com/VoltechFPS-Code/VoltechShieldUpdates/releases/download/v0.1.3/VoltechShield_0.1.3_x64-setup.exe"
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

    if (licenseRow.status !== "active") {
      await supabase.from("activations").insert({
        license_key: license,
        hwid,
        result: "inactive",
        app_version: app_version || null
      });

      return res.json({ valid: false, reason: "inactive" });
    }

    if (licenseRow.expires_at && new Date(licenseRow.expires_at) < new Date()) {
      await supabase.from("activations").insert({
        license_key: license,
        hwid,
        result: "expired",
        app_version: app_version || null
      });

      return res.json({ valid: false, reason: "expired" });
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
          license_key: license,
          hwid,
          result: "bind_failed",
          app_version: app_version || null
        });

        return res.json({ valid: false, reason: "bind_failed" });
      }

      await supabase.from("activations").insert({
        license_key: license,
        hwid,
        result: "first_activation_success",
        app_version: app_version || null
      });

      return res.json({ valid: true, reason: "first_activation_success" });
    }

    if (licenseRow.hwid !== hwid) {
      await supabase.from("activations").insert({
        license_key: license,
        hwid,
        result: "hwid_mismatch",
        app_version: app_version || null
      });

      return res.json({ valid: false, reason: "hwid_mismatch" });
    }

    await supabase
      .from("licenses")
      .update({
        last_validated_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("license_key", license);

    await supabase.from("activations").insert({
      license_key: license,
      hwid,
      result: "validation_success",
      app_version: app_version || null
    });

    return res.json({ valid: true, reason: "validation_success" });
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
      suggested_driver_status: suggested?.status || licenseRow.suggested_driver_status || null,
      suggested_driver_latest: suggested?.latest || licenseRow.suggested_driver_latest || null,
      suggested_driver_download_url:
        suggested?.download_url || licenseRow.suggested_driver_download_url || null,
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

    const preferredNote =
      refreshedLicense.driver_note ||
      null;

    const driverUpdateAvailable =
      Boolean(preferredUrl) &&
      (
        Boolean(refreshedLicense.approved_driver_download_url) ||
        refreshedLicense.suggested_driver_status === "outdated"
      );

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
    const { count: totalLicenses } = await supabase
      .from("licenses")
      .select("*", { count: "exact", head: true });

    const { count: activeLicenses } = await supabase
      .from("licenses")
      .select("*", { count: "exact", head: true })
      .eq("status", "active");

    const { count: totalActivations } = await supabase
      .from("activations")
      .select("*", { count: "exact", head: true });

    const { count: recentSuccesses } = await supabase
      .from("activations")
      .select("*", { count: "exact", head: true })
      .eq("result", "validation_success");

    return res.json({
      totalLicenses: totalLicenses || 0,
      activeLicenses: activeLicenses || 0,
      totalActivations: totalActivations || 0,
      recentSuccesses: recentSuccesses || 0
    });
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
      .limit(25);

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

    if (!q) {
      return res.json([]);
    }

    const { data, error } = await supabase
      .from("licenses")
      .select("*")
      .or(`license_key.ilike.%${q}%,hwid.ilike.%${q}%`)
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

    if (!license_key) {
      return res.status(400).json({ error: "missing_license_key" });
    }

    const { error } = await supabase
      .from("licenses")
      .update({
        hwid: null,
        updated_at: new Date().toISOString()
      })
      .eq("license_key", license_key);

    if (error) throw error;

    return res.json({ success: true });
  } catch (err) {
    console.error("Reset HWID route error:", err);
    return res.status(500).json({ error: "reset_hwid_failed" });
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

    return res.json({ success: true });
  } catch (err) {
    console.error("Revoke route error:", err);
    return res.status(500).json({ error: "revoke_failed" });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Voltech Shield license server running on port ${PORT}`);
}); 
::contentReference[oaicite:1]{index=1}

