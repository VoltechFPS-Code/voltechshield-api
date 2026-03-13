require("dotenv").config();

const express = require("express");
const cors = require("cors");
const https = require("https");
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

const GEMINI_TIMEOUT_MS = 25000;
const DRIVER_SUGGESTION_COOLDOWN_MS = 6 * 60 * 60 * 1000;

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

function constructNvidiaUrl(version, isLaptop) {
  if (!version) return null;

  const cleanVersion = version.replace(/[^0-9.]/g, "");
  if (!cleanVersion) return null;

  const type = isLaptop ? "notebook" : "desktop";

  return `https://us.download.nvidia.com/Windows/${cleanVersion}/${cleanVersion}-${type}-win10-win11-64bit-international-dch-whql.exe`;
}

function normalizeGeminiDriverResult(result, isLaptop) {
  if (!result || typeof result !== "object") {
    return {
      status: "unknown",
      latest: null,
      download_url: null,
      note: "Gemini returned no structured result."
    };
  }

  const normalizedStatus =
    result.status === "outdated" ||
    result.status === "up-to-date" ||
    result.status === "unknown"
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

  let normalizedUrl = isDirectNvidiaDownloadUrl(rawUrl) ? rawUrl : null;

  let usedFallback = false;
  if (!normalizedUrl && normalizedLatest && normalizedStatus === "outdated") {
    const constructed = constructNvidiaUrl(normalizedLatest, isLaptop);
    if (constructed && isDirectNvidiaDownloadUrl(constructed)) {
      normalizedUrl = constructed;
      usedFallback = true;
    }
  }

  let normalizedNote =
    typeof result.note === "string" && result.note.trim().length > 0
      ? result.note.trim()
      : "";

  if (usedFallback) {
    normalizedNote =
      "Constructed official NVIDIA direct link based on the latest discovered version.";
  } else if (rawUrl && !normalizedUrl) {
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

function getPreferredDriverFields(licenseRow) {
  const preferredUrl =
    licenseRow.approved_driver_download_url ||
    licenseRow.suggested_driver_download_url ||
    null;

  const preferredLatest =
    licenseRow.approved_driver_latest ||
    licenseRow.suggested_driver_latest ||
    null;

  const preferredNote =
    licenseRow.driver_note ||
    null;

  const preferredStatus =
    licenseRow.approved_driver_download_url
      ? "outdated"
      : licenseRow.suggested_driver_status || "unknown";

  const driverUpdateAvailable =
    Boolean(preferredUrl) &&
    (
      Boolean(licenseRow.approved_driver_download_url) ||
      licenseRow.suggested_driver_status === "outdated"
    );

  return {
    driver_update_available: driverUpdateAvailable,
    driver_download_url: preferredUrl,
    driver_note: preferredNote,
    driver_latest_version: preferredLatest,
    driver_status: preferredStatus
  };
}

function shouldRefreshDriverSuggestion(licenseRow, gpu_name, gpu_driver_version) {
  if (!gpu_name || !gpu_driver_version) return false;
  if (!gpu_name.toLowerCase().includes("nvidia")) return false;

  if (licenseRow.approved_driver_download_url) {
    return false;
  }

  const checkedAt = licenseRow.suggested_driver_checked_at
    ? new Date(licenseRow.suggested_driver_checked_at).getTime()
    : 0;

  const now = Date.now();
  const recentlyChecked =
    checkedAt && now - checkedAt < DRIVER_SUGGESTION_COOLDOWN_MS;

  const sameGpu =
    (licenseRow.gpu_name || "") === gpu_name &&
    (licenseRow.gpu_driver_version || "") === gpu_driver_version;

  if (recentlyChecked && sameGpu) {
    return false;
  }

  return true;
}

function postGeminiHttps(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);

    const req = https.request(
      {
        hostname: "generativelanguage.googleapis.com",
        path: `/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${process.env.GEMINI_API_KEY}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (res) => {
        let raw = "";

        res.on("data", (chunk) => {
          raw += chunk;
        });

        res.on("end", () => {
          const statusCode = res.statusCode || 500;

          if (statusCode < 200 || statusCode >= 300) {
            return reject(new Error(`Gemini HTTP ${statusCode} // ${raw}`));
          }

          try {
            const parsed = JSON.parse(raw);
            resolve(parsed);
          } catch (err) {
            reject(new Error(`Gemini JSON parse failed // ${String(err)} // ${raw}`));
          }
        });
      }
    );

    req.setTimeout(GEMINI_TIMEOUT_MS, () => {
      req.destroy(new Error("Gemini request timed out"));
    });

    req.on("error", (err) => {
      reject(err);
    });

    req.write(payload);
    req.end();
  });
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
You are a specialized hardware assistant for VoltechShield.
Current Date: ${new Date().toDateString()}
Target GPU: ${gpu_name} (${gpu_is_laptop ? "Laptop / Notebook" : "Desktop"})
Installed Driver Version: ${gpu_driver_version}

