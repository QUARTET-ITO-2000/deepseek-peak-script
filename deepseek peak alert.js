// DeepSeek Peak-Hour Pricing Alert - Quantumult X + BoxJs
//
// Data source: https://deepseek-peak-hours.sivaram.dev/api/status
// That endpoint returns the official UTC peak-hour schedule and notes the
// schedule is static, so it should be cached and computed locally instead
// of being polled on every run. This script only re-syncs the schedule
// every sync_interval_hours (default 24h); every other run just compares
// the cached schedule against the current time.
//
// Features:
// 1. Periodically syncs the official peak-hour schedule + multiplier into BoxJs
// 2. Each run checks current time against the cached schedule
// 3. Notifies once right when the state (peak/off-peak) actually flips
// 4. Notifies once N minutes ahead of the next flip (de-duplicated per exact
//    boundary timestamp, so the two daily peak windows don't clash)
// 5. All parameters are stored in BoxJs and editable without touching code
//
// Setup: add to QX's [task_local], e.g. running every 5 minutes:
// (5-minute-interval) * * * * https://your-host/deepseek_peak_alert.js, tag=DeepSeek Peak Alert, enabled=true
// (see deepseek_peak_gallery.json for the exact cron line to paste)

const KEY_PREFIX = "ds_peak_"
const STATUS_API = "https://deepseek-peak-hours.sivaram.dev/api/status"

// Fallback defaults in case a sync has never succeeded (per the source site's
// data at the time this was written).
const DEFAULT_WINDOWS = [
  { start: "01:00", end: "04:00" },
  { start: "06:00", end: "10:00" },
]
const DEFAULT_MULTIPLIER = "2"

function getConfig(key, fallback) {
  const v = $prefs.valueForKey(KEY_PREFIX + key)
  return v !== undefined && v !== null && v !== "" ? v : fallback
}

function setConfig(key, value) {
  $prefs.setValueForKey(String(value), KEY_PREFIX + key)
}

function toMinutesOfDay(hhmm) {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}

function loadWindows() {
  try {
    const raw = getConfig("windows_utc", "")
    const parsed = raw ? JSON.parse(raw) : DEFAULT_WINDOWS
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_WINDOWS
  } catch (e) {
    return DEFAULT_WINDOWS
  }
}

function isPeakNow(windows, nowMin) {
  return windows.some(
    (w) => nowMin >= toMinutesOfDay(w.start) && nowMin < toMinutesOfDay(w.end)
  )
}

// Find the absolute timestamp of the next window boundary (entering or
// leaving peak). Works correctly across midnight.
function nextBoundaryEpoch(windows) {
  const now = new Date()
  const nowTs = now.getTime()
  const epochs = []
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    windows.forEach((w) => {
      ;[w.start, w.end].forEach((hhmm) => {
        const [h, m] = hhmm.split(":").map(Number)
        const t = Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() + dayOffset,
          h,
          m,
          0
        )
        epochs.push(t)
      })
    })
  }
  const future = epochs.filter((t) => t > nowTs).sort((a, b) => a - b)
  return future[0]
}

function applyScheduleResponse(body) {
  try {
    const data = JSON.parse(body)
    const sched = data.schedule
    if (sched && Array.isArray(sched.peak_windows_utc)) {
      const windows = sched.peak_windows_utc.map((s) => {
        const [start, end] = s.split("-")
        return { start, end }
      })
      setConfig("windows_utc", JSON.stringify(windows))
      setConfig("multiplier", String(sched.peak_multiplier_vs_off_peak || DEFAULT_MULTIPLIER))
      console.log("[DeepSeek Peak Alert] schedule synced: " + JSON.stringify(windows) + " x" + (sched.peak_multiplier_vs_off_peak || DEFAULT_MULTIPLIER))
    } else {
      console.log("[DeepSeek Peak Alert] sync response had no usable schedule, keeping cached values")
    }
  } catch (e) {
    console.log("[DeepSeek Peak Alert] failed to parse sync response: " + (e && e.message ? e.message : e))
  }
}

