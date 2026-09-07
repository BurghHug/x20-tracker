// Vercel serverless function: fetches live X20 vehicle positions directly
// from the Bus Open Data Service (BODS) — the UK government's primary
// open-data source for bus location — and combines it with a hand-verified
// scheduled timetable (sourced from bustimes.org and the published
// Warwickshire County Council school-run sheet) for each stop.
//
// BODS's real-time feed (SIRI-VM) only gives raw vehicle position, line,
// and direction — it does NOT include per-stop arrival predictions the way
// TransportAPI's aggregated endpoint did. So rather than fabricate a false
// "X minutes away" from a raw GPS point, this reports what the data
// actually supports: the scheduled time, plus a live "vehicle currently
// N.N miles away" note whenever BODS has a matching bus actively
// reporting. No invented precision.
//
// Requires one environment variable (set in Vercel, never committed):
// BODS_API_KEY. Free account: https://data.bus-data.dft.gov.uk

const { XMLParser } = require('fast-xml-parser');

const API_KEY = process.env.BODS_API_KEY;

// Approximate coordinates for each stop, used only to compute a rough
// distance to any live vehicle spotted — not for turn-by-turn precision.
const STOPS = {
  henleyhs: {
    label: 'Henley High School',
    lat: 52.2953, lon: -1.7746,
    schedule: [{ time: '08:17', direction: 'Arriving (morning drop-off)' },
               { time: '15:30', direction: 'Departing (afternoon pickup)' }],
  },
  bearley: {
    label: 'Bearley, Oak Tree Close',
    lat: 52.2601, lon: -1.7513,
    schedule: [{ time: '08:00', direction: 'towards Henley High School' },
               { time: '15:40', direction: 'towards Stratford' }],
  },
  maybird: {
    label: 'Stratford, Maybird Centre',
    lat: 52.1963, lon: -1.7301,
    // This stop is on the regular hourly commercial X20, not the school
    // working above — its published departures run on the hour.
    schedule: [{ time: 'hourly, on the hour', direction: 'towards Solihull' }],
  },
  woodst: {
    label: 'Stratford, Wood Street',
    lat: 52.1917, lon: -1.7057,
    schedule: [{ time: '07:35', direction: 'towards Henley (morning)' },
               { time: '16:03', direction: 'arriving from Henley (afternoon)' }],
  },
};

function milesBetween(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth radius in miles
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

let cachedVehicles = null;
let cachedAt = 0;

async function fetchLiveX20Vehicles() {
  // Simple in-memory cache (persists across warm invocations only) so a
  // page with 4 stop cards doesn't trigger 4 separate upstream fetches.
  if (cachedVehicles && Date.now() - cachedAt < 20000) return cachedVehicles;

  const url = `https://data.bus-data.dft.gov.uk/api/v1/datafeed/?api_key=${API_KEY}&lineRef=X20`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BODS upstream HTTP ${res.status}`);
  const xml = await res.text();

  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);

  const delivery = parsed?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery;
  let activities = delivery?.VehicleActivity || [];
  if (!Array.isArray(activities)) activities = activities ? [activities] : [];

  const vehicles = activities
    .map(a => a.MonitoredVehicleJourney)
    .filter(Boolean)
    .filter(mvj => String(mvj.LineRef).trim() === 'X20')
    .map(mvj => ({
      lat: parseFloat(mvj.VehicleLocation?.Latitude),
      lon: parseFloat(mvj.VehicleLocation?.Longitude),
      destination: mvj.DestinationName || null,
      recordedAt: mvj.OriginAimedDepartureTime || null,
    }))
    .filter(v => Number.isFinite(v.lat) && Number.isFinite(v.lon))
    // crude geographic sanity check — discards anything wildly outside the
    // Stratford/Henley/Warwick area, in case another region reuses "X20"
    .filter(v => v.lat > 51.9 && v.lat < 52.6 && v.lon > -2.2 && v.lon < -1.2);

  cachedVehicles = vehicles;
  cachedAt = Date.now();
  return vehicles;
}

export default async function handler(req, res) {
  if (!API_KEY) {
    res.status(500).json({ error: 'BODS_API_KEY is not configured on the server.' });
    return;
  }

  const { stop } = req.query;
  const stopInfo = STOPS[stop];
  if (!stopInfo) {
    res.status(400).json({ error: 'Unknown stop id.' });
    return;
  }

  try {
    const vehicles = await fetchLiveX20Vehicles();

    let nearest = null;
    for (const v of vehicles) {
      const dist = milesBetween(stopInfo.lat, stopInfo.lon, v.lat, v.lon);
      if (!nearest || dist < nearest.dist) nearest = { ...v, dist };
    }
    // Beyond ~15 miles the vehicle is almost certainly not meaningfully
    // "approaching" this specific stop — the whole route is only about
    // 12 miles end to end — so don't present it as a live match.
    if (nearest && nearest.dist > 15) nearest = null;

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      found: true,
      label: stopInfo.label,
      schedule: stopInfo.schedule,
      live: nearest ? {
        milesAway: Math.round(nearest.dist * 10) / 10,
        destination: nearest.destination,
      } : null,
      vehiclesActive: vehicles.length,
    });
  } catch (err) {
    res.status(200).json({ found: false, label: stopInfo.label, schedule: stopInfo.schedule, reason: err.message });
  }
}