Task:
1. Use Google Search to find the absolute latest NVIDIA Game Ready Driver (WHQL) version for this exact GPU family and platform.
2. Specifically look for results on nvidia.com or trusted hardware news sites regarding the latest version.
3. Compare the found version with the installed version (${gpu_driver_version}).
4. If the installed driver is already current, set status to "up-to-date".
5. If a newer driver exists, set status to "outdated".
6. Provide the direct download URL if you can find it. NVIDIA direct links usually follow this pattern:
   https://us.download.nvidia.com/Windows/[version]/[version]-${gpu_is_laptop ? "notebook" : "desktop"}-win10-win11-64bit-international-dch-whql.exe

Return ONLY valid JSON.

JSON format:
{
  "status": "outdated" or "up-to-date" or "unknown",
  "latest": "xxx.xx",
  "download_url": "https://us.download.nvidia.com/...",
  "note": "short explanation"
}
`.trim();

  const data = await postGeminiHttps({
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
  });

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("") || "";

  const parsed = jsonFromGeminiText(text);
  const normalized = normalizeGeminiDriverResult(parsed, gpu_is_laptop);

  console.log("Gemini raw text:", text);
  console.log("Gemini normalized result:", normalized);

  return normalized;
}

async function refreshDriverSuggestionInBackground({
  licenseRow,
  license,
  gpu_name,
  gpu_driver_version,
  gpu_is_laptop
}) {
  try {
    const suggested = await lookupDriverWithGemini({
      gpu_name,
      gpu_driver_version,
      gpu_is_laptop: Boolean(gpu_is_laptop)
    });

    if (!suggested) {
      await supabase
        .from("licenses")
        .update({
          suggested_driver_checked_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq("license_key", license);

      return;
    }

    const suggestedPayload = {
      suggested_driver_status: suggested.status || null,
      suggested_driver_latest: suggested.latest || null,
      suggested_driver_download_url: suggested.download_url || null,
      suggested_driver_checked_at: new Date().toISOString(),
      driver_note: licenseRow.driver_note || suggested.note || null,
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase
      .from("licenses")
      .update(suggestedPayload)
      .eq("license_key", license);

    if (error) {
      console.error("Background suggested driver update error:", error);
    }
  } catch (err) {
    console.error("Background Gemini lookup error:", err);

    await supabase
      .from("licenses")
      .update({
        suggested_driver_checked_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("license_key", license);
  }
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

    const mergedLicense = {
      ...licenseRow,
      ...updatePayload
    };

    const responsePayload = getPreferredDriverFields(mergedLicense);

    if (shouldRefreshDriverSuggestion(licenseRow, gpu_name, gpu_driver_version)) {
      refreshDriverSuggestionInBackground({
        licenseRow,
        license,
        gpu_name,
        gpu_driver_version,
        gpu_is_laptop: Boolean(gpu_is_laptop)
      }).catch((err) => {
        console.error("Detached background refresh error:", err);
      });
    }

    return res.json({
      ok: true,
      gpu_name,
      gpu_driver_version,
      ...responsePayload
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
