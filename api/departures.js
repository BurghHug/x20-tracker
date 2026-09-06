// Vercel serverless function: given a stop, returns the next X20 departures.
//
// Two of our four stops have confirmed ATCO codes (found directly on
// bustimes.org) and are queried straight away. The other two ("Henley High
// School" and "Bearley Oak Tree Close") don't have a verified code, so
// rather than guess and risk silently querying the wrong stop, this
// resolves the name to a code via TransportAPI's place search first, near
// the given lat/lon, and caches the result in memory for next time.
//
// Requires two environment variables (set in Vercel's dashboard, never
// committed to the repo): TRANSPORTAPI_APP_ID and TRANSPORTAPI_APP_KEY.
// Free tier: https://developer.transportapi.com (1000 requests/day).

const APP_ID = process.env.TRANSPORTAPI_APP_ID;
const APP_KEY = process.env.TRANSPORTAPI_APP_KEY;

// Module-level cache: persists across warm serverless invocations (not
// guaranteed across cold starts, but saves a lookup call most of the time).
const resolvedCodeCache = {};

async function resolveAtcoCode(name, lat, lon) {
  if (resolvedCodeCache[name]) return resolvedCodeCache[name];

  const url = `https://transportapi.com/v3/uk/places.json?query=${encodeURIComponent(name)}&lat=${lat}&lon=${lon}&type=bus_stop&app_id=${APP_ID}&app_key=${APP_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const member = Array.isArray(data.member) ? data.member[0] : null;
  const code = member ? (member.atcocode || member.id) : null;
  if (code) resolvedCodeCache[name] = code;
  return code;
}

// Confirmed directly from bustimes.org — no name resolution needed.
const KNOWN_STOPS = {
  maybird: { label: 'Stratford, Maybird Centre', atcocode: '4200F065902' },
  woodst:  { label: 'Stratford, Wood Street',    atcocode: '4200F067200' },
};

// Needs resolving by name — approximate coordinates given to disambiguate.
const LOOKUP_STOPS = {
  henleyhs: { label: 'Henley High School', query: 'Henley-in-Arden High School', lat: 52.2953, lon: -1.7746 },
  bearley:  { label: 'Bearley, Oak Tree Close', query: 'Bearley Oak Tree Close', lat: 52.2601, lon: -1.7513 },
};

export default async function handler(req, res) {
  if (!APP_ID || !APP_KEY) {
    res.status(500).json({ error: 'TransportAPI credentials are not configured on the server.' });
    return;
  }

  const { stop } = req.query;
  const known = KNOWN_STOPS[stop];
  const lookup = LOOKUP_STOPS[stop];

  if (!known && !lookup) {
    res.status(400).json({ error: 'Unknown stop id.' });
    return;
  }

  try {
    let atcocode, label;
    if (known) {
      atcocode = known.atcocode;
      label = known.label;
    } else {
      atcocode = await resolveAtcoCode(lookup.query, lookup.lat, lookup.lon);
      label = lookup.label;
      if (!atcocode) {
        res.status(200).json({ label, found: false, reason: 'Could not resolve this stop to a code yet.' });
        return;
      }
    }

    const liveUrl = `https://transportapi.com/v3/uk/bus/stop/${atcocode}/live.json?group=route&nextbuses=yes&route=X20&app_id=${APP_ID}&app_key=${APP_KEY}`;
    const liveRes = await fetch(liveUrl);
    if (!liveRes.ok) {
      res.status(200).json({ label, atcocode, found: false, reason: `upstream HTTP ${liveRes.status}` });
      return;
    }
    const liveData = await liveRes.json();
    const departures = (liveData.departures && liveData.departures.X20) || [];

    const next = departures.slice(0, 3).map(d => ({
      // A departure counts as "live" only when TransportAPI has an actual
      // real-time estimate that differs from the timetabled time —
      // otherwise it's just the schedule, and we label it as such rather
      // than implying a live GPS fix we don't actually have.
      isLive: !!d.expected_departure_time && d.expected_departure_time !== d.aimed_departure_time,
      display: d.best_departure_estimate || d.aimed_departure_time || d.expected_departure_time,
      scheduledTime: d.aimed_departure_time,
      direction: d.direction || null,
    }));

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ label, atcocode, found: true, departures: next });
  } catch (err) {
    res.status(200).json({ found: false, reason: err.message });
  }
}
