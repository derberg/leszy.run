import { useMemo } from 'react'
import { useResultsSnapshot } from './useResultsSnapshot.js'
import { categoryView } from '../lib/resultsSnapshot.js'

/**
 * One category's latest started run, its results, its public checkpoints and the
 * observations at them, from the event's results snapshot. Shared by the category
 * section and the bib finder so both read the same rows the same way.
 *
 * @returns {{ category, raceRun, results, checkpoints, observations, loaded }}
 */
export function useCategoryResults(eventId, categoryId) {
  const snapshot = useResultsSnapshot(eventId)
  return useMemo(() => categoryView(snapshot, categoryId), [snapshot, categoryId])
}
