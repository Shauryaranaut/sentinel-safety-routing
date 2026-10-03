import test from 'node:test'
import assert from 'node:assert/strict'
import { maneuversFromGeometry, navigationCue, formatDistance } from './navigation.js'

const northThenEast = [[26.92, 75.80], [26.93, 75.80], [26.93, 75.81]]

test('a north-then-east path includes a right turn', () => {
  const steps = maneuversFromGeometry(northThenEast)
  assert.equal(steps[0].maneuver, 'depart')
  assert.equal(steps.some((step) => step.maneuver === 'right'), true)
  assert.equal(steps.at(-1).maneuver, 'arrive')
})

test('cue reports distance until the next turn', () => {
  const cue = navigationCue({
    geometry: northThenEast,
    position: { latitude: 26.921, longitude: 75.80 },
    progressM: 0,
  })
  assert.equal(cue.offRoute, false)
  assert.equal(cue.maneuver, 'right')
  assert.ok(cue.distanceM > 50)
  assert.match(formatDistance(cue.distanceM), /m|km/)
})

test('a fix far from the line asks to rejoin', () => {
  const cue = navigationCue({
    geometry: northThenEast,
    position: { latitude: 26.95, longitude: 75.85 },
    progressM: 0,
  })
  assert.equal(cue.offRoute, true)
  assert.equal(cue.instruction, 'Rejoin the route')
})
