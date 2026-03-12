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
    version: "0.1.2",
    notes: "Small UI update test.",
    url: "https://github.com/VoltechFPS-Code/VoltechShieldUpdates/releases/download/v0.1.1/VoltechShield_0.1.1_x64-setup.exe"
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