function maybeSyncSchedule(done) {
  const lastSync = parseInt(getConfig("last_sync_ts", "0"), 10)
  const intervalHours = parseInt(getConfig("sync_interval_hours", "24"), 10) || 24
  const nowTs = Date.now()

  if (nowTs - lastSync < intervalHours * 3600 * 1000) {
    console.log(
      "[DeepSeek Peak Alert] skip sync, last synced " +
        Math.round((nowTs - lastSync) / 60000) +
        " min ago (interval=" +
        intervalHours +
        "h)"
    )
    done()
    return
  }

  const finish = () => {
    setConfig("last_sync_ts", String(nowTs))
    done()
  }

  // Feature-detect the HTTP API. Some QX contexts (older versions, certain
  // test/debug entry points) don't expose $httpClient at all; rather than
  // throwing "Can't find variable: $httpClient", just skip the sync and
  // keep using the cached/default schedule.
  if (typeof $httpClient !== "undefined" && typeof $httpClient.get === "function") {
    console.log("[DeepSeek Peak Alert] syncing schedule via $httpClient ...")
    try {
      $httpClient.get(STATUS_API, (err, resp, body) => {
        if (err) {
          console.log("[DeepSeek Peak Alert] $httpClient error: " + err)
        } else if (body) {
          applyScheduleResponse(body)
        }
        finish()
      })
    } catch (e) {
      console.log("[DeepSeek Peak Alert] $httpClient threw: " + (e && e.message ? e.message : e))
      finish()
    }
  } else if (typeof $task !== "undefined" && typeof $task.fetch === "function") {
    // Newer QX Promise-based API as a fallback.
    console.log("[DeepSeek Peak Alert] syncing schedule via $task.fetch ...")
    $task
      .fetch({ url: STATUS_API, method: "GET" })
      .then((resp) => {
        if (resp && resp.body) applyScheduleResponse(resp.body)
        finish()
      })
      .catch((e) => {
        console.log("[DeepSeek Peak Alert] $task.fetch error: " + (e && e.message ? e.message : e))
        finish()
      })
  } else {
    // No HTTP API available in this context at all; run on cached/default schedule.
    console.log("[DeepSeek Peak Alert] no HTTP API available, using cached/default schedule")
    finish()
  }
}

function main() {
  console.log("[DeepSeek Peak Alert] run start @ " + new Date().toISOString())

  if (getConfig("enable", "true") !== "true") {
    console.log("[DeepSeek Peak Alert] disabled via ds_peak_enable, skipping")
    $done()
    return
  }

  if (getConfig("force_test", "false") === "true") {
    console.log("[DeepSeek Peak Alert] force_test is on -> resetting cached state for a guaranteed test run")
    setConfig("last_state", "")
    setConfig("ahead_notified_epoch", "")
    setConfig("last_sync_ts", "0")
    setConfig("force_test", "false")
  }

  maybeSyncSchedule(() => {
    const windows = loadWindows()
    const multiplier = getConfig("multiplier", DEFAULT_MULTIPLIER)
    const ahead = parseInt(getConfig("ahead_minutes", "15"), 10) || 15

    console.log("[DeepSeek Peak Alert] windows_utc = " + JSON.stringify(windows))
    console.log("[DeepSeek Peak Alert] multiplier = " + multiplier + "x, ahead_minutes = " + ahead)

    const now = new Date()
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes()
    const peakNow = isPeakNow(windows, nowMin)
    const currentState = peakNow ? "peak" : "offpeak"
    const lastState = getConfig("last_state", "")

    console.log(
      "[DeepSeek Peak Alert] now_utc=" +
        now.toISOString() +
        " currentState=" +
        currentState +
        " lastState=" +
        (lastState || "(none)")
    )

    // 1. Notify once right when the state flips
    if (currentState !== lastState) {
      console.log("[DeepSeek Peak Alert] state flip detected -> sending notification")
      if (peakNow) {
        $notify(
          "DeepSeek · Peak pricing started",
          `Tokens now cost about ${multiplier}× the off-peak rate`,
          "Consider delaying non-urgent jobs until off-peak"
        )
      } else {
        $notify(
          "DeepSeek · Off-peak pricing started",
          "Back to base rate",
          "Good time to batch low-cost jobs"
        )
      }
      setConfig("last_state", currentState)
    } else {
      console.log("[DeepSeek Peak Alert] no state change since last run")
    }

    // 2. Notify N minutes ahead of the next flip (de-duplicated by the exact
    // boundary timestamp, so the two daily peak windows don't clash)
    const nextEpoch = nextBoundaryEpoch(windows)
    if (nextEpoch) {
      const minutesToNext = Math.round((nextEpoch - now.getTime()) / 60000)
      const notifiedEpoch = getConfig("ahead_notified_epoch", "")
      console.log(
        "[DeepSeek Peak Alert] next boundary @ " +
          new Date(nextEpoch).toISOString() +
          " (" +
          minutesToNext +
          " min away), already notified for this boundary: " +
          (notifiedEpoch === String(nextEpoch))
      )
      if (minutesToNext <= ahead && notifiedEpoch !== String(nextEpoch)) {
        console.log("[DeepSeek Peak Alert] within advance-warning window -> sending notification")
        if (peakNow) {
          $notify("DeepSeek reminder", `Peak pricing ends in about ${minutesToNext} min`, "")
        } else {
          $notify("DeepSeek reminder", `Peak pricing starts in about ${minutesToNext} min`, "Finish anything you don't want to pay double for")
        }
        setConfig("ahead_notified_epoch", String(nextEpoch))
      }
    } else {
      console.log("[DeepSeek Peak Alert] could not compute next boundary")
    }

    console.log("[DeepSeek Peak Alert] run end")
    $done()
  })
}

try {
  main()
} catch (e) {
  console.log("[DeepSeek Peak Alert] FATAL ERROR: " + (e && e.message ? e.message : e))
  $done()
}
