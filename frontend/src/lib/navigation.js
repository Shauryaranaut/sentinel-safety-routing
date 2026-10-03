const toRad = (d) => d * Math.PI / 180
const R = 6371000

export const metersBetween = (a, b) => {
  const p1 = toRad(a[0])
  const p2 = toRad(b[0])
  const dp = p2 - p1
  const dl = toRad(b[1] - a[1])
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

export const bearingDeg = (a, b) => {
  const lat1 = toRad(a[0])
  const lat2 = toRad(b[0])
  const dlon = toRad(b[1] - a[1])
  const y = Math.sin(dlon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dlon)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

const cumulative = (geometry) => {
  const dist = [0]
  for (let i = 1; i < geometry.length; i++) dist.push(dist[i - 1] + metersBetween(geometry[i - 1], geometry[i]))
  return dist
}

const turnFromDelta = (delta) => {
  const mag = Math.abs(delta)
  if (mag < 25) return 'straight'
  if (mag >= 150) return 'uturn'
  const side = delta > 0 ? 'right' : 'left'
  if (mag < 50) return `slight-${side}`
  if (mag > 110) return `sharp-${side}`
  return side
}

const phrase = (maneuver) => {
  const labels = {
    depart: 'Head out',
    straight: 'Continue straight',
    'slight-left': 'Slight left',
    left: 'Turn left',
    'sharp-left': 'Sharp left',
    'slight-right': 'Slight right',
    right: 'Turn right',
    'sharp-right': 'Sharp right',
    uturn: 'Make a U-turn',
    roundabout: 'At the roundabout',
    arrive: 'You have arrived',
  }
  return labels[maneuver] || 'Continue'
}

export const maneuversFromGeometry = (geometry) => {
  if (!geometry || geometry.length < 2) return []
  const steps = [{ instruction: 'Head out', maneuver: 'depart', name: '', index: 0, latitude: geometry[0][0], longitude: geometry[0][1] }]
  let prev = bearingDeg(geometry[0], geometry[1])
  for (let i = 1; i < geometry.length - 1; i++) {
    const next = bearingDeg(geometry[i], geometry[i + 1])
    const delta = ((next - prev + 540) % 360) - 180
    const maneuver = turnFromDelta(delta)
    prev = next
    if (maneuver === 'straight') continue
    steps.push({ instruction: phrase(maneuver), maneuver, name: '', index: i, latitude: geometry[i][0], longitude: geometry[i][1] })
  }
  const last = geometry.length - 1
  steps.push({ instruction: 'You have arrived', maneuver: 'arrive', name: '', index: last, latitude: geometry[last][0], longitude: geometry[last][1] })
  return steps
}

export const snapToRoute = (geometry, position) => {
  if (!geometry || geometry.length < 2 || !position) return null
  const here = [position.latitude, position.longitude]
  let best = null
  let along = 0
  for (let i = 0; i < geometry.length - 1; i++) {
    const a = geometry[i]
    const b = geometry[i + 1]
    const seg = metersBetween(a, b)
    let t = 0
    if (seg > 1) {
      const vx = b[1] - a[1]
      const vy = b[0] - a[0]
      const wx = here[1] - a[1]
      const wy = here[0] - a[0]
      t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy || 1)))
    }
    const point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    const off = metersBetween(here, point)
    if (!best || off < best.offRouteM) {
      best = {
        offRouteM: off,
        along: along + seg * t,
        index: i,
        heading: bearingDeg(a, b),
        latitude: point[0],
        longitude: point[1],
      }
    }
    along += seg
  }
  return best
}

export const formatDistance = (meters) => {
  const m = Math.max(0, Number(meters) || 0)
  if (m < 950) return `${Math.max(10, Math.round(m / 10) * 10)} m`
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`
}

export const navigationCue = ({ geometry, steps, position, progressM = 0, arrived = false }) => {
  if (!geometry || geometry.length < 2) return null
  const cum = cumulative(geometry)
  const total = cum[cum.length - 1]
  const snap = position ? snapToRoute(geometry, position) : null
  const onRoute = snap && snap.offRouteM <= 80
  const along = onRoute ? snap.along : Math.max(0, Math.min(progressM, total))
  const heading = snap?.heading ?? bearingDeg(geometry[0], geometry[1])
  if (arrived || along >= total - 15) {
    return {
      instruction: 'You have arrived',
      maneuver: 'arrive',
      name: '',
      distanceM: 0,
      remainingM: 0,
      heading,
      offRoute: false,
      then: null,
    }
  }
  if (snap && !onRoute) {
    return {
      instruction: 'Rejoin the route',
      maneuver: 'straight',
      name: '',
      distanceM: snap.offRouteM,
      remainingM: Math.max(0, total - along),
      heading,
      offRoute: true,
      then: null,
    }
  }
  const source = (steps && steps.length) ? steps : maneuversFromGeometry(geometry)
  const ahead = source
    .map((step) => ({ ...step, along: cum[Math.max(0, Math.min(step.index || 0, cum.length - 1))] }))
    .filter((step) => step.along >= along + 12)
  const next = ahead[0] || source[source.length - 1]
  const following = ahead[1]
  return {
    instruction: next?.instruction || 'Continue',
    maneuver: next?.maneuver || 'straight',
    name: next?.name || '',
    distanceM: Math.max(0, (next?.along ?? total) - along),
    remainingM: Math.max(0, total - along),
    heading,
    offRoute: false,
    then: following ? { instruction: following.instruction, maneuver: following.maneuver, distanceM: Math.max(0, following.along - along) } : null,
  }
}
